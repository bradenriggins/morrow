import assert from "node:assert/strict";
import test from "node:test";
import { extraRunners } from "../lib/tool-runners-extra.mjs";
import { disposablePlan, makeDisposables, removeDisposables } from "../lib/disposables.mjs";
import {
  absenceOf,
  addressPoolForWrite,
  classificationFromPass,
  classifyWriteEvidence,
  evidenceProvesWrite,
  judgeCourseComparison,
  judgePrivacyScenario,
  judgeQuizAuthoring,
  judgeStaleSnapshot,
  judgeUndoScenario,
  operationIsProven,
  outcomeFromChangePlan,
  preexistingTarget,
  rowByIdentity,
} from "../lib/proof-rules.mjs";
import { runCompareScenario, runPrivacyScenario, runQuizScenario, runUndoScenario } from "../scenarios/cases.mjs";

const waiting = "Morrow prepared this change and is waiting for approval. Ask your assistant to check the existing request.";

test("a verified status with no readback is not PASS, and waiting is not PROVEN", () => {
  const waitingVerified = classifyWriteEvidence({ state: "verified", detail: waiting });
  assert.equal(waitingVerified.verdict, "BLOCKED");
  assert.notEqual(waitingVerified.verdict, "PASS");

  const verifiedReadbackStillWaiting = classifyWriteEvidence({
    state: "verified",
    verification: "verified",
    detail: waiting,
  });
  assert.equal(verifiedReadbackStillWaiting.verdict, "BLOCKED");

  const noReadback = classifyWriteEvidence({ state: "verified" });
  assert.equal(noReadback.verdict, "BLOCKED");

  const explicit = classifyWriteEvidence({ state: "verified", verification: "verified" });
  assert.equal(explicit.verdict, "PASS");

  const showsChange = classifyWriteEvidence({ state: "verified", readback: { showsChange: true } });
  assert.equal(showsChange.verdict, "PASS");

  const mismatch = classifyWriteEvidence({ state: "verified", verification: "mismatch" });
  assert.equal(mismatch.verdict, "FAIL");

  const stored = {
    kind: "write",
    verdict: "PASS",
    state: "verified",
    detail: waiting,
  };
  assert.equal(evidenceProvesWrite(stored), false);
  assert.equal(classificationFromPass(stored).classification, "QUEUE-COLLISION");
  assert.notEqual(classificationFromPass(stored).proof, "PROVEN");
  assert.equal(operationIsProven({ classification: "PROVEN" }, stored), false);
  assert.equal(outcomeFromChangePlan({ status: "verified", verification: { status: "verified" } }, waiting).outcome, "awaiting_approval");
  assert.equal(outcomeFromChangePlan({ status: "verified" }, "saved").outcome, "sent_unchecked");
  assert.equal(outcomeFromChangePlan({ status: "verified", verification: { status: "verified" } }, "saved").outcome, "verified");
});

test("two submissions and one token fail, and a failed read is not tokenized", async () => {
  const partial = judgePrivacyScenario({
    submissions: { ok: true, data: [{ learnerToken: "Student A1" }, { score: 10 }] },
  });
  assert.equal(partial.verdict, "FAIL");
  assert.equal(partial.privacy.tokenized, false);
  assert.equal(partial.readback.tokenizedIdentities, 1);
  assert.equal(partial.readback.submissions, 2);

  const failed = judgePrivacyScenario({ submissions: { ok: false, code: "upstream_error", data: null } });
  assert.notEqual(failed.verdict, "PASS");
  assert.equal(failed.privacy.tokenized, false);

  const ran = await runPrivacyScenario({
    courseId: "89585",
    read: async (name) => name === "canvas_list_assignments_assignments"
      ? { ok: true, data: [{ id: "1", name: "Quiz" }] }
      : { ok: true, data: [{ learnerToken: "Student A1" }, { score: 40 }] },
  });
  assert.equal(ran.verdict, "FAIL");
  assert.equal(ran.privacy.tokenized, false);
});

