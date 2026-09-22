import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import {
  executeMoodleScormAttemptSummaryInPage,
  executeMoodleScormLearnerReportInPage,
} from "../../connector/extension/src/moodle-scorm-report-read.js";

const SUMMARY_OPERATION = Object.freeze({
  key: "moodle.form.scorm.attempt_summary.read.v1",
  toolName: "moodle_get_scorm_attempt_summary",
  provider: "moodle",
  readOnly: true,
});
const REPORT_OPERATION = Object.freeze({
  key: "moodle.form.scorm.learner_report.read.v1",
  toolName: "moodle_get_scorm_learner_report",
  provider: "moodle",
  readOnly: true,
});
const SUMMARY_METHOD = "core_table_get_dynamic_table_content+mod_scorm_get_scorm_scoes+mod_scorm_get_scorm_attempt_count+mod_scorm_get_scorm_sco_tracks";
const REPORT_METHOD = "mod_scorm_get_scorm_scoes+mod_scorm_get_scorm_attempt_count+mod_scorm_get_scorm_sco_tracks";

test("Moodle SCORM report reads are cataloged and routed through the extension worker", () => {
  const root = new URL("../..", import.meta.url);
  const catalog = JSON.parse(readFileSync(new URL("connector/extension/generated/moodle-browser-catalog.json", root), "utf8"));
  for (const [key, toolName] of [
    ["moodle.form.scorm.attempt_summary.read.v1", "moodle_get_scorm_attempt_summary"],
    ["moodle.form.scorm.learner_report.read.v1", "moodle_get_scorm_learner_report"],
  ]) {
    const entries = catalog.operations.filter((entry) => entry.key === key);
    assert.equal(entries.length, 1, `${key} must be cataloged exactly once`);
    assert.equal(entries[0].toolName, toolName);
    assert.equal(entries[0].provider, "moodle");
    assert.equal(entries[0].readOnly, true);
    assert.equal(entries[0].dataClass, "learner");
    // The description must state the route limit before an assistant calls it.
    assert.match(entries[0].description, /without the AJAX flag/);
    assert.match(entries[0].description, /mod\/scorm:viewreport/);
  }
  const worker = readFileSync(new URL("connector/extension/src/service-worker.js", root), "utf8");
  assert.match(worker, /import \{ executeMoodleScormAttemptSummaryInPage, executeMoodleScormLearnerReportInPage \} from "\.\/moodle-scorm-report-read\.js";/);
  assert.match(worker, /MOODLE_SCORM_ATTEMPT_SUMMARY_OPERATION_KEY = "moodle\.form\.scorm\.attempt_summary\.read\.v1"/);
  assert.match(worker, /MOODLE_SCORM_LEARNER_REPORT_OPERATION_KEY = "moodle\.form\.scorm\.learner_report\.read\.v1"/);
  assert.match(worker, /func: executeMoodleScormAttemptSummaryInPage/);
  assert.match(worker, /func: executeMoodleScormLearnerReportInPage/);
});

