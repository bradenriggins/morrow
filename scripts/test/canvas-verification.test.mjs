import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { canvasAdmissionReason, canvasExecutorOwnedReadback, canvasOperationAdmission, canvasReadbackAssessment } from "../../connector/extension/generated/canvas-operation-admission.js";
import { evaluateBrowserReadback, planBrowserReadback, planCanvasRecoveryDescriptor } from "../../connector/extension/src/verification.js";

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

test("created Canvas pages use their page identity and retain exact content checks", () => {
  const page = { page_id: "91", url: "cell-structures", title: "Cell structures", body: "<p>Ribosomes assemble proteins.</p>", published: false, last_edited_by: { id: "7" } };
  const plan = verify("canvas_create_page_courses", {
    course_id: "42", wiki_page_title: page.title, wiki_page_body: page.body, wiki_page_published: false, wiki_page_notify_of_update: false,
  }, page, { ok: true, status: 200, data: page }, "canvas_show_page_courses");
  assert.deepEqual(plan.arguments, { course_id: "42", url_or_id: "cell-structures" });
  assert.equal(plan.targetField, "page_id");
  assert.equal(evaluateBrowserReadback(plan, { ok: true, status: 200, data: { ...page, body: "<p>Different content.</p>" } }).status, "mismatch");
});

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

test("custom gradebook column update and deletion read complete course columns", () => {
  const updated = {
    id: "7",
    title: "Participation",
    position: 3,
    hidden: true,
    teacher_notes: true,
    read_only: false,
  };
  const update = verify(
    "canvas_update_custom_gradebook_column",
    {
      course_id: "42",
      id: "7",
      column_title: updated.title,
      column_position: String(updated.position),
      column_hidden: updated.hidden,
      column_teacher_notes: updated.teacher_notes,
      column_read_only: updated.read_only,
    },
    updated,
    { ok: true, status: 200, data: [updated] },
    "canvas_list_custom_gradebook_columns",
  );
  assert.deepEqual(update.arguments, { course_id: "42", include_hidden: "true" });
  assert.equal(update.strategy, "collection-contains-target");
  assert.equal(update.targetId, "7");
  assert.equal(update.targetField, "id");
  assert.equal(evaluateBrowserReadback(update, {
    ok: true,
    status: 200,
    data: [{ ...updated, title: "Old title" }],
  }).status, "mismatch");
  assert.equal(evaluateBrowserReadback(update, {
    ok: true,
    status: 200,
    data: [updated],
    truncated: true,
  }).status, "unconfirmed");

  const deletion = planBrowserReadback(catalog.operations, operation("canvas_delete_custom_gradebook_column"), {
    course_id: "42",
    id: "7",
  }, null);
  assert.ok(deletion);
  assert.deepEqual(deletion.arguments, { course_id: "42", include_hidden: "true" });
  assert.equal(deletion.strategy, "collection-omits-target");
  assert.equal(evaluateBrowserReadback(deletion, { ok: true, status: 200, data: [] }).status, "verified");
  assert.equal(evaluateBrowserReadback(deletion, { ok: true, status: 200, data: [updated] }).status, "mismatch");
  assert.equal(evaluateBrowserReadback(deletion, {
    ok: true,
    status: 200,
    data: [],
    truncated: true,
  }).status, "unconfirmed");
});

