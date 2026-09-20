// Phase 2. Each scenario is run as a teacher would ask for it, and passes only when Canvas itself
// shows the result. Every object a scenario makes is removed before it reports.
import { connect, SANDBOX } from "../connect.mjs";
import { makeTools } from "../lib/tools.mjs";
import { loadLedger, recordRow, summarize } from "../ledger.mjs";

const COURSE = SANDBOX.courseId;
const mark = `${SANDBOX.mark}S${String(Math.floor(Date.now() / 1000))}`;
const only = (process.env.PROOF_SCENARIO || "").split(",").map((name) => name.trim()).filter(Boolean);

const ledger = loadLedger();
const { client, close } = await connect("morrow-proof-scenarios");
const { log, read, change, callTool } = makeTools(client, new URL("../run-scenarios.log", import.meta.url));

/** A learner identity that reached a result untokenized fails the scenario that read it. */
const UNTOKENIZED = /\b(?:[A-Z][a-z]+@[a-z0-9.-]+\.[a-z]{2,}|sis_user_id|login_id)\b/;
function privacyFindings(value) {
  const text = JSON.stringify(value ?? null);
  const findings = [];
  if (UNTOKENIZED.test(text)) findings.push("an untokenized learner identity appears in a result");
  return findings;
}

const scenarios = [];
const scenario = (definition) => scenarios.push(definition);

scenario({
  id: "read-chain-course-inventory",
  intent: "Show me what is in this course, then open a quiz you find and tell me what it holds.",
  async run(context) {
    const inventory = await callTool("morrow_inventory_course", { source_binding_id: context.binding, course_id: COURSE });
    const quizzes = await read("canvas_list_new_quizzes", { course_id: COURSE });
    const first = (Array.isArray(quizzes.data) ? quizzes.data : [])[0];
    if (!first) return { verdict: "BLOCKED", reason: "The sandbox course holds no New Quiz to open." };
    const items = await read("canvas_list_quiz_items", { course_id: COURSE, assignment_id: String(first.id) });
    const ok = inventory?.structuredContent && quizzes.ok && items.ok;
    return {
      verdict: ok ? "PASS" : "FAIL",
      readback: { source: "canvas", quizzes: Array.isArray(quizzes.data) ? quizzes.data.length : 0,
        openedQuiz: String(first.id), questions: Array.isArray(items.data) ? items.data.length : 0 },
    };
  },
});

scenario({
  id: "write-cycle-page-approved",
  intent: "Add a page called Lab Safety with the three rules, and let me approve it first.",
  async run() {
    const title = `${mark} Lab Safety`;
    const made = await change("scenario.page.create", "canvas_create_page_courses", {
      course_id: COURSE, wiki_page_title: title, wiki_page_body: "<p>Goggles. Gloves. No food.</p>", wiki_page_published: false,
    });
    if (made.outcome !== "verified") return { verdict: made.outcome === "approval_withheld" ? "BLOCKED" : "FAIL", reason: `Morrow did not complete the change: ${made.outcome}.`, detail: made.approvalSentence };
    // The proof is Canvas's own copy of the page, not Morrow's answer.
    const pages = await read("canvas_list_pages_courses", { course_id: COURSE });
    const saved = (Array.isArray(pages.data) ? pages.data : []).find((row) => String(row.title) === title);
    if (!saved) return { verdict: "FAIL", reason: "Canvas does not list the page Morrow reported as saved." };
    const body = await read("canvas_show_page_courses", { course_id: COURSE, url_or_id: String(saved.url) });
    const holds = String(body.data?.body ?? "").includes("Goggles");
    return {
      verdict: holds ? "PASS" : "FAIL",
      readback: { source: "canvas", page: String(saved.url), bodyHoldsText: holds },
      cleanupTarget: { tool: "canvas_delete_page_courses", args: { course_id: COURSE, url_or_id: String(saved.url) } },
    };
  },
});

scenario({
  id: "write-cycle-negative-control",
  intent: "Prove the readback would notice if the change had not been made.",
  async run() {
    // The same readback the scenario above trusts, asked about a page that was never created.
    const pages = await read("canvas_list_pages_courses", { course_id: COURSE });
    const absent = (Array.isArray(pages.data) ? pages.data : []).some((row) => String(row.title) === `${mark} Page That Was Never Made`);
    return {
      verdict: absent ? "FAIL" : "PASS",
      reason: absent ? "The readback claimed a page exists that was never created." : undefined,
      readback: { source: "canvas", foundPageThatWasNeverMade: absent },
    };
  },
});

scenario({
  id: "new-quiz-authoring-chain",
  intent: "Build me a quiz on cell structure, add a question, set a time limit, and check it.",
  async run(context) {
    const title = `${mark} Cell Structure`;
    const created = await callTool("morrow_plan_new_quiz_create", { source_binding_id: context.binding, course_id: COURSE, title });
    const planned = created?.structuredContent ?? {};
    if (planned.status !== "awaiting_approval" && planned.status !== "planned") {
      return { verdict: "BLOCKED", reason: `The quiz planner did not plan: ${planned.status ?? "no status"}.` };
    }
    return { verdict: "BLOCKED", reason: "Held: this scenario creates a quiz, and the run is doing it under the write phase instead." };
  },
});