test("a title-only quiz, an operation list, and two visible courses do not pass", async () => {
  const titleOnly = judgeQuizAuthoring({ quizId: "4045357" });
  assert.equal(titleOnly.verdict, "FAIL");
  assert.match(titleOnly.reason, /title/);

  const listed = judgeUndoScenario({ operations: [] });
  assert.equal(listed.verdict, "FAIL");
  const anyList = judgeUndoScenario({ operations: [{ id: "op-1" }, { id: "op-2" }] });
  assert.equal(anyList.verdict, "FAIL");

  const visible = judgeCourseComparison({ coursesVisible: 2 });
  assert.equal(visible.verdict, "FAIL");
  assert.match(visible.reason, /not a comparison/);

  const quiz = await runQuizScenario({
    courseId: "89585",
    mark: "MARK",
    plan: async () => ({ outcome: "verified" }),
    read: async (name) => {
      if (name === "canvas_list_new_quizzes") return { ok: true, data: [{ id: "9", title: "MARK Cell Structure" }] };
      if (name === "canvas_list_quiz_items") return { ok: true, data: [] };
      return { ok: true, data: { quiz_settings: {} } };
    },
  });
  assert.equal(quiz.verdict, "FAIL");

  const compared = await runCompareScenario({
    courseId: "1",
    read: async (name, args) => {
      if (name === "canvas_list_your_courses") return { ok: true, data: [{ id: "1", name: "A" }, { id: "2", name: "B" }] };
      if (args.course_id === "1") return { ok: true, data: [{ title: "Syllabus" }] };
      return { ok: true, data: [{ title: "Lab" }] };
    },
  });
  assert.equal(compared.verdict, "PASS");
  assert.equal(compared.readback.difference, true);

  const unread = await runCompareScenario({
    courseId: "1",
    read: async (name) => name === "canvas_list_your_courses"
      ? { ok: true, data: [{ id: "1" }, { id: "2" }] }
      : { ok: false, data: null },
  });
  assert.equal(unread.verdict, "FAIL");
});

test("undo matches the proof object's title and a failed read is not absence", async () => {
  const rows = [{ title: "Other page", url: "other" }, { title: "MARK undo page", url: "mark-undo-page" }];
  assert.equal(rowByIdentity(rows, { title: "MARK undo page" }).url, "mark-undo-page");
  assert.notEqual(rows[0].url, rowByIdentity(rows, { title: "MARK undo page" }).url);

  const failed = absenceOf({ ok: false, data: null }, { title: "MARK undo page" });
  assert.equal(failed.gone, false);
  assert.equal(failed.failed, true);
  const notArray = absenceOf({ ok: true, data: { missing: true } }, { title: "MARK undo page" });
  assert.equal(notArray.failed, true);
  assert.equal(notArray.gone, false);

  const calls = [];
  const pages = [{ title: "MARK undo page", url: "mark-undo-page" }];
  const result = await runUndoScenario({
    courseId: "89585",
    mark: "MARK",
    binding: "binding",
    change: async () => ({ outcome: "verified", operationId: "op-1" }),
    callTool: async (name) => { calls.push(name); return { structuredContent: {} }; },
    read: async () => ({ ok: true, data: pages.splice(0) }),
  });
  assert.equal(calls[0], "morrow_operation_undo");
  assert.equal(result.verdict, "PASS");

  const unreadUndo = await runUndoScenario({
    courseId: "89585",
    mark: "MARK",
    binding: "binding",
    change: async () => ({ outcome: "verified", operationId: "op-1" }),
    callTool: async () => ({}),
    read: async (_name, args) => args.search_term
      ? { ok: true, data: [{ title: "MARK undo page", url: "mark-undo-page" }] }
      : { ok: false },
  });
  assert.equal(unreadUndo.verdict, "FAIL");
});

test("a stale snapshot passes only on the stale-snapshot refusal before dispatch", () => {
  assert.equal(judgeStaleSnapshot({ isError: true, structuredContent: { status: null, code: "capability_input_invalid" } }).verdict, "FAIL");
  assert.equal(judgeStaleSnapshot({ structuredContent: { status: "awaiting_approval" } }).verdict, "FAIL");
  assert.equal(judgeStaleSnapshot({ structuredContent: { status: "applied_or_unknown" } }).verdict, "FAIL");
  assert.equal(judgeStaleSnapshot({ structuredContent: { status: "verified" } }).verdict, "FAIL");
  assert.equal(judgeStaleSnapshot({ structuredContent: { status: null } }).verdict, "FAIL");
  const refused = judgeStaleSnapshot({
    isError: true,
    structuredContent: { status: "refused", code: "item_bank_snapshot_changed", sent: false },
  });
  assert.equal(refused.verdict, "PASS");
  assert.equal(refused.readback.refusedBeforeDispatch, true);
});