test("safe Canvas state writes use bounded exact readbacks", () => {
  const cases = [
    {
      tool: "canvas_delete_external_feed_courses",
      args: { course_id: "42", external_feed_id: "7" },
      readTool: "canvas_list_external_feeds_courses",
      expectedArguments: { course_id: "42" },
      read: { ok: true, status: 200, data: [] },
      incomplete: { ok: true, status: 200, data: [], truncated: true },
    },
    {
      tool: "canvas_mark_document_annotations_as_read_courses",
      args: { course_id: "42", assignment_id: "77", user_id: "88" },
      readTool: "canvas_get_document_annotations_read_state_courses",
      expectedArguments: { course_id: "42", assignment_id: "77", user_id: "88" },
      read: { ok: true, status: 200, data: { read: true } },
      mismatch: { ok: true, status: 200, data: { read: false } },
    },
    {
      tool: "canvas_mark_rubric_assessments_as_read_courses_rubric_assessments",
      args: { course_id: "42", assignment_id: "77", user_id: "88" },
      readTool: "canvas_get_rubric_assessments_read_state_courses_rubric_assessments",
      expectedArguments: { course_id: "42", assignment_id: "77", user_id: "88" },
      read: { ok: true, status: 200, data: { read: true } },
      mismatch: { ok: true, status: 200, data: { read: false } },
    },
    {
      tool: "canvas_mark_rubric_assessments_as_read_courses_rubric_comments",
      args: { course_id: "42", assignment_id: "77", user_id: "88" },
      readTool: "canvas_get_rubric_assessments_read_state_courses_rubric_comments",
      expectedArguments: { course_id: "42", assignment_id: "77", user_id: "88" },
      read: { ok: true, status: 200, data: { read: true } },
      mismatch: { ok: true, status: 200, data: { read: false } },
    },
    {
      tool: "canvas_unlink_outcome_courses",
      args: { course_id: "42", id: "7", outcome_id: "9" },
      readTool: "canvas_list_linked_outcomes_courses",
      expectedArguments: { course_id: "42", id: "7" },
      read: { ok: true, status: 200, data: [] },
      incomplete: { ok: true, status: 200, data: [], truncated: true },
    },
  ];

  for (const entry of cases) {
    const plan = verify(entry.tool, entry.args, entry.writeData || null, entry.read, entry.readTool);
    assert.deepEqual(plan.arguments, entry.expectedArguments);
    if (entry.mismatch) assert.equal(evaluateBrowserReadback(plan, entry.mismatch).status, "mismatch");
    if (entry.incomplete) assert.equal(evaluateBrowserReadback(plan, entry.incomplete).status, "unconfirmed");
  }

  // Deleting a rubric association has no read of its own; reading the rubric reports a different
  // resource, so no plan is produced. See scripts/test/canvas-readback-scope.test.mjs.
  assert.equal(planBrowserReadback(catalog.operations, operation("canvas_delete_rubricassociation"), {
    course_id: "42",
    id: "7",
  }, { rubric_id: "7" }), null);
});

test("lossy, broad, private, and stateful Canvas readers do not run as readback", () => {
  const blocked = [
    "canvas_add_course_to_favorites",
    "canvas_bulk_select_provisional_grades",
    "canvas_clear_unread_status_for_all_submissions_courses",
    "canvas_delete_entry_courses",
    "canvas_delete_feedback_on_conversation_message",
    "canvas_delete_single_rubric_assessment",
    "canvas_delete_submission_comment",
    "canvas_disable_summary_courses",
    "canvas_edit_external_tool_courses",
    "canvas_mark_all_topic_as_read_courses",
    "canvas_mark_module_item_as_done_not_done",
    "canvas_mark_submission_as_read_courses",
    "canvas_mark_submission_as_unread_courses",
    "canvas_mark_submission_item_as_read_courses",
    "canvas_mark_topic_as_read_courses",
    "canvas_mark_topic_as_unread_courses",
    "canvas_re_lock_module_progressions",
    "canvas_remove_course_from_favorites",
    "canvas_reset_what_if_scores_for_current_user_for_entire_course_and_recalculate_grades",
    "canvas_select_provisional_grade",
    "canvas_subscribe_to_topic_courses",
    "canvas_unsubscribe_from_topic_courses",
    "canvas_update_content_migration_courses",
  ];

  for (const tool of blocked) {
    const write = operation(tool);
    const args = Object.fromEntries(write.parameters.filter((parameter) => parameter.location === "path").map((parameter) => [parameter.inputName, "1"]));
    assert.equal(planBrowserReadback(catalog.operations, write, args, {}), null, tool);
  }
});

