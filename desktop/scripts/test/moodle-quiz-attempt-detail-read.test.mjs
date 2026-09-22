import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import {
  executeMoodleQuizAttemptInPage,
  executeMoodleQuizManualGradingQueueInPage,
  executeMoodleQuizRegradeReportInPage,
} from "../../connector/extension/src/moodle-quiz-attempt-detail-read.js";

const ATTEMPT_OPERATION = Object.freeze({
  key: "moodle.form.quiz.attempt_detail.read.v1",
  toolName: "moodle_get_quiz_attempt",
  provider: "moodle",
  readOnly: true,
});
const QUEUE_OPERATION = Object.freeze({
  key: "moodle.form.quiz.manual_grading_queue.read.v1",
  toolName: "moodle_get_quiz_manual_grading_queue",
  provider: "moodle",
  readOnly: true,
});
const REGRADE_OPERATION = Object.freeze({
  key: "moodle.form.quiz.regrade_report.read.v1",
  toolName: "moodle_get_quiz_regrade_report",
  provider: "moodle",
  readOnly: true,
});
const AVOIDED_ROUTES = "/mod/quiz/attempt.php+/mod/quiz/review.php+/mod/quiz/reviewquestion.php";

test("Moodle Quiz attempt, manual grading and regrade reads are cataloged and routed through the extension worker", () => {
  const root = new URL("../..", import.meta.url);
  const catalog = JSON.parse(readFileSync(new URL("connector/extension/generated/moodle-browser-catalog.json", root), "utf8"));
  for (const [key, toolName] of [
    ["moodle.form.quiz.attempt_detail.read.v1", "moodle_get_quiz_attempt"],
    ["moodle.form.quiz.manual_grading_queue.read.v1", "moodle_get_quiz_manual_grading_queue"],
    ["moodle.form.quiz.regrade_report.read.v1", "moodle_get_quiz_regrade_report"],
  ]) {
    const entries = catalog.operations.filter((entry) => entry.key === key);
    assert.equal(entries.length, 1, `${key} must be cataloged exactly once`);
    assert.equal(entries[0].toolName, toolName);
    assert.equal(entries[0].provider, "moodle");
    assert.equal(entries[0].readOnly, true);
    assert.equal(entries[0].dataClass, "learner");
    // The description must state the route choice and the required capability
    // before an assistant calls it.
    assert.match(entries[0].description, /\/mod\/quiz\/report\.php/);
    assert.match(entries[0].description, /never opens \/mod\/quiz\/attempt\.php/);
    assert.match(entries[0].description, /mod\/quiz:(?:viewreports|grade)/);
  }
  const worker = readFileSync(new URL("connector/extension/src/service-worker.js", root), "utf8");
  assert.match(worker, /import \{ executeMoodleQuizAttemptInPage, executeMoodleQuizManualGradingQueueInPage, executeMoodleQuizRegradeReportInPage \} from "\.\/moodle-quiz-attempt-detail-read\.js";/);
  assert.match(worker, /MOODLE_QUIZ_ATTEMPT_DETAIL_OPERATION_KEY = "moodle\.form\.quiz\.attempt_detail\.read\.v1"/);
  assert.match(worker, /MOODLE_QUIZ_MANUAL_GRADING_QUEUE_OPERATION_KEY = "moodle\.form\.quiz\.manual_grading_queue\.read\.v1"/);
  assert.match(worker, /MOODLE_QUIZ_REGRADE_REPORT_OPERATION_KEY = "moodle\.form\.quiz\.regrade_report\.read\.v1"/);
  assert.match(worker, /func: executeMoodleQuizAttemptInPage/);
  assert.match(worker, /func: executeMoodleQuizManualGradingQueueInPage/);
  assert.match(worker, /func: executeMoodleQuizRegradeReportInPage/);
});

