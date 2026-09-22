import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import {
  executeMoodleGradeReportSummaryInPage,
  executeMoodleLearnerGradeReportInPage,
} from "../../connector/extension/src/moodle-grade-report-read.js";

const SUMMARY_OPERATION = Object.freeze({
  key: "moodle.form.grade.report.summary.read.v1",
  toolName: "moodle_get_grade_report_summary",
  provider: "moodle",
  readOnly: true,
});
const REPORT_OPERATION = Object.freeze({
  key: "moodle.form.grade.report.learner.read.v1",
  toolName: "moodle_get_learner_grade_report",
  provider: "moodle",
  readOnly: true,
});
const CAPABILITIES = ["gradereport/grader:view", "moodle/grade:viewall"];

test("Moodle grader report reads are cataloged and routed through the extension worker", () => {
  const root = new URL("../..", import.meta.url);
  const catalog = JSON.parse(readFileSync(new URL("connector/extension/generated/moodle-browser-catalog.json", root), "utf8"));
  for (const [key, toolName] of [
    ["moodle.form.grade.report.summary.read.v1", "moodle_get_grade_report_summary"],
    ["moodle.form.grade.report.learner.read.v1", "moodle_get_learner_grade_report"],
  ]) {
    const entries = catalog.operations.filter((entry) => entry.key === key);
    assert.equal(entries.length, 1, `${key} must be cataloged exactly once`);
    assert.equal(entries[0].toolName, toolName);
    assert.equal(entries[0].provider, "moodle");
    assert.equal(entries[0].readOnly, true);
    assert.equal(entries[0].dataClass, "learner");
    // Both capabilities must be stated before an assistant calls either read.
    for (const capability of CAPABILITIES) assert.ok(entries[0].description.includes(capability), `${toolName} must state ${capability}`);
  }
  const worker = readFileSync(new URL("connector/extension/src/service-worker.js", root), "utf8");
  assert.match(worker, /import \{ executeMoodleGradeReportSummaryInPage, executeMoodleLearnerGradeReportInPage \} from "\.\/moodle-grade-report-read\.js";/);
  assert.match(worker, /MOODLE_GRADE_REPORT_SUMMARY_OPERATION_KEY = "moodle\.form\.grade\.report\.summary\.read\.v1"/);
  assert.match(worker, /MOODLE_LEARNER_GRADE_REPORT_OPERATION_KEY = "moodle\.form\.grade\.report\.learner\.read\.v1"/);
  assert.match(worker, /func: executeMoodleGradeReportSummaryInPage/);
  assert.match(worker, /func: executeMoodleLearnerGradeReportInPage/);
});