test("self-scoped Canvas bookmark and course-nickname writes are held before any readback", () => {
  const selfScoped = [
    "canvas_create_bookmark",
    "canvas_update_bookmark",
    "canvas_delete_bookmark",
    "canvas_set_course_nickname",
    "canvas_remove_course_nickname",
    "canvas_clear_course_nicknames",
  ];
  for (const tool of selfScoped) {
    const write = operation(tool);
    const admission = canvasOperationAdmission(write);
    assert.equal(admission.courseTarget.kind, "self_path", tool);
    assert.deepEqual(admission.write, { state: "held", reason: "self_scope_not_supported" }, tool);
    assert.equal(
      canvasAdmissionReason(admission.write),
      "Morrow does not change your personal Canvas bookmarks or course nicknames. It only changes content inside a selected course.",
      tool,
    );
    assert.deepEqual(
      canvasReadbackAssessment(catalog.operations, write),
      { state: "not_applicable", reason: "write_held" },
      tool,
    );
  }
});

test("the single course-nickname read stays bound to one course", () => {
  const read = operation("canvas_get_course_nickname");
  assert.equal(read.readOnly, true);
  assert.deepEqual(canvasOperationAdmission(read).courseTarget, {
    kind: "self_path",
    resource: "course_nickname",
    argument: "course_id",
  });
});

// Every Item Bank change is available, and every one of them is proved by the
// Item Banks frame's own operation-specific reread in
// connector/extension/src/item-bank-executor.js and
// connector/extension/src/quiz-bank-draw-executor.js. The generic Canvas
// planner cannot reach the private bank surface, so it owns neither the
// readback nor the recovery descriptor for these changes.
const QUIZ_DRAW_NICKNAMES = ["attach_bank_to_quiz", "attach_bank_entry_to_quiz", "delete_quiz_bank_entry"];

test("every Item Bank change is admitted with an executor-owned exact readback", () => {
  const writes = catalog.operations.filter((candidate) => candidate.service === "item_bank" && !candidate.readOnly);
  assert.equal(writes.length, 11);
  for (const write of writes) {
    assert.equal(canvasOperationAdmission(write).write.state, "admitted", write.toolName);
    assert.deepEqual(canvasOperationAdmission(write).courseTarget, { kind: "course_path", argument: "course_id" }, write.toolName);
    assert.deepEqual(canvasReadbackAssessment(catalog.operations, write), { state: "structurally_exact" }, write.toolName);
    assert.equal(planCanvasRecoveryDescriptor(catalog.operations, write, {}, {}), null, write.toolName);
  }
});

/**
 * The third readback state, held to evidence. A write in this tier has an exact
 * readback that belongs to a reviewed executor rather than to the generic
 * planner, and the product uses the executor's. That is only true because the
 * executor really performs the reread, so this test walks every operation the
 * contract names and finds it in the executor that owns it. A future admitted
 * write cannot land in this tier by accident and dispatch with nothing
 * checking it. Which routes the planner would also produce for these
 * operations, and why the service worker drops them, is pinned separately in
 * scripts/test/canvas-readback-scope.test.mjs.
 */
