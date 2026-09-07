import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { executeMoodleAssignmentSubmissionSummaryInPage } from "../../connector/extension/src/moodle-learner-submission-read.js";

const OPERATION = Object.freeze({
  key: "moodle.form.assign.submissions.read.v1",
  toolName: "moodle_get_assignment_submission_summary",
  provider: "moodle",
  readOnly: true,
});

test("Moodle Assignment submission summary binds the module then returns only complete aggregate counts", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morrow-moodle-assignment-summary-"));
  const key = join(directory, "key.pem");
  const certificate = join(directory, "certificate.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", certificate], { stdio: "ignore" });
  const PRIVATE_SESSION = "moodle-private-session";
  const requests = [];
  let origin = "";
  let mode = "complete";
  let browser;
  const participantRows = () => mode === "duplicate"
    ? [
      { id: 7, fullname: "Jane Moodle", submitted: true, requiregrading: true, grantedextension: false, submissionstatus: "submitted" },
      { id: 7, fullname: "Jane Moodle", submitted: true, requiregrading: true, grantedextension: false, submissionstatus: "submitted" },
    ]
    : mode === "bad-status"
      ? [{ id: 7, fullname: "Jane Moodle", submitted: true, requiregrading: true, grantedextension: false, submissionstatus: "graded" }]
      : mode === "oversize"
        ? [{ id: 7, fullname: "Jane Moodle", submitted: true, requiregrading: true, grantedextension: false, submissionstatus: "submitted", private_comment: "x".repeat(2_100_000) }]
        : [
          { id: 7, fullname: "Jane Moodle", submitted: true, requiregrading: true, grantedextension: false, submissionstatus: "submitted", grade: 100, comments: "private feedback", url: "https://outside.example/submission/7" },
          { id: 8, fullname: "Rowan Moodle", submitted: false, requiregrading: false, grantedextension: true, submissionstatus: "draft", grade: 42, comments: "private draft" },
          { id: 9, fullname: "Taylor Moodle", submitted: false, requiregrading: false, grantedextension: false, submissionstatus: "new" },
          { id: 10, fullname: "Morgan Moodle", submitted: false, requiregrading: true, grantedextension: false, submissionstatus: "reopened" },
        ];
  const assignmentForm = () => {
    const module = mode === "wrong-module" ? "99" : "8";
    const course = mode === "wrong-course" ? "9" : "2";
    const instance = mode === "missing-instance" ? "" : "70";
    const action = mode === "external-action" ? "https://outside.example/course/modedit.php" : "/course/modedit.php?update=8&amp;return=0";
    return `<!doctype html><html><body><form method="post" action="${action}">
      <input type="hidden" name="course" value="${course}">
      <input type="hidden" name="coursemodule" value="${module}">
      <input type="hidden" name="update" value="8">
      <input type="hidden" name="modulename" value="assign">
      ${instance ? `<input type="hidden" name="instance" value="${instance}">` : ""}
      <input type="hidden" name="sesskey" value="${PRIVATE_SESSION}">
    </form><p>Jane Moodle private settings source</p></body></html>`;
  };
  const server = createServer({ key: readFileSync(key), cert: readFileSync(certificate) }, async (request, response) => {
    const target = new URL(request.url || "/", origin);
    requests.push({ method: request.method, pathname: target.pathname, search: target.search });
    if (target.pathname === "/course/view.php") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<!doctype html><body class="path-course course-2"><script>var M = { cfg: ${JSON.stringify({ wwwroot: origin, sesskey: PRIVATE_SESSION, userId: 3, courseId: 2 })} };</script></body>`);
      return;
    }
    if (request.method === "GET" && target.pathname === "/course/modedit.php" && target.search === "?update=8&return=0") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(assignmentForm());
      return;
    }
    if (request.method === "POST" && target.pathname === "/lib/ajax/service.php") {
      assert.equal(target.search, `?sesskey=${PRIVATE_SESSION}&info=mod_assign_list_participants`);
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      assert.deepEqual(message, [{
        index: 0,
        methodname: "mod_assign_list_participants",
        args: { assignid: 70, groupid: 0, filter: "", skip: 0, limit: 0, onlyids: true, includeenrolments: false, tablesort: false, marking: false },
      }]);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify([{ index: 0, data: JSON.stringify(participantRows()) }]));
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
    const invoke = (args = { course_id: 2, module_id: 8 }, expiresAt = Date.now() + 60_000) => page.evaluate(
      executeMoodleAssignmentSubmissionSummaryInPage,
      JSON.stringify({ operation: OPERATION, arguments: args, binding: { origin, siteUrl: `${origin}/`, principalId: "3", courseId: "2" }, expiresAt }),
    );
    const ajaxRequests = () => requests.filter((request) => request.pathname === "/lib/ajax/service.php").length;

    const invalidBefore = ajaxRequests();
    assert.deepEqual(await invoke({ course_id: 2, module_id: 8, extra: true }), { ok: false, sent: false, error: "moodle_assignment_submission_arguments_invalid" });
    assert.deepEqual(await invoke(undefined, Date.now() - 1), { ok: false, sent: false, error: "moodle_assignment_submission_arguments_invalid" });
    assert.equal(ajaxRequests(), invalidBefore);

    const summary = await invoke();
    assert.equal(summary.ok, true, JSON.stringify(summary));
    assert.equal(summary.complete, true);
    assert.deepEqual(summary.data, {
      schema: "morrow.moodle-assignment-submission-summary.v1",
      provider: "moodle",
      course_id: 2,
      module_id: 8,
      assignment_id: 70,
      participant_count: 4,
      submitted_count: 1,
      requires_grading_count: 2,
      granted_extension_count: 1,
      submission_status_counts: { new: 1, reopened: 1, draft: 1, submitted: 1 },
      proof: { method: "mod_assign_list_participants", complete: true, exact_module_binding: "course_modedit_form", requested_limit: 0, response_row_count: 4 },
    });
    const serialized = JSON.stringify(summary);
    for (const privateValue of [PRIVATE_SESSION, "Jane Moodle", "Rowan Moodle", "Taylor Moodle", "Morgan Moodle", "private feedback", "private draft", "https://outside.example/submission/7", '"id":7', '"grade":100']) {
      assert.equal(serialized.includes(privateValue), false, `result leaked ${privateValue}`);
    }
    assert.equal(requests.some((request) => request.pathname === "/mod/assign/view.php"), false);
    assert.equal(requests.some((request) => request.pathname === "/mod/assign/gradingtable.php"), false);

    for (const failure of ["wrong-module", "wrong-course", "missing-instance", "external-action"]) {
      mode = failure;
      const before = ajaxRequests();
      assert.deepEqual(await invoke(), { ok: false, sent: false, error: "moodle_assignment_submission_target_unavailable" });
      assert.equal(ajaxRequests(), before);
    }
    mode = "duplicate";
    assert.deepEqual(await invoke(), { ok: false, sent: false, error: "moodle_assignment_submission_response_invalid" });
    mode = "bad-status";
    assert.deepEqual(await invoke(), { ok: false, sent: false, error: "moodle_assignment_submission_response_invalid" });
    mode = "oversize";
    assert.deepEqual(await invoke(), { ok: false, sent: false, complete: false, error: "moodle_assignment_submission_summary_incomplete" });
  } finally {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Moodle Assignment submission summary is cataloged and routed through the extension worker", () => {
  const root = new URL("../..", import.meta.url);
  const catalog = JSON.parse(readFileSync(new URL("connector/extension/generated/moodle-browser-catalog.json", root), "utf8"));
  const entries = catalog.operations.filter((entry) => entry.key === "moodle.form.assign.submissions.read.v1");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].toolName, "moodle_get_assignment_submission_summary");
  assert.equal(entries[0].provider, "moodle");
  assert.equal(entries[0].readOnly, true);
  const worker = readFileSync(new URL("connector/extension/src/service-worker.js", root), "utf8");
  assert.match(worker, /import \{ executeMoodleAssignmentSubmissionSummaryInPage \} from "\.\/moodle-learner-submission-read\.js";/);
  assert.match(worker, /MOODLE_ASSIGNMENT_SUBMISSION_SUMMARY_OPERATION_KEY = "moodle\.form\.assign\.submissions\.read\.v1"/);
  assert.match(worker, /func: executeMoodleAssignmentSubmissionSummaryInPage/);
});
