// Phase 2. Each scenario is run as a teacher would ask for it, and passes only when Canvas itself
// shows the result. Every object a scenario makes is removed before it reports.
import { connect, SANDBOX } from "../connect.mjs";
import { makeTools } from "../lib/tools.mjs";
import { absenceOf } from "../lib/proof-rules.mjs";
import { loadLedger, recordRow, summarize } from "../ledger.mjs";
import { runCompareScenario, runPrivacyScenario, runQuizScenario, runUndoScenario } from "./cases.mjs";

const COURSE = SANDBOX.courseId;
const mark = `${SANDBOX.mark}S${String(Math.floor(Date.now() / 1000))}`;
const only = (process.env.PROOF_SCENARIO || "").split(",").map((name) => name.trim()).filter(Boolean);

const ledger = loadLedger();
const { client, close } = await connect("morrow-proof-scenarios");
const { log, read, change, plan, callTool } = makeTools(client, new URL("../run-scenarios.log", import.meta.url));

const scenarios = [];
const scenario = (definition) => scenarios.push(definition);

scenario({
  id: "read-chain-course-inventory",
  intent: "Show me what is in this course, then open a quiz you find and tell me what it holds.",
  async run(context) {
    // The inventory names each course it reads, with the name the caller expects it to have, so a
    // course that is not the one the caller meant is refused rather than read.
    // An unbounded inventory of a course this size does not answer inside the client's default
    // wait, so the scenario asks for the bounded read a teacher's assistant would ask for.
    const inventory = await callTool("morrow_inventory_courses", {
      provider: "canvas", scope: "selected_program",
      courses: [{ course_id: COURSE, expected_name: context.courseName, source_binding_id: context.binding }],
      max_pages_per_list: 1, max_list_calls_per_course: 20,
    }, 900_000);
    const quizzes = await read("canvas_list_new_quizzes", { course_id: COURSE });
    const first = (Array.isArray(quizzes.data) ? quizzes.data : [])[0];
    if (!first) return { verdict: "BLOCKED", reason: "The sandbox course holds no New Quiz to open." };
    const items = await read("canvas_list_quiz_items", { course_id: COURSE, assignment_id: String(first.id) });
    const steps = {
      inventory: Boolean(inventory?.structuredContent) && inventory?.isError !== true,
      quizzes: quizzes.ok === true,
      questions: items.ok === true,
    };
    const failed = Object.entries(steps).filter(([, ok]) => !ok).map(([name]) => name);
    return {
      verdict: failed.length === 0 ? "PASS" : "FAIL",
      ...(failed.length ? { reason: `These steps of the chain did not answer: ${failed.join(", ")}.` } : {}),
      readback: { source: "canvas", steps, quizzes: Array.isArray(quizzes.data) ? quizzes.data.length : 0,
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
    const pages = await read("canvas_list_pages_courses", { course_id: COURSE, search_term: title });
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
    const wanted = `${mark} Page That Was Never Made`;
    const pages = await read("canvas_list_pages_courses", { course_id: COURSE, search_term: wanted });
    const check = absenceOf(pages, { title: wanted });
    if (check.failed) {
      return { verdict: "FAIL", reason: "The page list did not answer, so absence is not proven.", readback: { source: "canvas", readFailed: true } };
    }
    return {
      verdict: check.gone ? "PASS" : "FAIL",
      reason: check.gone ? undefined : "The readback claimed a page exists that was never created.",
      readback: { source: "canvas", foundPageThatWasNeverMade: !check.gone },
    };
  },
});

scenario({
  id: "new-quiz-authoring-chain",
  intent: "Build me a quiz on cell structure, add a question, set a time limit, and check it.",
  async run(context) {
    return runQuizScenario({ plan, read, courseId: COURSE, mark: context.mark });
  },
});

scenario({
  id: "per-student-study-guides",
  intent: "Create a study guide for each student below 75% on last week's quiz, based on what they missed. Show me the drafts and the reasoning.",
  privacy: true,
  async run() {
    return runPrivacyScenario({ read, courseId: COURSE });
  },
});

scenario({
  id: "undo-after-partial-failure",
  intent: "That last change went wrong. Put it back.",
  async run(context) {
    return runUndoScenario({ change, read, callTool, courseId: COURSE, mark: context.mark, binding: context.binding });
  },
});

scenario({
  id: "cross-course-compare",
  intent: "Compare this course with my other section and tell me what is missing.",
  async run() {
    return runCompareScenario({ read, courseId: COURSE });
  },
});

try {
  const binding = (await import("../connect.mjs")).SOURCE_BINDING;
  // The inventory refuses a course whose name is not the one the caller expects, so the run reads
  // the name from Canvas first rather than asserting one.
  const course = await read("canvas_get_single_course_courses", { id: COURSE });
  const courseName = String(course.data?.name ?? course.data?.course?.name ?? "");
  const context = { binding, mark, courseName };
  await log(`sandbox course name: ${courseName || "(unreadable)"}`);
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