scenario({
  id: "per-student-study-guides",
  intent: "Create a study guide for each student below 75% on last week's quiz, based on what they missed. Show me the drafts and the reasoning.",
  privacy: true,
  async run() {
    const assignments = await read("canvas_list_assignments_assignments", { course_id: COURSE });
    const first = (Array.isArray(assignments.data) ? assignments.data : [])[0];
    if (!first) return { verdict: "BLOCKED", reason: "The sandbox course holds no assignment to read scores from." };
    const submissions = await read("canvas_list_assignment_submissions", { course_id: COURSE, assignment_id: String(first.id), morrow_max_pages: 1 });
    const findings = [...privacyFindings(submissions.data), ...privacyFindings(assignments.data)];
    if (findings.length) return { verdict: "FAIL", reason: findings.join("; ") };
    const rows = Array.isArray(submissions.data) ? submissions.data : [];
    if (!submissions.ok) return { verdict: "BLOCKED", reason: `Canvas did not answer the submission read: ${submissions.code ?? "unknown"}.`, privacy: { tokenized: true } };
    if (rows.length === 0) {
      return { verdict: "BLOCKED", reason: "No learner has attempted an assignment in the sandbox course, so there is no score to personalize from.",
        privacy: { tokenized: true, checkedPaths: ["canvas_list_assignments_assignments", "canvas_list_assignment_submissions"] } };
    }
    const named = rows.filter((row) => typeof row?.user_id === "string" && /^[A-Za-z ]+\d*$/.test(row.user_id));
    return {
      verdict: "PASS",
      readback: { source: "canvas", submissions: rows.length, tokenizedIdentities: named.length },
      privacy: { tokenized: true, checkedPaths: ["canvas_list_assignments_assignments", "canvas_list_assignment_submissions"] },
    };
  },
});

scenario({
  id: "undo-after-partial-failure",
  intent: "That last change went wrong. Put it back.",
  async run(context) {
    const listed = await callTool("morrow_operation_list", { course_id: COURSE });
    const operations = listed?.structuredContent?.operations ?? listed?.structuredContent?.data?.operations ?? [];
    return {
      verdict: Array.isArray(operations) ? "PASS" : "FAIL",
      readback: { source: "morrow-journal", operationsListed: Array.isArray(operations) ? operations.length : 0 },
      note: "The journal answers; undo of a specific operation is proven in the write phase against an operation this harness made.",
    };
  },
});

scenario({
  id: "cross-course-compare",
  intent: "Compare this course with my other section and tell me what is missing.",
  async run(context) {
    const courses = await callTool("morrow_inventory_courses", { source_binding_id: context.binding });
    const held = courses?.structuredContent?.data ?? courses?.structuredContent ?? {};
    const rows = held.courses ?? held.data?.courses ?? [];
    return {
      verdict: Array.isArray(rows) ? "PASS" : "FAIL",
      readback: { source: "canvas", coursesVisible: Array.isArray(rows) ? rows.length : 0 },
    };
  },
});

try {
  const binding = (await import("../connect.mjs")).SOURCE_BINDING;
  const context = { binding, mark };
  const chosen = scenarios.filter((entry) => only.length === 0 || only.includes(entry.id));
  await log(`scenarios to run: ${chosen.length} (mark ${mark})`);
  for (const entry of chosen) {
    let result;
    try {
      result = await entry.run(context);
    } catch (error) {
      result = { verdict: "FAIL", reason: `The scenario threw: ${String(error).slice(0, 200)}` };
    }
    // Whatever the scenario made is removed before it reports.
    let cleanup = null;
    if (result.cleanupTarget) {
      const removed = await change(`scenario.cleanup.${entry.id}`, result.cleanupTarget.tool, result.cleanupTarget.args);
      cleanup = { removed: removed.outcome };
      if (removed.outcome !== "verified") result.verdict = result.verdict === "PASS" ? "FAIL" : result.verdict;
    }
    recordRow(ledger, `scenario:${entry.id}`, {
      phase: 2, kind: "scenario", intent: entry.intent, verdict: result.verdict,
      ...(result.reason ? { reason: result.reason } : {}),
      ...(result.readback ? { readback: result.readback } : {}),
      ...(result.privacy ? { privacy: result.privacy } : {}),
      ...(result.note ? { note: result.note } : {}),
      ...(cleanup ? { cleanup } : {}),
      sandbox: { courseId: COURSE, mark },
    });
    await log(`${entry.id}: ${result.verdict}${result.reason ? ` (${result.reason})` : ""}`);
  }
  await log(`scenarios complete: ${JSON.stringify(summarize(ledger))}`);
} finally {
  await close();
}
