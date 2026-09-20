// Phase 1, Morrow's own tools. The catalog operations are Canvas routes; these are the controls a
// person's assistant actually calls: the operation lifecycle, batches, the catalog, health, and
// the planners. Each is exercised for real and judged on what it answered.
import { readFileSync } from "node:fs";
import { connect, SANDBOX, SOURCE_BINDING } from "./connect.mjs";
import { makeTools } from "./lib/tools.mjs";
import { loadLedger, recordRow, summarize } from "./ledger.mjs";

const COURSE = SANDBOX.courseId;
const mark = `${SANDBOX.mark}T${String(Math.floor(Date.now() / 1000))}`;
const manifest = JSON.parse(readFileSync(new URL("manifest.json", import.meta.url), "utf8"));
const ledger = loadLedger();
const { client, close } = await connect("morrow-proof-tools");
const { log, read, change, plan, callTool } = makeTools(client, new URL("run-tools.log", import.meta.url));

const todo = manifest.operations.filter((row) => row.kind === "mcp_tool" && row.classification === "PROVABLE" && !ledger.rows[row.id]);
const only = (process.env.PROOF_ONLY || "").split(",").map((name) => name.trim()).filter(Boolean);

/** A tool answered when it returned structure and did not report an error. */
const answered = (value) => Boolean(value) && value.isError !== true
  && (value.structuredContent !== undefined || (value.content ?? []).length > 0);

const state = { operationId: null, batchId: null };

// How each control is exercised. A control that needs something to act on is given something this
// run made, so nothing the course already held is touched.
const RUNNERS = {
  morrow_health: async () => ({ answer: await callTool("morrow_health", {}) }),
  morrow_activity: async () => ({ answer: await callTool("morrow_activity", {}) }),
  morrow_catalog: async () => ({ answer: await callTool("morrow_catalog", {}) }),
  morrow_catalog_search: async () => ({ answer: await callTool("morrow_catalog_search", { query: "quiz" }) }),
  morrow_capability_get: async () => ({ answer: await callTool("morrow_capability_get", { name: "canvas_list_modules" }) }),
  morrow_capability_read: async () => ({ answer: await callTool("morrow_capability_read", { name: "canvas_list_modules", arguments: { course_id: COURSE, _morrow: { source_binding_id: SOURCE_BINDING } } }) }),
  morrow_canvas_bindings: async () => ({ answer: await callTool("morrow_capability_read", { name: "morrow_canvas_bindings", arguments: {} }) }),
  morrow_browser_bindings: async () => ({ answer: await callTool("morrow_capability_read", { name: "morrow_browser_bindings", arguments: {} }) }),
  morrow_operation_list: async () => ({ answer: await callTool("morrow_operation_list", { course_id: COURSE }) }),
  morrow_operations_recent: async () => ({ answer: await callTool("morrow_operations_recent", {}) }),
  morrow_batches_recent: async () => ({ answer: await callTool("morrow_batches_recent", {}) }),
  morrow_batch_health: async () => ({ answer: await callTool("morrow_batch_health", {}) }),
  morrow_inventory_courses: async () => ({
    answer: await callTool("morrow_inventory_courses", {
      provider: "canvas", scope: "selected_program",
      courses: [{ course_id: COURSE, expected_name: state.courseName, source_binding_id: SOURCE_BINDING }],
      max_pages_per_list: 1, max_list_calls_per_course: 10,
    }, 900_000),
  }),
  morrow_audit_course: async () => ({ answer: await callTool("morrow_audit_course", { source_binding_id: SOURCE_BINDING, course_id: COURSE }, 900_000) }),
  morrow_check_new_quiz: async () => {
    const quizzes = await read("canvas_list_new_quizzes", { course_id: COURSE });
    const first = (Array.isArray(quizzes.data) ? quizzes.data : [])[0];
    if (!first) return { blocked: "The sandbox course holds no New Quiz to check." };
    return { answer: await callTool("morrow_check_new_quiz", { source_binding_id: SOURCE_BINDING, course_id: COURSE, quiz_id: String(first.id) }, 600_000) };
  },
  // The operation lifecycle, exercised against one change this run makes and then removes.
  morrow_capability_change: async () => {
    const made = await change("tools.page.create", "canvas_create_page_courses", {
      course_id: COURSE, wiki_page_title: `${mark} lifecycle`, wiki_page_body: "<p>lifecycle</p>", wiki_page_published: false,
    });
    state.operationId = made.operationId ?? null;
    state.pageUrl = null;
    const pages = await read("canvas_list_pages_courses", { course_id: COURSE, search_term: `${mark} lifecycle` });
    const saved = (Array.isArray(pages.data) ? pages.data : [])[0];
    if (saved) state.pageUrl = String(saved.url);
    return { ok: made.outcome === "verified", detail: { outcome: made.outcome, operationId: state.operationId, savedInCanvas: Boolean(saved) } };
  },
  morrow_operation_get: async () => {
    if (!state.operationId) return { blocked: "No operation was made by this run to read." };
    return { answer: await callTool("morrow_operation_get", { operation_id: state.operationId }) };
  },
  morrow_operation_verify: async () => {
    if (!state.operationId) return { blocked: "No operation was made by this run to verify." };
    return { answer: await callTool("morrow_operation_verify", { operation_id: state.operationId }) };
  },
  morrow_operation_reconcile: async () => {
    if (!state.operationId) return { blocked: "No operation was made by this run to reconcile." };
    return { answer: await callTool("morrow_operation_reconcile", { operation_id: state.operationId }) };
  },
  morrow_operation_undo: async () => {
    if (!state.operationId || !state.pageUrl) return { blocked: "No operation was made by this run to undo." };
    // Morrow does not invent the inverse of a change: the caller states the correcting change, and
    // Morrow binds it to the operation being corrected. The proof is that Canvas no longer holds
    // the page afterwards.
    const answer = await callTool("morrow_operation_undo", {
      operation_id: state.operationId,
      correction_tool: "canvas_delete_page_courses",
      correction_arguments: { course_id: COURSE, url_or_id: state.pageUrl, _morrow: { source_binding_id: SOURCE_BINDING } },
    }, 600_000);
    const pages = await read("canvas_list_pages_courses", { course_id: COURSE, search_term: `${mark} lifecycle` });
    const still = (Array.isArray(pages.data) ? pages.data : []).length;
    if (answered(answer) && still === 0) state.pageUrl = null;
    const problem = answer?.structuredContent?.data?.code ?? null;
    return {
      ok: answered(answer) && still === 0,
      answer,
      detail: { pagesStillNamedThat: still, statesTheCorrection: true, problem,
        note: problem ? "Morrow refused to build the correction for a change it had verified." : undefined },
    };
  },
  morrow_operation_dispatch: async () => {
    if (!state.operationId) return { blocked: "No operation was made by this run to dispatch again." };
    // The operation already completed, so its receipt is spent. Rejection is the proof: a second
    // dispatch that succeeded would be a change applied twice.
    const answer = await callTool("morrow_operation_dispatch", { operation_id: state.operationId });
    const held = answer?.structuredContent ?? {};
    const rejected = answer?.isError === true || ["failed", "rejected"].includes(String(held.status)) || String(held.phase) === "rejected";
    return { ok: rejected, answer, detail: { spentReceiptRejected: rejected, status: held.status ?? null, phase: held.phase ?? null } };
  },
  morrow_operation_cancel: async () => {
    // A request that was never sent, made on purpose so cancelling it removes nothing.
    const asked = await callTool("morrow_capability_change", {
      name: "canvas_create_page_courses",
      arguments: { course_id: COURSE, wiki_page_title: `${mark} never sent`, wiki_page_body: "<p>x</p>", wiki_page_published: false,
        _morrow: { source_binding_id: SOURCE_BINDING } },
    });
    const id = asked?.structuredContent?.operationId;
    if (!id) return { blocked: "Morrow did not hand back an operation to cancel." };
    return { answer: await callTool("morrow_operation_cancel", { operation_id: id }) };
  },
  morrow_operation_close_unresolved: async () => ({
    blocked: "Closing an unresolved change requires a person to state what Canvas shows. This harness never claims that on a person's behalf.",
  }),
};

