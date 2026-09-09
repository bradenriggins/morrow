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
import { planBrowserReadback } from "../../connector/extension/generated/canvas-readback-plan.js";

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

// Every Item Bank change is proved by the Item Banks frame's own reread, in
// connector/extension/src/item-bank-executor.js and
// connector/extension/src/quiz-bank-draw-executor.js. The private /api/banks
// surface answers only inside that frame, so no readback Morrow runs outside it
// could reach the changed object. The service worker therefore never asks the
// generic planner about an Item Bank operation, and no Item Bank write has a
// named Canvas readback either.
test("no Item Bank change takes a Canvas readback route outside its own frame", () => {
  const writes = catalog.operations.filter((operation) => operation.service === "item_bank" && !operation.readOnly);
  assert.equal(writes.length, 11);
  for (const write of writes) {
    assert.equal(isCanvasOperationReadback(write), false, write.toolName);
    assert.equal(planCanvasOperationReadback(catalog.operations, write, { course_id: "42", bank_id: "901" }, { id: "801" }), null, write.toolName);
  }
  // The one line that keeps the generic planner out. If it is removed, a plan
  // that cannot reach the private bank surface would start deciding whether an
  // Item Bank change is verified.
  const worker = readFileSync(new URL("../../connector/extension/src/service-worker.js", import.meta.url), "utf8");
  assert.match(worker, /const guardedItemBank = operation\.service === "item_bank";/);
  const selection = worker.slice(worker.indexOf("const plan = guardedCanvasContent"), worker.indexOf("planBrowserReadback(", worker.indexOf("const plan = guardedCanvasContent")));
  assert.match(selection, /guardedItemBank/, "the readback selection no longer excludes Item Bank operations");
  assert.match(selection, /\?\s*null\s*:\s*$/, "the excluded branch no longer resolves to no plan");
});