test("every executor-owned readback is a reread the owning executor really performs", () => {
  const source = (path) => readFileSync(new URL(`../../connector/extension/src/${path}`, import.meta.url), "utf8");
  const itemBankExecutor = source("item-bank-executor.js");
  const quizBankExecutor = source("quiz-bank-draw-executor.js");
  const worker = source("service-worker.js");
  const owned = catalog.operations.filter((operation) => canvasExecutorOwnedReadback(operation));
  assert.ok(owned.length > 0);
  for (const operation of owned) {
    // The contract may only name a write, and only one Morrow admits.
    assert.equal(operation.readOnly, false, operation.toolName);
    assert.equal(canvasOperationAdmission(operation).write.state, "admitted", operation.toolName);
    assert.deepEqual(canvasReadbackAssessment(catalog.operations, operation), { state: "structurally_exact" }, operation.toolName);
    if (operation.service === "item_bank") {
      const executor = QUIZ_DRAW_NICKNAMES.includes(operation.nickname) ? quizBankExecutor : itemBankExecutor;
      assert.ok(executor.includes(`operation.nickname === "${operation.nickname}"`), `${operation.toolName} has no readback branch in its executor`);
      continue;
    }
    assert.ok(worker.includes(`"${operation.toolName}"`), `${operation.toolName} is not bound to a response evaluator in the service worker`);
  }
  // An Item Bank shape nobody wrote a reread for reports an unknown outcome, so
  // a new nickname cannot inherit another shape's proof.
  assert.match(itemBankExecutor, /verification = unconfirmed\("item_bank_readback_contract_missing"\)/);
  // And the tier is not open-ended: a Canvas write outside these two families
  // is judged by the planner like every other one.
  const editAssignment = catalog.operations.find((operation) => operation.toolName === "canvas_edit_assignment");
  assert.equal(canvasExecutorOwnedReadback(editAssignment), false);
  assert.ok(planBrowserReadback(catalog.operations, editAssignment, { course_id: "42", id: "7" }, { id: "7" }));
});

/**
 * The duplicate stays held, and the sentence it shows names the provider fact
 * that actually blocks it. Checked against the Canvas Assignment resource on
 * 8 September 2026:
 * https://developerdocs.instructure.com/services/canvas/resources/assignments
 *
 * The response shape is NOT the problem, and the reason must never say it is.
 * `result_type` has one allowed value, `Quiz`; with the argument omitted "the
 * response will be serialized into an assignment format" and the route
 * "Returns an Assignment object". Two things do block it. Canvas documents no
 * field on the copy that names it a New Quiz: the Assignment object documents
 * `is_quiz_assignment`, whose name and description disagree with each other,
 * and documents no `is_quiz_lti_assignment` at all. And Canvas documents no
 * signal that the copy has finished: `workflow_state` is documented only as
 * "String indicating what state this assignment is in", with `unpublished` as
 * its one example value. A reread taken straight after the request could
 * therefore describe a half-made copy, and Morrow would call it verified.
 */
test("the assignment duplicate stays held for the provider fact that blocks it", () => {
  const duplicate = catalog.operations.find((operation) => operation.path === "/v1/courses/{course_id}/assignments/{assignment_id}/duplicate");
  assert.ok(duplicate);
  const admission = canvasOperationAdmission(duplicate).write;
  assert.deepEqual(admission, { state: "held", reason: "duplicate_assignment_exact_readback_unavailable" });
  const reason = canvasAdmissionReason(admission);
  assert.match(reason, /does not say when a duplicated assignment has finished copying/);
  assert.match(reason, /no documented field that names it as a New Quiz/);
  // The retired belief. Canvas does document one response shape for the request
  // Morrow would send, so this must not come back as the stated reason.
  assert.doesNotMatch(reason, /different record types/);
});