try {
  const course = await read("canvas_get_single_course_courses", { id: COURSE });
  state.courseName = String(course.data?.name ?? course.data?.course?.name ?? "");
  const chosen = todo.filter((row) => only.length === 0 || only.includes(row.id));
  await log(`Morrow controls to exercise: ${chosen.length}`);
  for (const row of chosen) {
    const runner = RUNNERS[row.id];
    if (!runner) {
      recordRow(ledger, row.id, { phase: 1, kind: "tool", verdict: "BLOCKED",
        reason: "This control has no exercise in the harness yet, so it is recorded as unproven rather than assumed." });
      continue;
    }
    let outcome;
    try {
      outcome = await runner();
    } catch (error) {
      outcome = { threw: String(error).slice(0, 220) };
    }
    if (outcome.blocked) {
      recordRow(ledger, row.id, { phase: 1, kind: "tool", verdict: "BLOCKED", reason: outcome.blocked });
    } else if (outcome.threw) {
      recordRow(ledger, row.id, { phase: 1, kind: "tool", verdict: "FAIL", reason: `The control threw: ${outcome.threw}` });
    } else {
      const ok = outcome.ok ?? answered(outcome.answer);
      recordRow(ledger, row.id, {
        phase: 1, kind: "tool", verdict: ok ? "PASS" : "FAIL",
        ...(ok ? {} : { reason: `The control answered with an error or nothing: ${JSON.stringify(outcome.answer?.structuredContent ?? null).slice(0, 200)}` }),
        readback: { source: "morrow", answered: ok, ...(outcome.detail ?? {}) },
        sandbox: { courseId: COURSE, mark },
      });
    }
    await log(`${row.id}: ${ledger.rows[row.id].verdict}`);
  }
  // Whatever the lifecycle left behind goes now.
  if (state.pageUrl) {
    const removed = await change("tools.page.delete", "canvas_delete_page_courses", { course_id: COURSE, url_or_id: state.pageUrl });
    await log(`lifecycle page removed: ${removed.outcome}`);
  }
  await log(`controls complete: ${JSON.stringify(summarize(ledger))}`);
} finally {
  await close();
}
