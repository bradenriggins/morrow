import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  canvasBulkAssignmentDatesBody,
  evaluateCanvasOperationProgress,
  evaluateCanvasOperationReadback,
  isCanvasOperationReadback,
  planCanvasOperationReadback,
} from "../../connector/extension/src/canvas-operation-readback.js";
import { evaluateBrowserReadback, planBrowserReadback } from "../../connector/extension/generated/canvas-readback-plan.js";

const catalog = JSON.parse(readFileSync(new URL("../../artifacts/canvas-api/canvas-api-catalog.json", import.meta.url), "utf8"));
const catalogOperation = (name) => {
  const value = catalog.operations.find((candidate) => candidate.toolName === name);
  assert.ok(value, `missing catalog operation ${name}`);
  return value;
};

const bulkWrite = {
  toolName: "canvas_bulk_update_assignment_dates",
  key: "PUT /v1/courses/{course_id}/assignments/bulk_update#bulk_update_assignment_dates",
  readOnly: false,
};
const reactivateWrite = {
  toolName: "canvas_re_activate_enrollment",
  key: "PUT /v1/courses/{course_id}/enrollments/{id}/reactivate#re_activate_enrollment",
  readOnly: false,
};
const operations = [
  { toolName: "canvas_list_assignments_assignments", key: "GET /v1/courses/{course_id}/assignments#list_assignments_assignments", readOnly: true },
  { toolName: "canvas_query_progress_v1_progress_id_get", key: "GET /v1/progress/{id}#query_progress", readOnly: true },
  { toolName: "canvas_list_enrollments_courses", key: "GET /v1/courses/{course_id}/enrollments#list_enrollments_courses", readOnly: true },
];

const dates = [{
  id: "88",
  all_dates: [
    { base: true, due_at: "2026-10-01T17:00:00Z", unlock_at: null },
    { id: "9", due_at: "2026-10-02T12:00:00-05:00", lock_at: "2026-10-04T12:00:00-05:00" },
  ],
}, {
  id: "89",
  all_dates: [{ base: true, due_at: "2026-10-03T17:00:00Z" }],
}];

test("plans bulk assignment dates from the documented raw array and requires a completed Progress result", () => {
  const plan = planCanvasOperationReadback(operations, bulkWrite, { course_id: "42", assignment_dates: dates }, { id: "77" });
  assert.deepEqual(plan?.arguments, {
    course_id: "42",
    assignment_ids: ["88", "89"],
    include: ["all_dates"],
    morrow_max_pages: 50,
  });
  assert.equal(plan?.strategy, "canvas-bulk-assignment-dates");
  assert.equal(plan?.progressArguments.id, "77");
  assert.deepEqual(evaluateCanvasOperationProgress(plan, { ok: true, data: { workflow_state: "queued" } }), {
    settled: false,
    verification: {
      schema: "morrow.browser-verification.v1",
      status: "unconfirmed",
      strategy: "canvas-bulk-assignment-dates",
      readTool: "canvas_query_progress_v1_progress_id_get",
      evidence: "background_progress_unsettled",
    },
  });
  assert.deepEqual(evaluateCanvasOperationProgress(plan, { ok: true, data: { workflow_state: "completed" } }), { settled: true });
});

test("verifies every requested bulk date and refuses a partial or mismatched result", () => {
  const plan = planCanvasOperationReadback(operations, bulkWrite, { course_id: "42", assignment_dates: dates }, { id: "77" });
  const complete = {
    ok: true,
    truncated: false,
    data: [
      { id: "88", course_id: "42", all_dates: [
        { base: true, due_at: "2026-10-01T12:00:00-05:00", unlock_at: null },
        { id: "9", due_at: "2026-10-02T17:00:00Z", lock_at: "2026-10-04T17:00:00Z" },
      ] },
      { id: "89", course_id: "42", all_dates: [{ base: true, due_at: "2026-10-03T17:00:00Z" }] },
    ],
  };
  assert.equal(evaluateCanvasOperationReadback(plan, complete)?.status, "verified");
  assert.equal(evaluateCanvasOperationReadback(plan, { ...complete, truncated: true })?.evidence, "collection_readback_incomplete");
  assert.equal(evaluateCanvasOperationReadback(plan, { ...complete, data: complete.data.slice(0, 1) })?.evidence, "requested_assignment_missing_or_ambiguous");
  const mismatch = structuredClone(complete);
  mismatch.data[0].all_dates[1].lock_at = "2026-10-05T17:00:00Z";
  assert.equal(evaluateCanvasOperationReadback(plan, mismatch)?.evidence, "assignment_date_mismatch:lock_at");
});

test("refuses ambiguous bulk targets before a write body can be selected", () => {
  const invalid = [{ id: "88", all_dates: [{ base: true, due_at: "2026-10-01T17:00:00Z" }] }, { id: "88", all_dates: [{ base: true, due_at: "2026-10-02T17:00:00Z" }] }];
  assert.equal(planCanvasOperationReadback(operations, bulkWrite, { course_id: "42", assignment_dates: invalid }, { id: "77" }), null);
  assert.equal(canvasBulkAssignmentDatesBody(bulkWrite, { course_id: "42", assignment_dates: invalid }), null);
  assert.deepEqual(canvasBulkAssignmentDatesBody(bulkWrite, { course_id: "42", assignment_dates: dates }), dates);
});