test("a pre-existing id is not copied, deleted, or mutated", async () => {
  const plan = disposablePlan("MARK");
  assert.equal(plan.some((entry) => entry.readOnlySeed), false);
  assert.equal(plan.some((entry) => entry.key === "feature" || entry.key === "outcome_group_id"), false);

  const reads = [];
  const changes = [];
  const preexistingIds = new Set(["outcome_gradebook", "existing-page", "existing-module", "existing-group"]);
  const made = await makeDisposables("MARK", {
    preexistingIds,
    log: async () => {},
    read: async (tool) => {
      reads.push(tool);
      return { ok: true, data: [{ id: "existing-group", feature: "outcome_gradebook", title: "Week 1", name: "Week 1", url: "existing-page" }] };
    },
    change: async (label, tool, args) => {
      changes.push({ label, tool, args });
      return { outcome: "not_planned" };
    },
  });
  assert.equal(made.made.feature, undefined);
  assert.equal(made.made.outcome_group_id, undefined);
  assert.equal(made.made.page_id, undefined);
  assert.equal(made.made.module_id, undefined);
  assert.equal(reads.some((tool) => /feature|outcome/.test(tool)), false);
  assert.equal(changes.some((call) => JSON.stringify(call.args).includes("outcome_gradebook")), false);
  assert.equal(changes.some((call) => JSON.stringify(call.args).includes("existing-page")), false);

  const removals = [];
  const removed = await removeDisposables([
    { key: "page_id", id: "existing-page", remove: { tool: "canvas_delete_page_courses", args: (id) => ({ url_or_id: id }) } },
    { key: "page_id", id: "mark-page", remove: { tool: "canvas_delete_page_courses", args: (id) => ({ url_or_id: id }) } },
  ], {
    preexistingIds,
    log: async () => {},
    change: async (_label, tool, args) => {
      removals.push({ tool, args });
      return { outcome: "verified" };
    },
  });
  assert.deepEqual(removals, [{ tool: "canvas_delete_page_courses", args: { url_or_id: "mark-page" } }]);
  assert.equal(removed.removed.some((row) => row.id === "existing-page" && row.outcome === "refused_preexisting"), true);

  const preexisting = { page_id: "existing-page", url_or_id: "existing-page", feature: "outcome_gradebook", module_id: "existing-module" };
  const created = addressPoolForWrite({ course_id: "89585", user_id: "self", page_id: "mark-page" });
  assert.equal(created.page_id, "mark-page");
  assert.equal(created.feature, undefined);
  assert.deepEqual(preexistingTarget({ url_or_id: "existing-page", wiki_page_title: "renamed" }, preexisting, created), { key: "url_or_id", id: "existing-page" });
  assert.deepEqual(preexistingTarget({ feature: "outcome_gradebook", state: "off" }, preexisting, created), { key: "feature", id: "outcome_gradebook" });
  assert.equal(preexistingTarget({ url_or_id: "mark-page" }, preexisting, created), null);
});

test("module placement and quiz delete do not treat a pre-existing or failed list as success", async () => {
  const plans = [];
  const state = {};
  const runners = extraRunners({
    COURSE: "89585",
    SOURCE_BINDING: "binding",
    mark: "MARK",
    state,
    callTool: async () => ({}),
    change: async () => ({ outcome: "verified" }),
    plan: async (label, tool, args) => {
      plans.push({ tool, args });
      return { outcome: "verified" };
    },
    read: async (name) => {
      if (name === "canvas_list_new_quizzes") return { ok: true, data: [{ id: "9", title: "MARK planner quiz" }] };
      if (name === "canvas_list_modules") return { ok: true, data: [{ id: "55", name: "Week 1" }] };
      return { ok: true, data: [] };
    },
  });
  const placed = await runners.morrow_plan_new_quiz_module_placement();
  assert.equal(placed.ok, undefined);
  assert.match(placed.blocked, /already holds/);
  assert.equal(plans.some((call) => call.args?.module_id === "55"), false);

  state.quizId = "9";
  const failedDelete = await extraRunners({
    COURSE: "89585",
    SOURCE_BINDING: "binding",
    mark: "MARK",
    state,
    callTool: async () => ({}),
    change: async () => ({ outcome: "verified" }),
    plan: async () => ({ outcome: "verified" }),
    read: async () => ({ ok: false, data: null }),
  }).morrow_plan_new_quiz_delete();
  assert.equal(failedDelete.ok, false);
  assert.equal(failedDelete.detail.readFailed, true);
  assert.equal(failedDelete.detail.stillInCanvas, null);
});