test("Moodle SCORM report reads bind one activity and return bounded tracking only", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morrow-moodle-scorm-report-"));
  const key = join(directory, "key.pem");
  const certificate = join(directory, "certificate.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", certificate], { stdio: "ignore" });
  const PRIVATE_SESSION = "moodle-private-session";
  const requests = [];
  let origin = "";
  let mode = "complete";
  let browser;
  const participantHtml = () => {
    const count = mode === "over-participant-cap" ? 10_001 : 2;
    return `<div data-region="core_table/dynamic" data-table-component="core_user" data-table-handler="participants" data-table-uniqueid="user-index-participants-2" data-table-total-rows="${count}">
      <table><tbody><tr><td><input class="usercheckbox" name="user7"></td><td>Jane Moodle</td></tr><tr><td><input class="usercheckbox" name="user8"></td><td>Rowan Moodle</td></tr></tbody></table>
    </div>`;
  };
  const scoes = () => {
    if (mode === "over-sco-cap") return Array.from({ length: 201 }, (_, index) => ({ id: 400 + index, scorm: 71, scormtype: "sco", launch: "index.html", title: "Unit" }));
    return [
      { id: 31, scorm: 71, manifest: "1", organization: "", parent: "/", identifier: "unit-1", launch: "unit1.html", scormtype: "sco", title: "Unit 1", sortorder: 1 },
      { id: 32, scorm: 71, manifest: "1", organization: "", parent: "/", identifier: "media", launch: "media.mp4", scormtype: "asset", title: "Media", sortorder: 2 },
      { id: 33, scorm: 71, manifest: "1", organization: "", parent: "/", identifier: "unit-2", launch: "unit2.html", scormtype: "sco", title: "Unit 2", sortorder: 3 },
    ];
  };
  const attemptCount = (userId) => {
    if (mode === "over-attempt-cap") return 51;
    return userId === 7 ? 2 : 1;
  };
  // Moodle's scorm_get_tracks() adds userid and scoid to the element list and
  // scorm_format_interactions() derives `status` and `score_raw` from the raw
  // SCORM 1.2 and 2004 elements. The fixture reproduces both, plus the private
  // element values a real package writes.
  const tracks = (scoId, userId, attempt) => {
    const identity = [
      { element: "userid", value: String(userId) },
      { element: "scoid", value: String(scoId) },
      { element: "cmi.core.student_name", value: "Moodle, Jane" },
      { element: "cmi.core.student_id", value: "jane@example.edu" },
      { element: "cmi.suspend_data", value: "private suspend data" },
      { element: "cmi.comments", value: "private learner comment" },
    ];
    if (mode === "bad-track") return [{ element: "status", value: "completed" }, { element: "status", value: "passed" }];
    if (userId === 7 && attempt === 1 && scoId === 31) {
      return [...identity, { element: "status", value: "completed" }, { element: "score_raw", value: "90" }, { element: "cmi.core.score.max", value: "100" }];
    }
    if (userId === 7 && attempt === 1 && scoId === 33) return [...identity, { element: "status", value: "incomplete" }];
    if (userId === 7 && attempt === 2 && scoId === 31) {
      return [...identity, { element: "status", value: "passed" }, { element: "cmi.score.scaled", value: "0.55" }];
    }
    if (userId === 7 && attempt === 2 && scoId === 33) return [];
    if (userId === 8 && scoId === 31) {
      return [...identity, { element: "status", value: "failed" }, { element: "score_raw", value: "10" }, { element: "cmi.core.score.max", value: "50" }];
    }
    return [...identity, { element: "status", value: "browsed" }, { element: "score_raw", value: "70" }];
  };
  const scormForm = () => {
    const module = mode === "wrong-module" ? "99" : "8";
    const course = mode === "wrong-course" ? "9" : "2";
    const instance = mode === "missing-instance" ? "" : "71";
    const name = mode === "wrong-type" ? "imscp" : "scorm";
    return `<!doctype html><html><body><form method="post" action="/course/modedit.php?update=8&amp;return=0">
      <input type="hidden" name="course" value="${course}"><input type="hidden" name="coursemodule" value="${module}">
      <input type="hidden" name="update" value="8"><input type="hidden" name="modulename" value="${name}">
      ${instance ? `<input type="hidden" name="instance" value="${instance}">` : ""}<input type="hidden" name="sesskey" value="${PRIVATE_SESSION}">
    </form></body></html>`;
  };
  const blocked = () => [{
    index: 0, error: true,
    exception: { message: "Service not available.", errorcode: "servicenotavailable", module: "webservice" },
  }];
  const server = createServer({ key: readFileSync(key), cert: readFileSync(certificate) }, async (request, response) => {
    const target = new URL(request.url || "/", origin);
    requests.push({ method: request.method, pathname: target.pathname, search: target.search });
    if (target.pathname === "/course/view.php") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<!doctype html><body class="path-course course-2"><script>var M = { cfg: ${JSON.stringify({ wwwroot: origin, sesskey: PRIVATE_SESSION, userId: 3, courseId: 2 })} };</script></body>`);
      return;
    }
    if (request.method === "GET" && target.pathname === "/course/modedit.php" && target.search === "?update=8&return=0") {
      response.writeHead(200, { "content-type": "text/html" }); response.end(scormForm()); return;
    }
    if (request.method === "POST" && target.pathname === "/lib/ajax/service.php") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const call = message[0];
      const json = (payload) => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(payload)); };
      if (target.search === `?sesskey=${PRIVATE_SESSION}&info=core_table_get_dynamic_table_content`) {
        assert.equal(call.methodname, "core_table_get_dynamic_table_content");
        assert.equal(call.args.pagesize, 10_000);
        json([{ index: 0, data: { html: participantHtml() } }]); return;
      }
      if (mode === "service-blocked" && String(call.methodname).startsWith("mod_scorm_")) { json(blocked()); return; }
      if (target.search === `?sesskey=${PRIVATE_SESSION}&info=mod_scorm_get_scorm_scoes`) {
        assert.deepEqual(call, { index: 0, methodname: "mod_scorm_get_scorm_scoes", args: { scormid: 71, organization: "" } });
        json([{ index: 0, data: { scoes: scoes(), warnings: [] } }]); return;
      }
      if (target.search === `?sesskey=${PRIVATE_SESSION}&info=mod_scorm_get_scorm_attempt_count`) {
        assert.deepEqual(call.args, { scormid: 71, userid: call.args.userid, ignoremissingcompletion: false });
        assert.ok([7, 8].includes(call.args.userid));
        json([{ index: 0, data: { attemptscount: attemptCount(call.args.userid), warnings: [] } }]); return;
      }
      if (target.search === `?sesskey=${PRIVATE_SESSION}&info=mod_scorm_get_scorm_sco_tracks`) {
        assert.deepEqual(Object.keys(call.args).sort(), ["attempt", "scoid", "userid"]);
        assert.ok([31, 33].includes(call.args.scoid), `unexpected sco ${call.args.scoid}`);
        json([{ index: 0, data: { data: { attempt: call.args.attempt, tracks: tracks(call.args.scoid, call.args.userid, call.args.attempt) }, warnings: [] } }]);
        return;
      }
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
    const summary = (args = { course_id: 2, module_id: 8 }) => call(executeMoodleScormAttemptSummaryInPage, SUMMARY_OPERATION, args);
    const report = (args = { course_id: 2, module_id: 8, user_id: 7 }) => call(executeMoodleScormLearnerReportInPage, REPORT_OPERATION, args);
    const sourceRequests = () => requests.filter((entry) => entry.pathname === "/course/modedit.php" || entry.pathname === "/lib/ajax/service.php").length;
    const ajaxRequests = () => requests.filter((entry) => entry.pathname === "/lib/ajax/service.php").length;

    const beforeInvalid = sourceRequests();
    assert.deepEqual(await summary({ course_id: 2, module_id: 8, extra: true }), { ok: false, sent: false, error: "moodle_scorm_attempt_summary_arguments_invalid" });
    assert.deepEqual(await report({ course_id: 2, module_id: 8 }), { ok: false, sent: false, error: "moodle_scorm_learner_report_arguments_invalid" });
    assert.equal(sourceRequests(), beforeInvalid);

    const aggregate = await summary();
    assert.equal(aggregate.ok, true, JSON.stringify(aggregate));
    assert.equal(aggregate.complete, true);
    assert.deepEqual(aggregate.data, {
      schema: "morrow.moodle-scorm-attempt-summary.v1", provider: "moodle", course_id: 2, module_id: 8, scorm_id: 71,
      participant_count: 2, attempted_participant_count: 2, total_attempt_count: 3,
      tracked_sco_count: 2, tracked_record_count: 6,
      sco_status_counts: { passed: 1, completed: 1, failed: 1, incomplete: 1, browsed: 1, notattempted: 1, unknown: 0 },
      score_bucket_counts: { "0-19": 0, "20-39": 1, "40-59": 1, "60-79": 1, "80-100": 1, unscored: 2 },
      proof: {
        method: SUMMARY_METHOD, complete: true, exact_module_binding: "course_modedit_form",
        required_capability: "mod/scorm:viewreport", participant_limit: 10_000, participant_response_rows: 2,
        sco_limit: 200, per_participant_attempt_limit: 50, total_attempt_limit: 5_000,
        track_request_limit: 2_000, track_request_count: 6,
      },
    });

    const learner = await report();
    assert.equal(learner.ok, true, JSON.stringify(learner));
    assert.deepEqual(learner.data, {
      schema: "morrow.moodle-scorm-learner-report.v1", provider: "moodle", course_id: 2, module_id: 8, scorm_id: 71,
      learner: { user_id: "7" }, attempt_count: 2, tracked_sco_count: 2,
      attempts: [
        { attempt: 1, records: [{ sco_id: 31, status: "completed", score_percent: 90 }, { sco_id: 33, status: "incomplete", score_percent: null }] },
        { attempt: 2, records: [{ sco_id: 31, status: "passed", score_percent: 55 }, { sco_id: 33, status: "notattempted", score_percent: null }] },
      ],
      proof: {
        method: REPORT_METHOD, complete: true, exact_module_binding: "course_modedit_form",
        required_capability: "mod/scorm:viewreport", attempt_limit: 50, sco_limit: 200,
        track_request_limit: 500, track_request_count: 4,
      },
    });

    const aggregateText = JSON.stringify(aggregate);
    const reportText = JSON.stringify(learner);
    for (const privateValue of [PRIVATE_SESSION, "Jane Moodle", "Rowan Moodle", "Moodle, Jane", "jane@example.edu", "private suspend data", "private learner comment", "score_raw", "cmi."]) {
      assert.equal(aggregateText.includes(privateValue), false, `aggregate leaked ${privateValue}`);
      assert.equal(reportText.includes(privateValue), false, `learner report leaked ${privateValue}`);
    }
    // The aggregate names no learner at all; the learner report names exactly one.
    assert.equal(aggregateText.includes("user_id"), false);
    assert.equal(aggregateText.includes('"8"'), false);
    assert.equal(reportText.includes('"user_id":"7"'), true);
    assert.equal(reportText.includes('"user_id":"8"'), false);

    for (const path of ["/mod/scorm/view.php", "/mod/scorm/player.php", "/mod/scorm/loadSCO.php", "/mod/scorm/report.php"]) {
      assert.equal(requests.some((entry) => entry.pathname === path), false, `a SCORM read requested ${path}`);
    }

    for (const failure of ["wrong-module", "wrong-course", "missing-instance", "wrong-type"]) {
      mode = failure;
      const before = ajaxRequests();
      assert.deepEqual(await summary(), { ok: false, sent: false, error: "moodle_scorm_attempt_summary_target_unavailable" });
      assert.deepEqual(await report(), { ok: false, sent: false, error: "moodle_scorm_learner_report_target_unavailable" });
      assert.equal(ajaxRequests(), before, `${failure} still reached the AJAX service`);
    }

    // Moodle v5.2.2 registers every mod_scorm external function without the
    // AJAX flag, so lib/ajax/service.php refuses it. Both readers must name
    // that exact condition and return no counts.
    mode = "service-blocked";
    assert.deepEqual(await summary(), { ok: false, sent: false, error: "moodle_scorm_attempt_summary_service_unavailable" });
    assert.deepEqual(await report(), { ok: false, sent: false, error: "moodle_scorm_learner_report_service_unavailable" });

    mode = "bad-track";
    assert.deepEqual(await summary(), { ok: false, sent: false, error: "moodle_scorm_attempt_summary_response_invalid" });
    assert.deepEqual(await report(), { ok: false, sent: false, error: "moodle_scorm_learner_report_response_invalid" });

    mode = "over-sco-cap";
    assert.deepEqual(await summary(), { ok: false, sent: false, complete: false, error: "moodle_scorm_attempt_summary_incomplete" });
    assert.deepEqual(await report(), { ok: false, sent: false, complete: false, error: "moodle_scorm_learner_report_incomplete" });

    mode = "over-attempt-cap";
    assert.deepEqual(await summary(), { ok: false, sent: false, complete: false, error: "moodle_scorm_attempt_summary_incomplete" });
    assert.deepEqual(await report(), { ok: false, sent: false, complete: false, error: "moodle_scorm_learner_report_incomplete" });

    mode = "over-participant-cap";
    assert.deepEqual(await summary(), { ok: false, sent: false, complete: false, error: "moodle_scorm_attempt_summary_incomplete" });

    mode = "complete";
    const expired = await page.evaluate(
      executeMoodleScormAttemptSummaryInPage,
      JSON.stringify({ operation: SUMMARY_OPERATION, arguments: { course_id: 2, module_id: 8 }, binding: { origin, siteUrl: `${origin}/`, principalId: "3", courseId: "2" }, expiresAt: Date.now() - 1 }),
    );
    assert.deepEqual(expired, { ok: false, sent: false, error: "moodle_scorm_attempt_summary_arguments_invalid" });

    const allowed = ["/course/view.php", "/course/modedit.php", "/lib/ajax/service.php", "/favicon.ico"];
    assert.deepEqual([...new Set(requests.map((entry) => entry.pathname))].filter((path) => !allowed.includes(path)), []);
  } finally {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
});