test("Moodle grader report reads bind one course and keep every grade value out of the summary", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morrow-moodle-grade-report-"));
  const key = join(directory, "key.pem");
  const certificate = join(directory, "certificate.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", certificate], { stdio: "ignore" });
  const PRIVATE_SESSION = "moodle-private-session";
  const requests = [];
  let origin = "";
  let mode = "complete";
  let browser;

  // Markup from the Moodle 5.2.2 grader report: one merged table#user-grades
  // whose grade-item headers carry data-itemid, whose range row carries class
  // "range" and a .rangevalues cell per item, and whose learner rows carry
  // data-uid with one td.gradecell#u<uid>i<itemid> per item.
  // https://github.com/moodle/moodle/blob/v5.2.2/public/grade/report/grader/lib.php
  const COLUMNS = [{ id: 200, type: "item" }, { id: 201, type: "item" }, { id: 300, type: "courseitem" }];
  const RANGES = [{ id: 200, text: "0.00–100.00" }, { id: 201, text: "0.00–50.00" }, { id: 300, text: "0.00–150.00" }];
  const PAGES = [
    [{ uid: 7, values: ["80.00 %", "25.00", "105.00"] }, { uid: 8, values: ["40.00 %", "-", "-"] }],
    [{ uid: 9, values: ["60.00 %", "10.00", "-"] }],
  ];
  const headerRow = (columns) => `<tr class="heading"><th class="header c0 user" scope="col">First name / Surname</th>${
    columns.map((column) => `<th class="${column.type} cat_1 highlightable i${column.id}" data-itemid="${column.id}" scope="col">Item ${column.id}</th>`).join("")
  }</tr>`;
  const rangeRow = (ranges) => `<tr class="range r0"><th class="header range" scope="row">Range</th>${
    ranges.map((range) => `<td class="range i${range.id}" data-itemid="${range.id}"><div class="rangevalues" data-collapse="rangerowcell">${range.text}</div></td>`).join("")
  }</tr>`;
  const gradeCell = (uid, itemId, value) => `<td class="gradecell" data-itemid="${itemId}" id="u${uid}i${itemId}">${
    value === null ? "<span>2 September 2026, 9:07 AM</span>" : `<span class="gradevalue">${value}</span>`
  }</td>`;
  const learnerRow = (row, columns) => `<tr class="userrow even" data-uid="${row.uid}"><th class="user" scope="row">Learner ${row.uid} Moodle</th>${
    columns.map((column, index) => gradeCell(row.uid, mode === "mismatched-cell" && row.uid === 7 && index === 0 ? 999 : column.id, row.values[index])).join("")
  }</tr>`;
  const table = (columns, ranges, rows) => `<!doctype html><html><body class="path-grade course-2"><script>var M = ${
    JSON.stringify({ cfg: { wwwroot: origin, sesskey: PRIVATE_SESSION, userId: 3, courseId: 2 } })
  };</script><table id="user-grades" class="table gradereport-grader-table"><thead>${headerRow(columns)}</thead><tbody>${rangeRow(ranges)}${
    rows.map((row) => learnerRow(row, columns)).join("")
  }<tr class="avg"><th class="header" scope="row">Overall average</th>${
    columns.map((column) => `<td class="avg" data-itemid="${column.id}">62.50</td>`).join("")
  }</tr></tbody></table></body></html>`;
  let cappedParticipants = "";
  const overParticipants = () => {
    if (!cappedParticipants) {
      cappedParticipants = table([COLUMNS[0]], [RANGES[0]], Array.from({ length: 10_001 }, (_, index) => ({ uid: index + 1, values: ["-"] })));
    }
    return cappedParticipants;
  };
  const body = (pageIndex) => {
    if (mode === "no-table") return "<!doctype html><html><body class=\"course-2\"><p>Nothing here</p></body></html>";
    if (mode === "duplicate-column") return table([COLUMNS[0], COLUMNS[0], COLUMNS[2]], RANGES, PAGES[pageIndex] || []);
    if (mode === "over-items") return table(Array.from({ length: 501 }, (_, index) => ({ id: 1_000 + index, type: "item" })), [], []);
    if (mode === "over-participants") return overParticipants();
    // A report that never returns a short page: every page is full, so the scan
    // runs out of page requests before it reaches the report's own last page.
    if (mode === "endless") {
      return table(COLUMNS, RANGES, [
        { uid: pageIndex * 2 + 1, values: ["80.00 %", "25.00", "105.00"] },
        { uid: pageIndex * 2 + 2, values: ["40.00 %", "-", "-"] },
      ]);
    }
    if (mode === "changed-columns" && pageIndex > 0) return table([COLUMNS[0], COLUMNS[1]], RANGES, PAGES[pageIndex]);
    const rows = (PAGES[pageIndex] || []).map((row) => (mode === "unreadable" && row.uid === 8
      ? { ...row, values: [null, row.values[1], row.values[2]] }
      : row));
    return table(COLUMNS, RANGES, rows);
  };

  const server = createServer({ key: readFileSync(key), cert: readFileSync(certificate) }, (request, response) => {
    const target = new URL(request.url || "/", origin);
    requests.push({ method: request.method, pathname: target.pathname, search: target.search });
    // The oversize case cancels the body read, which resets this socket.
    request.on("error", () => {});
    response.on("error", () => {});
    if (target.pathname === "/course/view.php") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<!doctype html><html><body class="path-course course-2"><script>var M = ${JSON.stringify({ cfg: { wwwroot: origin, sesskey: PRIVATE_SESSION, userId: 3, courseId: 2 } })};</script></body></html>`);
      return;
    }
    if (request.method === "GET" && target.pathname === "/grade/report/grader/index.php") {
      const pageIndex = Number(target.searchParams.get("page"));
      response.writeHead(200, { "content-type": "text/html" });
      if (mode === "oversize") {
        response.write(`<!doctype html><html><body><!--${"x".repeat(2 * 1024 * 1024 + 4_096)}-->`);
        response.end("</body></html>");
        return;
      }
      response.end(body(pageIndex));
      return;
    }
    response.writeHead(404).end();
  });

  try {
    await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", (error) => (error ? reject(error) : resolve())));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");
    origin = `https://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
    const page = await browser.newPage({ ignoreHTTPSErrors: true });
    await page.goto(`${origin}/course/view.php?id=2`);
    const call = (func, operation, args, expiresAt = Date.now() + 60_000) => page.evaluate(
      func,
      JSON.stringify({ operation, arguments: args, binding: { origin, siteUrl: `${origin}/`, principalId: "3", courseId: "2" }, expiresAt }),
    );
    const summary = (args = { course_id: 2 }, expiresAt) => call(executeMoodleGradeReportSummaryInPage, SUMMARY_OPERATION, args, expiresAt);
    const report = (args = { course_id: 2, user_id: 7 }, expiresAt) => call(executeMoodleLearnerGradeReportInPage, REPORT_OPERATION, args, expiresAt);
    const reportRequests = () => requests.filter((entry) => entry.pathname === "/grade/report/grader/index.php").length;

    const beforeInvalid = reportRequests();
    assert.deepEqual(await summary({ course_id: 2, extra: true }), { ok: false, sent: false, error: "moodle_grade_report_summary_arguments_invalid" });
    assert.deepEqual(await summary({ course_id: 9 }), { ok: false, sent: false, error: "moodle_grade_report_summary_arguments_invalid" });
    assert.deepEqual(await summary({ course_id: 2 }, Date.now() - 1), { ok: false, sent: false, error: "moodle_grade_report_summary_arguments_invalid" });
    assert.deepEqual(await report({ course_id: 2 }), { ok: false, sent: false, error: "moodle_learner_grade_report_arguments_invalid" });
    assert.deepEqual(await report({ course_id: 2, user_id: 0 }), { ok: false, sent: false, error: "moodle_learner_grade_report_arguments_invalid" });
    assert.equal(reportRequests(), beforeInvalid, "a refused argument set must reach no Moodle route");

    const aggregate = await summary();
    assert.equal(aggregate.ok, true, JSON.stringify(aggregate));
    assert.equal(aggregate.complete, true);
    assert.match(aggregate.snapshot_digest, /^[0-9a-f]{64}$/);
    assert.deepEqual(aggregate.data, {
      schema: "morrow.moodle-grade-report-summary.v1",
      provider: "moodle",
      course_id: 2,
      participant_count: 3,
      grade_item_count: 3,
      items: [
        { item_id: 200, kind: "item", graded_count: 3, ungraded_count: 0, unreadable_count: 0, percent_source: "percentage_display", statistics: { mean: "60-79", median: "60-79", minimum: "40-59", maximum: "80-100" }, statistics_unavailable: null },
        { item_id: 201, kind: "item", graded_count: 2, ungraded_count: 1, unreadable_count: 0, percent_source: "range_row", statistics: { mean: "20-39", median: "20-39", minimum: "20-39", maximum: "40-59" }, statistics_unavailable: null },
        { item_id: 300, kind: "course_total", graded_count: 1, ungraded_count: 2, unreadable_count: 0, percent_source: "range_row", statistics: { mean: "60-79", median: "60-79", minimum: "60-79", maximum: "60-79" }, statistics_unavailable: null },
      ],
      proof: {
        method: "grade_report_grader_index",
        complete: true,
        required_capabilities: CAPABILITIES,
        participant_limit: 10_000,
        participant_response_rows: 3,
        grade_item_limit: 500,
        page_size: 2,
        page_request_limit: 500,
        page_request_count: 2,
      },
    });
    const aggregateText = JSON.stringify(aggregate);
    for (const privateValue of [PRIVATE_SESSION, "Learner 7 Moodle", "Learner 8 Moodle", "Learner 9 Moodle", "data-uid", "u7i200", "80.00", "25.00", "105.00", "62.50", "user_id"]) {
      assert.equal(aggregateText.includes(privateValue), false, `the summary leaked ${privateValue}`);
    }

    const first = await report();
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.deepEqual(first.data, {
      schema: "morrow.moodle-learner-grade-report.v1",
      provider: "moodle",
      course_id: 2,
      learner: { user_id: "7" },
      grade_item_count: 3,
      items: [
        { item_id: 200, kind: "item", state: "graded", percent: 80, percent_source: "percentage_display" },
        { item_id: 201, kind: "item", state: "graded", percent: 50, percent_source: "range_row" },
        { item_id: 300, kind: "course_total", state: "graded", percent: 70, percent_source: "range_row" },
      ],
      proof: {
        method: "grade_report_grader_index",
        complete: true,
        required_capabilities: CAPABILITIES,
        participant_limit: 10_000,
        grade_item_limit: 500,
        page_request_limit: 500,
        page_request_count: 1,
      },
    });
    const firstText = JSON.stringify(first);
    for (const privateValue of [PRIVATE_SESSION, "Learner 7 Moodle", "80.00", "25.00", "105.00", "62.50"]) {
      assert.equal(firstText.includes(privateValue), false, `the learner report leaked ${privateValue}`);
    }

    const paged = await report({ course_id: 2, user_id: 9 });
    assert.equal(paged.ok, true, JSON.stringify(paged));
    assert.equal(paged.data.proof.page_request_count, 2, "a learner on the second page needs the second page");
    assert.deepEqual(paged.data.items[2], { item_id: 300, kind: "course_total", state: "ungraded", percent: null, percent_source: null });

    assert.deepEqual(await report({ course_id: 2, user_id: 99 }), { ok: false, sent: false, error: "moodle_learner_grade_report_learner_unavailable" });

    // Every request stays on the read-only route. `perpage`, `toggle`,
    // `sifirst`, `silast`, `edit`, and `target`+`action` are the grader-report
    // branches that write a preference, the session, or a grade.
    const graderRequests = requests.filter((entry) => entry.pathname === "/grade/report/grader/index.php");
    assert.ok(graderRequests.length > 0);
    for (const entry of graderRequests) {
      assert.equal(entry.method, "GET");
      assert.match(entry.search, /^\?id=2&page=[0-9]+$/);
    }
    assert.equal(requests.some((entry) => entry.method !== "GET"), false, "the grader report reads send no POST");
    assert.equal(requests.some((entry) => /^\/(?:mod|user)\//.test(entry.pathname) || entry.pathname.startsWith("/grade/edit/")), false);

    mode = "unreadable";
    const withUnreadable = await summary();
    assert.equal(withUnreadable.ok, true, JSON.stringify(withUnreadable));
    assert.deepEqual(withUnreadable.data.items[0], {
      item_id: 200, kind: "item", graded_count: 2, ungraded_count: 0, unreadable_count: 1,
      percent_source: null, statistics: null, statistics_unavailable: "unreadable_cells",
    });

    mode = "no-table";
    assert.deepEqual(await summary(), { ok: false, sent: false, error: "moodle_grade_report_summary_response_invalid" });
    assert.deepEqual(await report(), { ok: false, sent: false, error: "moodle_learner_grade_report_response_invalid" });
    mode = "duplicate-column";
    assert.deepEqual(await summary(), { ok: false, sent: false, error: "moodle_grade_report_summary_response_invalid" });
    mode = "mismatched-cell";
    assert.deepEqual(await summary(), { ok: false, sent: false, error: "moodle_grade_report_summary_response_invalid" });
    assert.deepEqual(await report(), { ok: false, sent: false, error: "moodle_learner_grade_report_response_invalid" });
    mode = "changed-columns";
    assert.deepEqual(await summary(), { ok: false, sent: false, error: "moodle_grade_report_summary_response_changed" });
    assert.deepEqual(await report({ course_id: 2, user_id: 9 }), { ok: false, sent: false, error: "moodle_learner_grade_report_response_changed" });

    mode = "over-items";
    assert.deepEqual(await summary(), { ok: false, sent: false, complete: false, error: "moodle_grade_report_summary_incomplete" });
    assert.deepEqual(await report(), { ok: false, sent: false, complete: false, error: "moodle_learner_grade_report_incomplete" });
    mode = "over-participants";
    assert.deepEqual(await summary(), { ok: false, sent: false, complete: false, error: "moodle_grade_report_summary_incomplete" });
    assert.deepEqual(await report({ course_id: 2, user_id: 99 }), { ok: false, sent: false, complete: false, error: "moodle_learner_grade_report_incomplete" });
    mode = "oversize";
    assert.deepEqual(await summary(), { ok: false, sent: false, complete: false, error: "moodle_grade_report_summary_incomplete" });
    assert.deepEqual(await report(), { ok: false, sent: false, complete: false, error: "moodle_learner_grade_report_incomplete" });
    mode = "endless";
    // A scan that never reaches the report's own last page is incomplete. It is
    // not a whole-course count, and it is not proof that a learner is absent.
    const beforeEndless = reportRequests();
    assert.deepEqual(await summary(), { ok: false, sent: false, complete: false, error: "moodle_grade_report_summary_incomplete" });
    assert.equal(reportRequests() - beforeEndless, 500, "the summary stops at its own page-request bound");
    assert.deepEqual(await report({ course_id: 2, user_id: 99_999 }), { ok: false, sent: false, complete: false, error: "moodle_learner_grade_report_incomplete" });
  } finally {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
});