test("refuses a bulk body with no date field, an invalid instant, or duplicate selectors before send", () => {
  for (const assignment_dates of [
    [{ id: "88", all_dates: [{ base: true }] }],
    [{ id: "88", all_dates: [{ base: true, due_at: "not-a-date" }] }],
    [{ id: "88", all_dates: [{ base: true, due_at: "2026-10-01T17:00:00Z" }, { base: true, lock_at: "2026-10-02T17:00:00Z" }] }],
  ]) {
    assert.equal(planCanvasOperationReadback(operations, bulkWrite, { course_id: "42", assignment_dates }, { id: "77" }), null);
    assert.equal(canvasBulkAssignmentDatesBody(bulkWrite, { course_id: "42", assignment_dates }), null);
  }
});

test("binds enrollment reactivation readback to the exact course, enrollment, and response subject", () => {
  const plan = planCanvasOperationReadback(operations, reactivateWrite, { course_id: "42", id: "51" }, { id: "51", course_id: "42", user_id: "99" });
  assert.deepEqual(plan?.arguments, { course_id: "42", user_id: "99", state: ["active"], morrow_max_pages: 50 });
  assert.equal(plan?.strategy, "canvas-enrollment-reactivation");
  const verified = evaluateCanvasOperationReadback(plan, {
    ok: true,
    truncated: false,
    data: [{ id: "51", course_id: "42", user_id: "99", enrollment_state: "active" }],
  });
  assert.equal(verified?.status, "verified");
  assert.equal(evaluateCanvasOperationReadback(plan, {
    ok: true,
    truncated: false,
    data: [{ id: "51", course_id: "42", user_id: "100", enrollment_state: "active" }],
  })?.evidence, "enrollment_subject_or_course_mismatch");
  assert.equal(evaluateCanvasOperationReadback(plan, {
    ok: true,
    truncated: false,
    data: [{ id: "51", course_id: "42", user_id: "99", enrollment_state: "inactive" }],
  })?.evidence, "enrollment_not_active");
});

test("refuses reactivation when the write response cannot bind the same enrollment and subject", () => {
  assert.equal(planCanvasOperationReadback(operations, reactivateWrite, { course_id: "42", id: "51" }, { id: "52", course_id: "42", user_id: "99" }), null);
  assert.equal(isCanvasOperationReadback(bulkWrite), true);
  assert.equal(isCanvasOperationReadback(reactivateWrite), true);
  assert.equal(isCanvasOperationReadback(operations[0]), false);
});

// The extension carries a generated copy of the shared planner. These cases hold that copy to the
// same Item Bank contract the package tests hold the source to.
test("the generated planner reads the exact Item Bank item after an item write", () => {
  const item = { entry: { item_body: "<p>Which vessel carries oxygenated blood?</p>" } };
  const saved = { id: "502", entry: { item_body: "<p>Which vessel carries oxygenated blood?</p>", position: 3 } };

  const update = planBrowserReadback(catalog.operations, catalogOperation("canvas_item_bank_update_item"), {
    bank_id: "901",
    item_id: "502",
    item,
  }, { id: "502" });
  assert.equal(update.readOperation.toolName, "canvas_item_bank_get_item");
  assert.equal(update.strategy, "updated-resource");
  assert.deepEqual(update.arguments, { bank_id: "901", item_id: "502" });
  assert.equal(update.targetId, undefined);
  assert.equal(evaluateBrowserReadback(update, { ok: true, status: 200, data: saved }).status, "verified");
  assert.equal(evaluateBrowserReadback(update, {
    ok: true,
    status: 200,
    data: { id: "502", entry: { item_body: "<p>Unchanged.</p>" } },
  }).status, "mismatch");
  assert.equal(evaluateBrowserReadback(update, { ok: false, status: 503 }).status, "unconfirmed");

  const create = planBrowserReadback(catalog.operations, catalogOperation("canvas_item_bank_create_item"), {
    bank_id: "901",
    item,
  }, { id: "502" });
  assert.equal(create.readOperation.toolName, "canvas_item_bank_get_item");
  assert.equal(create.strategy, "created-resource");
  assert.deepEqual(create.arguments, { bank_id: "901", item_id: "502" });
  assert.equal(create.targetId, "502");
  assert.equal(create.targetField, "id");
  assert.equal(evaluateBrowserReadback(create, { ok: true, status: 200, data: saved }).status, "verified");
  // A created item is not a bank entry until attach_item runs, so the create response id is the only
  // identity the readback can address. Without it there is no plan and the write stays unconfirmed.
  assert.equal(planBrowserReadback(catalog.operations, catalogOperation("canvas_item_bank_create_item"), { bank_id: "901", item }, {}), null);
});

test("the generated planner keeps the Item Bank entry list for entry writes only", () => {
  const planned = catalog.operations
    .filter((operation) => operation.service === "item_bank" && !operation.readOnly)
    .map((operation) => [operation.nickname, planBrowserReadback(catalog.operations, operation, {
      bank_id: "901",
      item_id: "502",
      bank_entry_id: "701",
      entity_type: "course",
      entity_id: "42",
      title: "Cardiovascular anatomy",
    }, { id: "801" })?.readOperation.nickname]);
  assert.deepEqual(Object.fromEntries(planned), {
    create_bank: "get_bank",
    archive_bank: "get_bank",
    attach_item: "list_entries",
    create_item: "get_item",
    update_item: "get_item",
    delete_entry: "get_entry",
    share_bank: "list_shares",
  });
});
