import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { executeMoodleCourseReportReadInPage } from "../../connector/extension/src/moodle-reports-read.js";

const READS = [
  { key: "moodle.form.report.activity.read.v1", tool: "moodle_get_course_activity_report", capability: "report/outline:view" },
  { key: "moodle.form.report.participation.read.v1", tool: "moodle_get_course_participation_report", capability: "report/participation:view" },
  { key: "moodle.form.report.completion.read.v1", tool: "moodle_get_course_completion_report", capability: "report/progress:view" },
  { key: "moodle.form.report.log_summary.read.v1", tool: "moodle_get_course_log_summary", capability: "report/log:view" },
  { key: "moodle.form.report.dates.read.v1", tool: "moodle_get_course_dates_report", capability: null },
];
const operationFor = (entry) => Object.freeze({ key: entry.key, toolName: entry.tool, provider: "moodle", readOnly: true });

test("the Moodle course-report reads are cataloged and routed through the extension worker", () => {
  const root = new URL("../..", import.meta.url);
  const catalog = JSON.parse(readFileSync(new URL("connector/extension/generated/moodle-browser-catalog.json", root), "utf8"));
  for (const entry of READS) {
    const entries = catalog.operations.filter((operation) => operation.key === entry.key);
    assert.equal(entries.length, 1, `${entry.key} must be cataloged exactly once`);
    assert.equal(entries[0].toolName, entry.tool);
    assert.equal(entries[0].provider, "moodle");
    assert.equal(entries[0].readOnly, true);
    assert.equal(entries[0].dataClass, "learner");
    assert.equal(entries[0].inputSchema.additionalProperties, false);
    if (entry.capability) {
      assert.ok(entries[0].description.includes(entry.capability), `${entry.tool} must state ${entry.capability}`);
    } else {
      // Moodle ships no core dates report, so the description must say that
      // rather than imply a report capability admits the read.
      assert.ok(entries[0].description.includes("no core dates report"), `${entry.tool} must state that Moodle ships no core dates report`);
    }
  }
  const logEntry = catalog.operations.find((operation) => operation.toolName === "moodle_get_course_log_summary");
  for (const stated of ["IP address", "user agent"]) {
    assert.ok(logEntry.description.includes(stated), `the log summary description must state the ${stated} boundary`);
  }
  const worker = readFileSync(new URL("connector/extension/src/service-worker.js", root), "utf8");
  assert.match(worker, /import \{ executeMoodleCourseReportReadInPage \} from "\.\/moodle-reports-read\.js";/);
  assert.match(worker, /const MOODLE_COURSE_REPORT_READ_OPERATIONS = new Map\(\[/);
  assert.match(worker, /func: executeMoodleCourseReportReadInPage/);
  for (const entry of READS) assert.ok(worker.includes(`["${entry.key}", { toolName: "${entry.tool}"`), `${entry.key} must be routed`);
});

test("the Moodle course-report reads bind one course, aggregate by default, and strip every log identity", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morrow-moodle-reports-"));
  const key = join(directory, "key.pem");
  const certificate = join(directory, "certificate.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", certificate], { stdio: "ignore" });
  const PRIVATE_SESSION = "moodle-private-session";
  const PRIVATE_IP = "203.0.113.44";
  const PRIVATE_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";
  const PRIVATE_NAME = "Jane Learner";
  const PRIVATE_EMAIL = "jane.learner@example.edu";
  const PRIVATE_DESCRIPTION = "The user with id '9' viewed the course with id '2'.";
  const requests = [];
  let origin = "";
  let mode = "complete";
  let browser;

  // Markup from Moodle 5.2.2. The outline report renders one merged
  // table#outlinereport whose activity rows carry td.cell.activityname and
  // td.cell.numviews.
  // https://github.com/moodle/moodle/blob/v5.2.2/public/report/outline/templates/activity.mustache
  const outlineRow = (moduleId, modname, views) => `<tr class="activity-row"><td class="cell activityname"><div class="d-flex"><a href="/mod/${modname}/view.php?id=${moduleId}">${modname} ${moduleId}</a></div></td><td class="cell numviews">${views}</td><td class="cell lastaccess">2 September 2026, 9:07 AM</td></tr>`;
  const outlineBody = () => {
    if (mode === "outline-missing-table") return "<!doctype html><html><body><p>Nothing here</p></body></html>";
    const rows = mode === "outline-unreadable"
      ? [outlineRow(77, "quiz", "many"), outlineRow(78, "assign", "-")]
      : [outlineRow(77, "quiz", "12"), outlineRow(78, "assign", "-"), outlineRow(79, "forum", "5")];
    return `<!doctype html><html><body><table id="outlinereport" class="generaltable boxaligncenter"><thead><tr><th class="header font-lg" scope="col">Activity</th><th class="header font-lg" scope="col">Views</th><th class="header font-lg" scope="col">Last access</th></tr></thead><tbody><tr class="section"><td class="cell lastcol" colspan="3"><h3>General</h3></td></tr>${rows.join("")}</tbody></table></body></html>`;
  };

  // The participation report renders one table whose id names the course, the
  // course module and the role, whose first column links the person's profile
  // and whose second column holds the localized yes-string plus " (<count>) ".
  // https://github.com/moodle/moodle/blob/v5.2.2/public/report/participation/index.php
  const PARTICIPATION_PAGES = [[{ uid: 9, count: 3 }, { uid: 10, count: 0 }], [{ uid: 11, count: 1 }]];
  const participationRow = (row) => `<tr class="userrow"><td class="cell c0"><a href="/user/view.php?id=${row.uid}&amp;course=2">${PRIVATE_NAME} ${row.uid}</a></td><td class="cell c1">${row.count > 0 ? `Yes (${row.count}) ` : "No"}</td></tr>`;
  const participationBody = (pageIndex) => {
    if (mode === "participation-endless") {
      return participationTable([{ uid: pageIndex * 2 + 20, count: 1 }, { uid: pageIndex * 2 + 21, count: 0 }]);
    }
    return participationTable(PARTICIPATION_PAGES[pageIndex] || []);
  };
  const participationTable = (rows) => `<!doctype html><html><body><table id="course-participation-2-77-5" class="table generaltable reporttable"><thead><tr><th class="header c0">User name</th><th class="header c1">All actions</th></tr></thead><tbody>${rows.map(participationRow).join("")}</tbody></table></body></html>`;

  // The activity completion report renders table#completion-progress, with one
  // th.completion-header per tracked activity and one td.completion-progresscell
  // per person and activity. The toggle carries "<userid>-<cmid>-<newstate>".
  // https://github.com/moodle/moodle/blob/v5.2.2/public/report/progress/index.php
  const COMPLETION_COLUMNS = [{ moduleId: 77, modname: "quiz" }, { moduleId: 78, modname: "assign" }];
  const COMPLETION_PAGES = [
    [{ uid: 9, states: [1, 0] }, { uid: 10, states: [0, null] }],
    [{ uid: 11, states: [1, 1] }],
  ];
  const completionCell = (uid, column, state) => `<td class="completion-progresscell">${
    state === null
      ? "<i class=\"icon fa fa-circle\" role=\"img\" aria-label=\"Completed (achieved pass grade)\"></i>"
      : `<a class="changecompl" data-changecompl="${uid}-${column.moduleId}-${state === 1 ? 0 : 1}" data-activityname="${column.modname}" data-userfullname="${PRIVATE_NAME} ${uid}" data-completiontracking="manual" role="button"><i class="icon fa fa-circle-o"></i></a>`
  }</td>`;
  const completionTable = (columns, rows) => `<!doctype html><html><body><div id="completion-progress-wrapper" class="no-overflow"><table id="completion-progress" class="table generaltable flexible"><thead><tr><th scope="col" class="completion-sortchoice">First name / Surname</th>${
    columns.map((column) => `<th scope="col" class="completion-header"><a href="/mod/${column.modname}/view.php?id=${column.moduleId}"><div class="rotated-text-container"><span class="rotated-text">${column.modname}</span></div></a></th>`).join("")
  }</tr></thead><tbody>${
    rows.map((row) => `<tr><th scope="row"><a href="/user/view.php?id=${row.uid}&amp;course=2">${PRIVATE_NAME} ${row.uid}</a></th>${
      columns.map((column, index) => completionCell(row.uid, column, row.states[index])).join("")
    }</tr>`).join("")
  }</tbody></table></div></body></html>`;
  const completionBody = (pageIndex) => {
    if (mode === "completion-changed" && pageIndex > 0) return completionTable([COMPLETION_COLUMNS[0]], COMPLETION_PAGES[pageIndex]);
    return completionTable(COMPLETION_COLUMNS, COMPLETION_PAGES[pageIndex] || []);
  };

  // The course log table ends in the fixed order context, component, event
  // name, description, origin, IP address.
  // https://github.com/moodle/moodle/blob/v5.2.2/public/report/log/classes/table_log.php
  const LOG_PAGES = [
    [
      { context: "<a href=\"/mod/quiz/view.php?id=77\">Quiz: Week 1</a>", origin: "web" },
      { context: "<a href=\"/course/view.php?id=2\">Course: Biology</a>", origin: "web" },
      { context: "<a href=\"/mod/quiz/view.php?id=77\">Quiz: Week 1</a>", origin: "ws" },
    ],
    [{ context: "Other", origin: "restore" }],
  ];
  const logRow = (row) => `<tr><td class="cell c0">2 September 2026, 9:07 AM</td><td class="cell c1"><a href="/user/view.php?id=9&amp;course=2">${PRIVATE_NAME}</a> (${PRIVATE_EMAIL})</td><td class="cell c2">-</td><td class="cell c3">${row.context}</td><td class="cell c4">System</td><td class="cell c5">Course viewed</td><td class="cell c6">${PRIVATE_DESCRIPTION}</td><td class="cell c7">${row.origin}</td><td class="cell c8"><a href="/iplookup/index.php?ip=${PRIVATE_IP}&amp;user=9" title="${PRIVATE_AGENT}">${PRIVATE_IP}</a></td></tr>`;
  const logBody = (pageIndex) => {
    if (mode === "log-short-row") {
      return `<!doctype html><html><body><table class="reportlog generaltable table table-sm"><tbody><tr><td class="cell c0">2 September 2026</td><td class="cell c1">${PRIVATE_IP}</td></tr></tbody></table></body></html>`;
    }
    return `<!doctype html><html><body><table class="reportlog generaltable table table-sm"><thead><tr><th class="header c0">Time</th></tr></thead><tbody>${(LOG_PAGES[pageIndex] || []).map(logRow).join("")}</tbody></table></body></html>`;
  };

  // The course calendar month view. A course event has no module; an activity
  // event names one; a user event belongs to a person and is never returned.
  // https://github.com/moodle/moodle/blob/v5.2.2/public/calendar/externallib.php
  let calendarCall = 0;
  const calendarEvents = () => (calendarCall++ === 0
    ? [
      // Moodle's month grid repeats a multi-day entry, so 501 appears twice.
      { id: 501, name: "Quiz 1 closes", eventtype: "close", modulename: "quiz", timestart: 1_788_000_000, url: `${origin}/mod/quiz/view.php?id=77`, userid: 9, description: PRIVATE_DESCRIPTION },
      { id: 501, name: "Quiz 1 closes", eventtype: "close", modulename: "quiz", timestart: 1_788_000_000, url: `${origin}/mod/quiz/view.php?id=77`, userid: 9, description: PRIVATE_DESCRIPTION },
      { id: 502, name: "Term starts", eventtype: "course", modulename: null, timestart: 1_787_000_000, url: `${origin}/course/view.php?id=2`, description: "" },
      { id: 503, name: `${PRIVATE_NAME} reminder`, eventtype: "user", modulename: null, timestart: 1_787_500_000, url: `${origin}/calendar/view.php`, userid: 9 },
    ]
    : [{ id: 504, name: "Assignment 1 is due", eventtype: "due", modulename: "assign", timestart: 1_790_000_000, url: `${origin}/mod/assign/view.php?id=78`, userid: 9 }]);
  const calendarPayload = () => {
    if (mode === "dates-exception") return [{ error: true, exception: { message: "Invalid parameter" } }];
    if (mode === "dates-invalid") return [{ error: false, data: { weeks: [{ days: [{ events: [{ id: 0 }] }] }] } }];
    return [{ error: false, data: { weeks: [{ days: [{ events: calendarEvents() }] }] } }];
  };

  const server = createServer({ key: readFileSync(key), cert: readFileSync(certificate) }, (request, response) => {
    const target = new URL(request.url || "/", origin);
    requests.push({ method: request.method, pathname: target.pathname, search: target.search });
    request.on("error", () => {});
    response.on("error", () => {});
    if (target.pathname === "/course/view.php") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<!doctype html><html><body class="path-course course-2"><script>var M = ${JSON.stringify({ cfg: { wwwroot: origin, sesskey: PRIVATE_SESSION, userId: 3, courseId: 2 } })};</script></body></html>`);
      return;
    }
    if (request.method === "GET" && mode === "oversize") {
      response.writeHead(200, { "content-type": "text/html" });
      response.write(`<!doctype html><html><body><!--${"x".repeat(2 * 1024 * 1024 + 4_096)}-->`);
      response.end("</body></html>");
      return;
    }
    const page = Number(target.searchParams.get("page"));
    if (request.method === "GET" && target.pathname === "/report/outline/index.php") {
      response.writeHead(200, { "content-type": "text/html" }).end(outlineBody());
      return;
    }
    if (request.method === "GET" && target.pathname === "/report/participation/index.php") {
      response.writeHead(200, { "content-type": "text/html" }).end(participationBody(page));
      return;
    }
    if (request.method === "GET" && target.pathname === "/report/progress/index.php") {
      response.writeHead(200, { "content-type": "text/html" }).end(completionBody(page));
      return;
    }
    if (request.method === "GET" && target.pathname === "/report/log/index.php") {
      response.writeHead(200, { "content-type": "text/html" }).end(logBody(page));
      return;
    }
    if (request.method === "POST" && target.pathname === "/lib/ajax/service.php") {
      let body = "";
      request.on("data", (chunk) => { body += String(chunk); });
      request.on("end", () => {
        let parsed;
        try { parsed = JSON.parse(body); } catch { parsed = null; }
        // The read must ask for the calendar month view and nothing else.
        assert.equal(Array.isArray(parsed) && parsed.length === 1 && parsed[0].methodname, "core_calendar_get_calendar_monthly_view");
        assert.equal(parsed[0].args.courseid, 2);
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(calendarPayload()));
      });
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
    const call = (entry, args, expiresAt = Date.now() + 60_000) => page.evaluate(
      executeMoodleCourseReportReadInPage,
      JSON.stringify({
        operation: operationFor(entry),
        arguments: args,
        binding: { origin, siteUrl: `${origin}/`, principalId: "3", courseId: "2" },
        expiresAt,
      }),
    );
    const [activity, participation, completion, log, dates] = READS;
    const reportRequests = () => requests.filter((request) => request.pathname.startsWith("/report/") || request.pathname === "/lib/ajax/service.php").length;

    const beforeInvalid = reportRequests();
    assert.deepEqual(await call(activity, { course_id: 2, extra: true }), { ok: false, sent: false, error: "moodle_course_activity_report_arguments_invalid" });
    assert.deepEqual(await call(activity, { course_id: 9 }), { ok: false, sent: false, error: "moodle_course_activity_report_arguments_invalid" });
    assert.deepEqual(await call(activity, { course_id: 2 }, Date.now() - 1), { ok: false, sent: false, error: "moodle_course_activity_report_arguments_invalid" });
    assert.deepEqual(await call(participation, { course_id: 2, module_id: 77, action: "read", since_days: 30 }), { ok: false, sent: false, error: "moodle_course_participation_report_arguments_invalid" });
    assert.deepEqual(await call(participation, { course_id: 2, module_id: 77, action: "view", since_days: 366 }), { ok: false, sent: false, error: "moodle_course_participation_report_arguments_invalid" });
    assert.deepEqual(await call(dates, { course_id: 2, year: 2026, month: 9, months: 13 }), { ok: false, sent: false, error: "moodle_course_dates_report_arguments_invalid" });
    assert.deepEqual(await call(dates, { course_id: 2, months: 2 }), { ok: false, sent: false, error: "moodle_course_dates_report_arguments_invalid" });
    assert.deepEqual(
      await page.evaluate(executeMoodleCourseReportReadInPage, JSON.stringify({
        operation: { key: "moodle.form.report.unknown.read.v1", toolName: "moodle_get_course_activity_report", provider: "moodle", readOnly: true },
        arguments: { course_id: 2 }, binding: { origin, siteUrl: `${origin}/`, principalId: "3", courseId: "2" }, expiresAt: Date.now() + 60_000,
      })),
      { ok: false, sent: false, error: "moodle_course_report_operation_refused" },
    );
    assert.equal(reportRequests(), beforeInvalid, "a refused argument set must reach no Moodle route");

    const outline = await call(activity, { course_id: 2 });
    assert.equal(outline.ok, true, JSON.stringify(outline));
    assert.match(outline.snapshot_digest, /^[0-9a-f]{64}$/);
    assert.deepEqual(outline.data, {
      schema: "morrow.moodle-course-activity-report.v1",
      provider: "moodle",
      course_id: 2,
      activity_count: 3,
      total_view_count: 17,
      unreadable_count: 0,
      activities: [
        { module_id: 77, modname: "quiz", view_count: 12 },
        { module_id: 78, modname: "assign", view_count: null },
        { module_id: 79, modname: "forum", view_count: 5 },
      ],
      proof: {
        method: "report_outline_index",
        complete: true,
        required_capability: "report/outline:view",
        activity_limit: 500,
        response_byte_limit: 2 * 1024 * 1024,
        request_count: 1,
      },
    });

    const aggregate = await call(participation, { course_id: 2, module_id: 77, action: "view", since_days: 30 });
    assert.equal(aggregate.ok, true, JSON.stringify(aggregate));
    assert.deepEqual(aggregate.data.participants, [], "the participation report names nobody by default");
    assert.equal(aggregate.data.includes_participants, false);
    assert.equal(aggregate.data.participant_count, 3);
    assert.equal(aggregate.data.performed_count, 2);
    assert.equal(aggregate.data.not_performed_count, 1);
    assert.equal(aggregate.data.total_action_count, 4);
    assert.equal(aggregate.data.role_id, 5);
    assert.equal(aggregate.data.since_days, 30);
    assert.deepEqual(aggregate.data.proof, {
      method: "report_participation_index",
      complete: true,
      required_capability: "report/participation:view",
      participant_limit: 5_000,
      page_size: 2,
      page_request_limit: 100,
      page_request_count: 2,
    });
    for (const privateValue of [PRIVATE_SESSION, PRIVATE_NAME, "user_id", "/user/view.php"]) {
      assert.equal(JSON.stringify(aggregate).includes(privateValue), false, `the aggregate participation report leaked ${privateValue}`);
    }

    const named = await call(participation, { course_id: 2, module_id: 77, action: "view", since_days: 30, include_participants: true });
    assert.equal(named.ok, true, JSON.stringify(named));
    assert.equal(named.data.includes_participants, true);
    // The identity leaves the page only as the Moodle user ID, which the MCP
    // runtime projects through the complete course participant roster.
    assert.deepEqual(named.data.participants, [
      { user_id: "9", action_count: 3 },
      { user_id: "10", action_count: 0 },
      { user_id: "11", action_count: 1 },
    ]);
    assert.equal(JSON.stringify(named).includes(PRIVATE_NAME), false, "the named participation report leaked a learner name");

    const progress = await call(completion, { course_id: 2 });
    assert.equal(progress.ok, true, JSON.stringify(progress));
    assert.deepEqual(progress.data.activities, [
      { module_id: 77, modname: "quiz", complete_count: 2, incomplete_count: 1, unreadable_count: 0 },
      { module_id: 78, modname: "assign", complete_count: 1, incomplete_count: 1, unreadable_count: 1 },
    ]);
    assert.equal(progress.data.participant_count, 3);
    assert.deepEqual(progress.data.proof, {
      method: "report_progress_index",
      complete: true,
      required_capability: "report/progress:view",
      participant_limit: 5_000,
      activity_limit: 500,
      page_size: 2,
      page_request_limit: 200,
      page_request_count: 2,
    });
    for (const privateValue of [PRIVATE_NAME, "user_id", "data-changecompl", "9-77-0"]) {
      assert.equal(JSON.stringify(progress).includes(privateValue), false, `the completion report leaked ${privateValue}`);
    }

    const summary = await call(log, { course_id: 2 });
    assert.equal(summary.ok, true, JSON.stringify(summary));
    assert.deepEqual(summary.data, {
      schema: "morrow.moodle-course-log-summary.v1",
      provider: "moodle",
      course_id: 2,
      entry_count: 4,
      course_context_count: 1,
      other_context_count: 1,
      origin_counts: { web: 2, ws: 1, cli: 0, restore: 1, other: 0 },
      activity_counts: [{ module_id: 77, modname: "quiz", count: 2 }],
      proof: {
        method: "report_log_index",
        complete: true,
        required_capability: "report/log:view",
        entry_limit: 5_000,
        page_size: 3,
        page_request_limit: 50,
        page_request_count: 2,
        omitted_columns: ["time", "user", "related_user", "component", "event_name", "description", "ip_address", "user_agent"],
      },
    });
    const summaryText = JSON.stringify(summary);
    for (const privateValue of [PRIVATE_IP, PRIVATE_AGENT, PRIVATE_NAME, PRIVATE_EMAIL, PRIVATE_DESCRIPTION, "iplookup", "Course viewed"]) {
      assert.equal(summaryText.includes(privateValue), false, `the log summary leaked ${privateValue}`);
    }

    const calendar = await call(dates, { course_id: 2, year: 2026, month: 9, months: 2 });
    assert.equal(calendar.ok, true, JSON.stringify(calendar));
    assert.deepEqual(calendar.data.month_counts, [{ month: "2026-09", count: 2 }, { month: "2026-10", count: 1 }]);
    assert.equal(calendar.data.first_month, "2026-09");
    assert.equal(calendar.data.last_month, "2026-10");
    assert.equal(calendar.data.dated_entry_count, 3, "a repeated month-grid entry is counted once");
    assert.equal(calendar.data.course_event_count, 1);
    assert.equal(calendar.data.unattributed_activity_event_count, 0);
    assert.equal(calendar.data.skipped_event_count, 1, "a personal calendar entry is counted and dropped");
    assert.deepEqual(calendar.data.activity_counts, [
      { module_id: 77, modname: "quiz", count: 1 },
      { module_id: 78, modname: "assign", count: 1 },
    ]);
    assert.deepEqual(calendar.data.proof, {
      method: "core_calendar_get_calendar_monthly_view",
      complete: true,
      required_capability: null,
      access_rule: "course_calendar_visibility",
      event_limit: 2_000,
      month_limit: 12,
      request_count: 2,
    });
    for (const privateValue of [PRIVATE_NAME, PRIVATE_DESCRIPTION, "userid", "description", "Quiz 1 closes", "Term starts", "1788000000"]) {
      assert.equal(JSON.stringify(calendar).includes(privateValue), false, `the dates report leaked ${privateValue}`);
    }

    // Every report request stays on its own read-only route, and no read opens
    // an activity view, player, attempt or report page.
    const routes = requests.filter((request) => request.pathname.startsWith("/report/"));
    assert.ok(routes.length > 0);
    for (const request of routes) assert.equal(request.method, "GET");
    assert.equal(requests.some((request) => /^\/mod\//.test(request.pathname)), false, "no read opens a module page");
    assert.equal(requests.some((request) => request.pathname === "/iplookup/index.php"), false, "no read follows an IP lookup link");
    assert.equal(
      requests.some((request) => request.method !== "GET" && request.pathname !== "/lib/ajax/service.php"),
      false,
      "the only POST any report read sends is the calendar AJAX read",
    );
    for (const request of requests.filter((entry) => entry.pathname === "/report/participation/index.php")) {
      assert.match(request.search, /^\?id=2&instanceid=77&timefrom=\d+&action=view&page=\d+&perpage=100$/);
    }
    for (const request of requests.filter((entry) => entry.pathname === "/report/log/index.php")) {
      assert.match(request.search, /^\?id=2&chooselog=1&page=\d+&perpage=100$/);
    }

    mode = "outline-unreadable";
    const unreadable = await call(activity, { course_id: 2 });
    assert.equal(unreadable.ok, true, JSON.stringify(unreadable));
    assert.equal(unreadable.data.unreadable_count, 1, "a views cell that is not a number is unreadable, not zero");
    assert.equal(unreadable.data.total_view_count, 0);

    mode = "outline-missing-table";
    assert.deepEqual(await call(activity, { course_id: 2 }), { ok: false, sent: false, error: "moodle_course_activity_report_response_invalid" });
    mode = "log-short-row";
    assert.deepEqual(await call(log, { course_id: 2 }), { ok: false, sent: false, error: "moodle_course_log_summary_response_invalid" });
    mode = "completion-changed";
    assert.deepEqual(await call(completion, { course_id: 2 }), { ok: false, sent: false, error: "moodle_course_completion_report_response_changed" });
    mode = "dates-exception";
    assert.deepEqual(await call(dates, { course_id: 2, year: 2026, month: 9, months: 1 }), { ok: false, sent: false, error: "moodle_course_dates_report_route_unavailable" });
    mode = "dates-invalid";
    assert.deepEqual(await call(dates, { course_id: 2, year: 2026, month: 9, months: 1 }), { ok: false, sent: false, error: "moodle_course_dates_report_response_invalid" });

    mode = "oversize";
    for (const [entry, args] of [
      [activity, { course_id: 2 }],
      [participation, { course_id: 2, module_id: 77, action: "view", since_days: 30 }],
      [completion, { course_id: 2 }],
      [log, { course_id: 2 }],
    ]) {
      assert.deepEqual(await call(entry, args), { ok: false, sent: false, complete: false, error: `${entry.tool.replace(/^moodle_get_/, "moodle_")}_incomplete` });
    }

    mode = "participation-endless";
    // A scan that never reaches the report's own last page is incomplete. It is
    // not a whole-course count.
    const beforeEndless = requests.filter((entry) => entry.pathname === "/report/participation/index.php").length;
    assert.deepEqual(
      await call(participation, { course_id: 2, module_id: 77, action: "view", since_days: 30 }),
      { ok: false, sent: false, complete: false, error: "moodle_course_participation_report_incomplete" },
    );
    assert.equal(requests.filter((entry) => entry.pathname === "/report/participation/index.php").length - beforeEndless, 100, "the participation report stops at its own page-request bound");
  } finally {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
});