test("Moodle Quiz attempt reads use the report routes and return bounded records only", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morrow-moodle-quiz-attempt-detail-"));
  const key = join(directory, "key.pem");
  const certificate = join(directory, "certificate.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", certificate], { stdio: "ignore" });
  const PRIVATE_SESSION = "moodle-private-session";
  const PRIVATE_RESPONSE = "the mitochondria is the powerhouse";
  const requests = [];
  let origin = "";
  let mode = "complete";
  let browser;

  const stateFilter = () => {
    const states = [
      ["notstarted", "Not started"],
      ["inprogress", "In progress"],
      ["overdue", "Overdue"],
      ["submitted", "Submitted"],
      ["finished", "Finished"],
      ["abandoned", "Never submitted"],
    ];
    return states.map(([state, label]) => {
      if (mode === "state-label-missing" && state === "finished") {
        return `<input type="hidden" name="state${state}" value="0"><input type="checkbox" class="form-check-input" name="state${state}" id="id_state${state}" value="1" checked>`;
      }
      return `<input type="hidden" name="state${state}" value="0"><input type="checkbox" class="form-check-input" name="state${state}" id="id_state${state}" value="1" checked>
        <label class="form-check-label" for="id_state${state}">${label}</label>`;
    }).join("\n");
  };
  const settingsForm = (regradeCapability) => `<form id="mform1" method="post" action="/mod/quiz/report.php?id=8&amp;mode=overview">
      <select name="attempts" id="id_attempts"><option value="enrolled_with">Enrolled users who have attempted the quiz</option><option value="all_with" selected>All users who have attempted the quiz</option></select>
      ${stateFilter()}
      ${regradeCapability ? '<input type="hidden" name="onlyregraded" value="0"><input type="checkbox" class="form-check-input" name="onlyregraded" id="id_onlyregraded" value="1"><label class="form-check-label" for="id_onlyregraded">Show only attempts that have been regraded</label>' : ""}
      <input type="hidden" name="sesskey" value="${PRIVATE_SESSION}">
    </form>`;
  const sortLink = (column, label) => `<a href="/mod/quiz/report.php?id=8&amp;mode=overview&amp;attempts=all_with&amp;onlygraded=0&amp;tsort=${column}">${label}</a>`;
  const overviewHeaders = (columns) => `<thead><tr>${columns
    .map((column, index) => `<th class="header c${index}" scope="col">${column.sortable === false ? column.label : sortLink(column.name, column.label)}</th>`)
    .join("")}</tr></thead>`;
  const reviewLink = (attempt, slot, inner) => `<a href="/mod/quiz/reviewquestion.php?attempt=${attempt}&amp;slot=${slot}" title="Review response">${inner}</a>`;
  const slotCell = (attempt, slot, state, value, extra = "") => `<span class="que">${extra}<span class="${state}">${value}</span></span>`;
  const attemptRow = (attempt) => {
    const cells = [
      `<a href="/user/view.php?id=${attempt.userId}&amp;course=2">${attempt.name}</a><br><a href="/mod/quiz/review.php?attempt=${attempt.id}" class="reviewlink">Review attempt</a>`,
      attempt.state,
      attempt.started,
      attempt.finished,
      attempt.duration,
      attempt.finished === "-" ? "-" : `<a href="/mod/quiz/review.php?attempt=${attempt.id}" title="Review attempt">${attempt.sumgrades}</a>`,
      ...attempt.slots.map((slot) => slot.html),
    ];
    return `<tr class="r0" id="mod-quiz-report-overview-report_r${attempt.id}">${cells
      .map((cell, index) => `<td class="cell c${index}" id="mod-quiz-report-overview-report_r${attempt.id}_c${index}">${cell}</td>`)
      .join("")}</tr>`;
  };
  const attempts = () => [
    {
      id: 41, userId: 7, name: "Jane Moodle", state: "Finished",
      started: "Monday, 1 September 2026, 10:04 AM", finished: "Monday, 1 September 2026, 10:31 AM",
      duration: "27 mins", sumgrades: "7.00",
      slots: [
        { html: reviewLink(41, 1, slotCell(41, 1, "correct", "1.00")) },
        {
          html: reviewLink(41, 2, slotCell(41, 2, "requiresgrading", "Requires grading",
            `<span class="sr-only">Essay answer: ${PRIVATE_RESPONSE}</span>`)),
        },
        { html: reviewLink(41, 3, slotCell(41, 3, "partiallycorrect", "<del>0.00</del>/<br>0.50")) },
      ],
    },
    {
      id: 42, userId: 8, name: "Rowan Moodle", state: "In progress",
      started: "Monday, 1 September 2026, 11:00 AM", finished: "-", duration: "-", sumgrades: "-",
      slots: [
        { html: reviewLink(42, 1, slotCell(42, 1, "answersaved", "0.00")) },
        { html: "-" },
        { html: "-" },
      ],
    },
  ];
  const averageRow = () => `<tr class="lastrow"><td class="cell c0">Overall average</td><td class="cell c1"></td><td class="cell c2"></td><td class="cell c3"></td><td class="cell c4"></td><td class="cell c5"><span class="avgcell"><span class="average">3.50</span></span></td><td class="cell c6">-</td><td class="cell c7">-</td><td class="cell c8">-</td></tr>`;
  const fillerRows = (page) => Array.from({ length: 100 }, (_, index) => {
    const id = 1000 + page * 100 + index;
    return `<tr><td class="cell c0"><a href="/user/view.php?id=${900 + index}&amp;course=2">Filler Learner</a></td><td class="cell c1">Finished</td><td class="cell c2">-</td><td class="cell c3">-</td><td class="cell c4">-</td><td class="cell c5"><a href="/mod/quiz/review.php?attempt=${id}">1.00</a></td><td class="cell c6">-</td><td class="cell c7">-</td><td class="cell c8">-</td></tr>`;
  }).join("");
  const overviewColumns = [
    { name: "fullname", label: "First name / Surname" },
    { name: "state", label: "State" },
    { name: "timestart", label: "Started" },
    { name: "timefinish", label: "Completed" },
    { name: "duration", label: "Duration" },
    { name: "sumgrades", label: "Grade/10.00" },
    { name: "qsgrade1", label: "Q. 1<br />/1.00" },
    { name: "qsgrade2", label: "Q. 2<br />/4.00" },
    { name: "qsgrade3", label: "Q. 3<br />/1.00" },
  ];
  const overviewPage = (page) => {
    if (mode === "no-table") return `<!doctype html><html><body id="page-mod-quiz-report" class="path-mod course-2">${settingsForm(true)}<div class="alert">Nothing to display</div></body></html>`;
    const rows = mode === "paged" && page === 0 ? fillerRows(0)
      : mode === "over-page-cap" ? fillerRows(page)
      : `${attempts().map(attemptRow).join("")}${averageRow()}`;
    const course = mode === "wrong-course" ? "9" : "2";
    return `<!doctype html><html><body id="page-mod-quiz-report" class="path-mod course-${course}">
      ${settingsForm(true)}
      <table id="attempts" class="generaltable generalbox grades">${overviewHeaders(overviewColumns)}<tbody>${rows}</tbody></table>
    </body></html>`;
  };
  const regradePage = (page) => {
    if (mode === "regrade-no-capability") {
      return `<!doctype html><html><body id="page-mod-quiz-report" class="path-mod course-2">${settingsForm(false)}
        <table id="attempts" class="generaltable"><thead><tr><th class="header c0">State</th></tr></thead><tbody></tbody></table></body></html>`;
    }
    const rows = mode === "regrade-empty" ? "" : [51, 52].map((attempt, index) => `<tr>
        <td class="cell c0"><input type="checkbox" id="attemptid_${attempt}" name="attemptid[]" value="${attempt}"></td>
        <td class="cell c1"><a href="/user/view.php?id=${7 + index}&amp;course=2">Jane Moodle</a></td>
        <td class="cell c2">Finished</td>
        <td class="cell c3">Needed</td>
      </tr>`).join("");
    const commit = mode === "regrade-empty" ? "" : `<div class="alert alert-info">Some attempts need regrading. <a href="/mod/quiz/report.php?id=8&amp;mode=overview&amp;attempts=all_with&amp;onlygraded=0&amp;sesskey=${PRIVATE_SESSION}&amp;regradealldrydo=1">Regrade the attempts that need it</a></div>`;
    return `<!doctype html><html><body id="page-mod-quiz-report" class="path-mod course-2">
      ${settingsForm(true)}
      <table id="attempts" class="generaltable"><thead><tr><th class="header c0">Select</th><th class="header c1">${"First name / Surname"}</th><th class="header c2">${"State"}</th><th class="header c3">Regraded</th></tr></thead><tbody>${page === 0 ? rows : ""}</tbody></table>
      ${commit}
    </body></html>`;
  };
  const gradingPage = () => {
    if (mode === "grading-error") {
      return `<!doctype html><html><body id="page-mod-quiz-report" class="path-mod course-2"><div class="alert alert-danger">Sorry, you do not have permission to do that.</div></body></html>`;
    }
    const heading = `<h3>Questions that need grading</h3><p class="toggleincludeauto"><a href="/mod/quiz/report.php?id=8&amp;mode=grading&amp;includeauto=1">Also show questions that have been graded automatically</a></p>`;
    if (mode === "grading-empty") {
      return `<!doctype html><html><body id="page-mod-quiz-report" class="path-mod course-2">${heading}<div class="alert alert-info">Nothing to display</div></body></html>`;
    }
    const gradeLink = (slot, questionId, grade, label) => `<a href="/mod/quiz/report.php?id=8&amp;mode=grading&amp;slot=${slot}&amp;qid=${questionId}&amp;grade=${grade}" class="gradetheselink">${label}</a>`;
    const rows = [
      { slot: 2, questionId: 55, needsGrading: 3, manuallyGraded: 1, total: 5, name: "Essay one" },
      { slot: 4, questionId: 57, needsGrading: 0, manuallyGraded: 2, total: 2, name: "Essay two" },
    ].map((row) => `<tr>
        <td class="cell c0">${row.slot === 2 ? "1" : "2"}</td>
        <td class="cell c1"><span class="questionicon">Essay</span></td>
        <td class="cell c2">${row.name}</td>
        <td class="cell c3">${row.needsGrading}${row.needsGrading ? ` ${gradeLink(row.slot, row.questionId, "needsgrading", "Grade")}` : ""}</td>
        <td class="cell c4">${row.manuallyGraded}${row.manuallyGraded ? ` ${gradeLink(row.slot, row.questionId, "manuallygraded", "Update grades")}` : ""}</td>
        <td class="cell c5">${row.total} ${gradeLink(row.slot, row.questionId, "all", "Grade all")}</td>
      </tr>`).join("");
    const headers = ["Q #", "T", "Question name", "To grade", "Already graded", ...(mode === "grading-extra-column" ? ["Automatically graded"] : []), "Total"];
    return `<!doctype html><html><body id="page-mod-quiz-report" class="path-mod course-2">${heading}
      <table class="table generaltable" id="questionstograde">
        <thead><tr>${headers.map((header, index) => `<th class="header c${index}" scope="col">${header}</th>`).join("")}</tr></thead>
        <tbody>${rows}</tbody>
      </table></body></html>`;
  };

  const server = createServer({ key: readFileSync(key), cert: readFileSync(certificate) }, (request, response) => {
    const target = new URL(request.url || "/", origin);
    requests.push({ method: request.method, pathname: target.pathname, search: target.search });
    if (target.pathname === "/course/view.php") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<!doctype html><body class="path-course course-2"><script>var M = { cfg: ${JSON.stringify({ wwwroot: origin, sesskey: PRIVATE_SESSION, userId: 3, courseId: 2 })} };</script></body>`);
      return;
    }
    if (request.method === "GET" && target.pathname === "/mod/quiz/report.php") {
      const parameters = target.searchParams;
      assert.equal(parameters.get("id"), "8");
      assert.equal(parameters.get("sesskey"), null, "a report read must not send a session key");
      for (const forbidden of ["regrade", "dryrunregrade", "regradealldrydo", "delete"]) {
        assert.equal(parameters.get(forbidden), null, `a report read must not send ${forbidden}`);
      }
      response.writeHead(200, { "content-type": "text/html" });
      if (parameters.get("mode") === "grading") {
        response.end(gradingPage());
        return;
      }
      assert.equal(parameters.get("mode"), "overview");
      assert.equal(parameters.get("attempts"), "all_with");
      assert.equal(parameters.get("states"), "notstarted-inprogress-overdue-submitted-finished-abandoned");
      assert.equal(parameters.get("pagesize"), "100");
      const page = Number(parameters.get("page"));
      response.end(parameters.get("onlyregraded") === "1" ? regradePage(page) : overviewPage(page));
      return;
    }
    response.writeHead(404).end();
  });

  try {
    await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", (error) => error ? reject(error) : resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");
    origin = `https://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
    const page = await browser.newPage({ ignoreHTTPSErrors: true });
    await page.goto(`${origin}/course/view.php?id=2`);
    const call = (executor, operation, args) => page.evaluate(
      executor,
      JSON.stringify({ operation, arguments: args, binding: { origin, siteUrl: `${origin}/`, principalId: "3", courseId: "2" }, expiresAt: Date.now() + 60_000 }),
    );
    const attempt = (args = { course_id: 2, module_id: 8, attempt_id: 41 }) => call(executeMoodleQuizAttemptInPage, ATTEMPT_OPERATION, args);
    const queue = (args = { course_id: 2, module_id: 8 }) => call(executeMoodleQuizManualGradingQueueInPage, QUEUE_OPERATION, args);
    const regrade = (args = { course_id: 2, module_id: 8 }) => call(executeMoodleQuizRegradeReportInPage, REGRADE_OPERATION, args);
    const reportRequests = () => requests.filter((entry) => entry.pathname === "/mod/quiz/report.php").length;

    const beforeInvalid = reportRequests();
    assert.deepEqual(await attempt({ course_id: 2, module_id: 8 }), { ok: false, sent: false, error: "moodle_quiz_attempt_arguments_invalid" });
    assert.deepEqual(await queue({ course_id: 2, module_id: 8, extra: true }), { ok: false, sent: false, error: "moodle_quiz_manual_grading_queue_arguments_invalid" });
    assert.deepEqual(await regrade({ course_id: 9, module_id: 8 }), { ok: false, sent: false, error: "moodle_quiz_regrade_report_arguments_invalid" });
    assert.equal(reportRequests(), beforeInvalid, "an invalid request still reached the report route");

    const record = await attempt();
    assert.equal(record.ok, true, JSON.stringify(record));
    assert.equal(record.complete, true);
    assert.deepEqual(record.data, {
      schema: "morrow.moodle-quiz-attempt.v1", provider: "moodle", course_id: 2, module_id: 8, attempt_id: 41,
      state: "finished",
      started_display: "Monday, 1 September 2026, 10:04 AM",
      completed_display: "Monday, 1 September 2026, 10:31 AM",
      duration_display: "27 mins",
      slot_count: 3,
      slots: [
        { slot: 1, state: "correct", mark: 1, regraded: false },
        { slot: 2, state: "requiresgrading", mark: null, regraded: false },
        { slot: 3, state: "partiallycorrect", mark: 0.5, regraded: true },
      ],
      learner: { user_id: "7" },
      proof: {
        method: "quiz_report_overview_page",
        route: "/mod/quiz/report.php?mode=overview",
        complete: true,
        exact_module_binding: "quiz_report_page",
        required_capability: "mod/quiz:viewreports",
        avoided_routes: AVOIDED_ROUTES,
        records_learner_state: false,
        records_report_viewed_event: true,
        sesskey_sent: false,
        page_size: 100,
        page_count: 1,
        row_count: 2,
        slot_limit: 100,
      },
    });
    assert.match(record.snapshot_digest, /^[0-9a-f]{64}$/);

    const grading = await queue();
    assert.equal(grading.ok, true, JSON.stringify(grading));
    assert.deepEqual(grading.data, {
      schema: "morrow.moodle-quiz-manual-grading-queue.v1", provider: "moodle", course_id: 2, module_id: 8,
      question_count: 2, needs_grading_count: 3, manually_graded_count: 3, response_count: 7,
      questions: [
        { slot: 2, question_id: 55, needs_grading: 3, manually_graded: 1, total: 5 },
        { slot: 4, question_id: 57, needs_grading: 0, manually_graded: 2, total: 2 },
      ],
      proof: {
        method: "quiz_report_grading_index",
        route: "/mod/quiz/report.php?mode=grading",
        complete: true,
        exact_module_binding: "quiz_report_page",
        required_capability: "mod/quiz:grade",
        avoided_routes: AVOIDED_ROUTES,
        records_learner_state: false,
        records_report_viewed_event: true,
        sesskey_sent: false,
        includes_automatically_graded: false,
        question_limit: 200,
        listed_question_rows: 2,
      },
    });

    const regraded = await regrade();
    assert.equal(regraded.ok, true, JSON.stringify(regraded));
    assert.deepEqual(regraded.data, {
      schema: "morrow.moodle-quiz-regrade-report.v1", provider: "moodle", course_id: 2, module_id: 8,
      regraded_attempt_count: 2, commit_pending: true,
      proof: {
        method: "quiz_report_overview_regraded_filter",
        route: "/mod/quiz/report.php?mode=overview&onlyregraded=1",
        complete: true,
        exact_module_binding: "quiz_report_page",
        required_capability: "mod/quiz:viewreports",
        regrade_capability_marker: "onlyregraded_filter",
        avoided_routes: AVOIDED_ROUTES,
        records_learner_state: false,
        records_report_viewed_event: true,
        sesskey_sent: false,
        regrade_parameter_sent: false,
        page_size: 100,
        page_count: 1,
        attempt_limit: 1000,
      },
    });

    // Each read reached Moodle through the report route, and through nothing else.
    assert.deepEqual(
      requests.filter((entry) => entry.pathname === "/mod/quiz/report.php").map((entry) => new URLSearchParams(entry.search).get("mode")),
      ["overview", "grading", "overview"],
    );

    const results = [JSON.stringify(record), JSON.stringify(grading), JSON.stringify(regraded)];
    for (const privateValue of [PRIVATE_SESSION, PRIVATE_RESPONSE, "Jane Moodle", "Rowan Moodle", "Essay one", "Essay two", "Review attempt", "Filler Learner"]) {
      for (const result of results) assert.equal(result.includes(privateValue), false, `a Quiz attempt read leaked ${privateValue}`);
    }
    // Only the single-attempt read names a learner, and only as one Moodle ID.
    assert.equal(JSON.stringify(record).includes('"user_id":"7"'), true);
    assert.equal(JSON.stringify(record).includes('"8"'), false);
    assert.equal(JSON.stringify(grading).includes("user_id"), false);
    assert.equal(JSON.stringify(regraded).includes("user_id"), false);

    // The attempt row carries links to the review routes; no read may request one.
    for (const path of ["/mod/quiz/attempt.php", "/mod/quiz/review.php", "/mod/quiz/reviewquestion.php", "/mod/quiz/view.php"]) {
      assert.equal(requests.some((entry) => entry.pathname === path), false, `a Quiz attempt read requested ${path}`);
    }

    assert.deepEqual(await attempt({ course_id: 2, module_id: 8, attempt_id: 43 }), { ok: false, sent: false, error: "moodle_quiz_attempt_not_found" });

    mode = "paged";
    const pagedRecord = await attempt();
    assert.equal(pagedRecord.ok, true, JSON.stringify(pagedRecord));
    assert.equal(pagedRecord.data.proof.page_count, 2);
    assert.equal(pagedRecord.data.proof.row_count, 102);
    assert.equal(pagedRecord.data.learner.user_id, "7");

    mode = "over-page-cap";
    assert.deepEqual(await attempt(), { ok: false, sent: false, complete: false, error: "moodle_quiz_attempt_incomplete" });
    // The bounded scan stops after the tenth report page.
    assert.equal(requests.filter((entry) => entry.pathname === "/mod/quiz/report.php" && entry.search.includes("&page=9")).length, 1);
    assert.equal(requests.some((entry) => entry.search.includes("&page=10")), false);

    mode = "state-label-missing";
    assert.deepEqual(await attempt(), { ok: false, sent: false, error: "moodle_quiz_attempt_state_unresolved" });

    mode = "wrong-course";
    assert.deepEqual(await attempt(), { ok: false, sent: false, error: "moodle_quiz_attempt_target_unavailable" });

    mode = "no-table";
    assert.deepEqual(await attempt(), { ok: false, sent: false, error: "moodle_quiz_attempt_target_unavailable" });

    mode = "grading-empty";
    const emptyQueue = await queue();
    assert.equal(emptyQueue.ok, true, JSON.stringify(emptyQueue));
    assert.deepEqual(emptyQueue.data.questions, []);
    assert.equal(emptyQueue.data.question_count, 0);
    assert.equal(emptyQueue.data.needs_grading_count, 0);

    // A Moodle error page keeps the report page type, so an empty queue must be
    // proven by the index heading and never inferred from a missing table.
    mode = "grading-error";
    assert.deepEqual(await queue(), { ok: false, sent: false, error: "moodle_quiz_manual_grading_queue_target_unavailable" });

    mode = "grading-extra-column";
    assert.deepEqual(await queue(), { ok: false, sent: false, error: "moodle_quiz_manual_grading_queue_response_invalid" });

    mode = "regrade-no-capability";
    assert.deepEqual(await regrade(), { ok: false, sent: false, error: "moodle_quiz_regrade_report_capability_unavailable" });

    mode = "regrade-empty";
    const emptyRegrade = await regrade();
    assert.equal(emptyRegrade.ok, true, JSON.stringify(emptyRegrade));
    assert.equal(emptyRegrade.data.regraded_attempt_count, 0);
    assert.equal(emptyRegrade.data.commit_pending, false);

    mode = "complete";
    const expired = await page.evaluate(
      executeMoodleQuizAttemptInPage,
      JSON.stringify({ operation: ATTEMPT_OPERATION, arguments: { course_id: 2, module_id: 8, attempt_id: 41 }, binding: { origin, siteUrl: `${origin}/`, principalId: "3", courseId: "2" }, expiresAt: Date.now() - 1 }),
    );
    assert.deepEqual(expired, { ok: false, sent: false, error: "moodle_quiz_attempt_arguments_invalid" });

    const allowed = ["/course/view.php", "/mod/quiz/report.php", "/favicon.ico"];
    assert.deepEqual([...new Set(requests.map((entry) => entry.pathname))].filter((path) => !allowed.includes(path)), []);
  } finally {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
});