test("readback proof binds to the exact declared target record", () => {
  const page = { page_id: "91", url: "cell-structures", title: "Cell structures", body: "<p>Ribosomes assemble proteins.</p>", published: false };
  const created = planBrowserReadback(catalog.operations, operation("canvas_create_page_courses"), {
    course_id: "42", wiki_page_title: page.title, wiki_page_body: page.body, wiki_page_published: false, wiki_page_notify_of_update: false,
  }, page);
  const nestedTitle = evaluateBrowserReadback(created, {
    ok: true,
    status: 200,
    data: { ...page, title: "Untitled page", lock_info: { context_module: { title: "Cell structures" } } },
  });
  assert.equal(nestedTitle.status, "mismatch");
  assert.equal(nestedTitle.evidence, "requested_field_mismatch:wiki_page_title");

  const column = planBrowserReadback(catalog.operations, operation("canvas_update_custom_gradebook_column"), {
    course_id: "42", id: "7", column_title: "Participation",
  }, { id: "7" });
  const ambiguous = evaluateBrowserReadback(column, {
    ok: true,
    status: 200,
    data: [{ id: "7", title: "Old title" }, { id: "7", title: "Participation" }],
  });
  assert.equal(ambiguous.status, "mismatch");
  assert.equal(ambiguous.evidence, "target_ambiguous_in_readback");
  assert.equal(evaluateBrowserReadback(column, { ok: true, status: 200, data: [{ id: "7", title: "Participation" }] }).status, "verified");
  assert.equal(evaluateBrowserReadback(column, { ok: true, status: 200, data: [{ id: "9", title: "Participation" }] }).evidence, "target_missing_from_readback");

  const unlink = planBrowserReadback(catalog.operations, operation("canvas_unlink_outcome_courses"), {
    course_id: "42", id: "7", outcome_id: "9",
  }, null);
  const outcomeLinks = evaluateBrowserReadback(unlink, {
    ok: true,
    status: 200,
    data: [{ url: "/api/v1/courses/42/outcome_groups/7/outcomes/9", outcome: { id: "9", title: "Analyse evidence" }, can_unlink: true }],
  });
  assert.equal(outcomeLinks.status, "unconfirmed");
  assert.equal(outcomeLinks.evidence, "readback_records_lack_target_field");

  const declaredPath = {
    strategy: "collection-contains-target",
    targetId: "7",
    targetField: "id",
    targetPath: ["associations"],
    readOperation: { toolName: "canvas_get_single_rubric_courses" },
    assertions: [{ inputName: "association_title", paths: [["title"]], expected: "Weekly rubric" }],
  };
  assert.equal(evaluateBrowserReadback(declaredPath, {
    ok: true,
    status: 200,
    data: { id: "5", title: "Weekly rubric", associations: [{ id: "7", title: "Old title" }] },
  }).status, "mismatch");
  assert.equal(evaluateBrowserReadback(declaredPath, {
    ok: true,
    status: 200,
    data: { id: "5", title: "Old title", associations: [{ id: "7", title: "Weekly rubric" }] },
  }).status, "verified");
});

test("readback comparison refuses coerced values", () => {
  const position = planBrowserReadback(catalog.operations, operation("canvas_update_custom_gradebook_column"), {
    course_id: "42", id: "7", column_position: 0,
  }, { id: "7" });
  assert.equal(evaluateBrowserReadback(position, { ok: true, status: 200, data: [{ id: "7", position: "" }] }).status, "mismatch");
  assert.equal(evaluateBrowserReadback(position, { ok: true, status: 200, data: [{ id: "7", position: "   " }] }).status, "mismatch");
  assert.equal(evaluateBrowserReadback(position, { ok: true, status: 200, data: [{ id: "7", position: 0 }] }).status, "verified");
  assert.equal(evaluateBrowserReadback(position, { ok: true, status: 200, data: [{ id: "7", position: "0" }] }).status, "verified");

  const title = planBrowserReadback(catalog.operations, operation("canvas_update_custom_gradebook_column"), {
    course_id: "42", id: "7", column_title: "42",
  }, { id: "7" });
  assert.equal(evaluateBrowserReadback(title, { ok: true, status: 200, data: [{ id: "7", title: "2042-01-01T00:00:00Z" }] }).status, "mismatch");
  assert.equal(evaluateBrowserReadback(title, { ok: true, status: 200, data: [{ id: "7", title: "42" }] }).status, "verified");

  const due = planBrowserReadback(catalog.operations, operation("canvas_edit_assignment"), {
    course_id: "42", id: "188", assignment_due_at: "2026-10-02T17:00:00Z",
  }, null);
  assert.equal(evaluateBrowserReadback(due, { ok: true, status: 200, data: { id: "188", due_at: "Fri Oct 02 2026 17:00:00 GMT+0000" } }).status, "mismatch");
  assert.equal(evaluateBrowserReadback(due, { ok: true, status: 200, data: { id: "188", due_at: "2026-10-02T17:00:00.000Z" } }).status, "verified");
});
