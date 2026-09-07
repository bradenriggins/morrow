import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { executeMoodleQuizAttemptSummaryInPage } from "../../connector/extension/src/moodle-quiz-attempt-summary-read.js";

const OPERATION = Object.freeze({
  key: "moodle.form.quiz.attempt_summary.read.v1",
  toolName: "moodle_get_quiz_attempt_summary",
  provider: "moodle",
  readOnly: true,
});

test("Moodle Quiz attempt summary is cataloged and routed through the extension worker", () => {
  const root = new URL("../..", import.meta.url);
  const catalog = JSON.parse(readFileSync(new URL("connector/extension/generated/moodle-browser-catalog.json", root), "utf8"));
  const entries = catalog.operations.filter((entry) => entry.key === "moodle.form.quiz.attempt_summary.read.v1");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].toolName, "moodle_get_quiz_attempt_summary");
  assert.equal(entries[0].provider, "moodle");
  assert.equal(entries[0].readOnly, true);
  const worker = readFileSync(new URL("connector/extension/src/service-worker.js", root), "utf8");
  assert.match(worker, /import \{ executeMoodleQuizAttemptSummaryInPage \} from "\.\/moodle-quiz-attempt-summary-read\.js";/);
  assert.match(worker, /MOODLE_QUIZ_ATTEMPT_SUMMARY_OPERATION_KEY = "moodle\.form\.quiz\.attempt_summary\.read\.v1"/);
  assert.match(worker, /func: executeMoodleQuizAttemptSummaryInPage/);
});

test("Moodle Quiz attempt summary binds one Quiz and returns only bounded state counts", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morrow-moodle-quiz-attempt-summary-"));
  const key = join(directory, "key.pem");
  const certificate = join(directory, "certificate.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", certificate], { stdio: "ignore" });
  const PRIVATE_SESSION = "moodle-private-session";
  const requests = [];
  let origin = "";
  let mode = "complete";
  let browser;
  const participantHtml = () => {
    const count = mode === "over-cap" ? 51 : 2;
    return `<div data-region="core_table/dynamic" data-table-component="core_user" data-table-handler="participants" data-table-uniqueid="user-index-participants-2" data-table-total-rows="${count}">
      <table><tbody><tr><td><input class="usercheckbox" name="user7"></td><td>Jane Moodle</td></tr><tr><td><input class="usercheckbox" name="user8"></td><td>Rowan Moodle</td></tr></tbody></table>
    </div>`;
  };
  const attempts = (userId) => {
    if (mode === "bad-state") return [{ id: 501, quiz: 71, userid: userId, state: "mystery", sumgrades: 100, feedback: { feedbacktext: "private feedback" } }];
    if (mode === "over-attempt-cap") return Array.from({ length: 51 }, (_, index) => ({ id: 700 + index, quiz: 71, userid: userId, state: "finished", sumgrades: 100 }));
    return userId === 7
      ? [
        { id: 501, quiz: 71, userid: 7, state: "finished", sumgrades: 100, feedback: { feedbacktext: "private feedback" }, answers: "private answer" },
        { id: 502, quiz: 71, userid: 7, state: "submitted", sumgrades: 20, useremail: "jane@example.edu" },
      ]
      : [{ id: 503, quiz: 71, userid: 8, state: "inprogress", sumgrades: 0, feedback: { feedbacktext: "private draft" } }];
  };
  const quizForm = () => {
    const module = mode === "wrong-module" ? "99" : "8";
    const course = mode === "wrong-course" ? "9" : "2";
    const instance = mode === "missing-instance" ? "" : "71";
    const name = mode === "wrong-type" ? "assign" : "quiz";
    return `<!doctype html><html><body><form method="post" action="/course/modedit.php?update=8&amp;return=0">
      <input type="hidden" name="course" value="${course}"><input type="hidden" name="coursemodule" value="${module}">
      <input type="hidden" name="update" value="8"><input type="hidden" name="modulename" value="${name}">
      ${instance ? `<input type="hidden" name="instance" value="${instance}">` : ""}<input type="hidden" name="sesskey" value="${PRIVATE_SESSION}">
    </form></body></html>`;
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
      response.writeHead(200, { "content-type": "text/html" }); response.end(quizForm()); return;
    }
    if (request.method === "POST" && target.pathname === "/lib/ajax/service.php") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const call = message[0];
      if (target.search === `?sesskey=${PRIVATE_SESSION}&info=core_table_get_dynamic_table_content`) {
        assert.deepEqual(call, {
          index: 0, methodname: "core_table_get_dynamic_table_content",
          args: { component: "core_user", handler: "participants", uniqueid: "user-index-participants-2", sortdata: [{ sortby: "lastname", sortorder: 4 }], filters: [{ name: "courseid", jointype: 1, values: [2] }], jointype: 1, firstinitial: "", lastinitial: "", pagenumber: 1, pagesize: 50, hiddencolumns: [], resetpreferences: false },
        });
        response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify([{ index: 0, data: { html: participantHtml() } }])); return;
      }
      if (target.search === `?sesskey=${PRIVATE_SESSION}&info=mod_quiz_get_user_quiz_attempts`) {
        assert.equal(call.index, 0); assert.equal(call.methodname, "mod_quiz_get_user_quiz_attempts");
        assert.deepEqual(call.args, { quizid: 71, userid: call.args.userid, status: "all", includepreviews: false });
        assert.ok([7, 8].includes(call.args.userid));
        response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify([{ index: 0, data: { attempts: attempts(call.args.userid), warnings: [] } }])); return;
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
    const invoke = (args = { course_id: 2, module_id: 8 }) => page.evaluate(
      executeMoodleQuizAttemptSummaryInPage,
      JSON.stringify({ operation: OPERATION, arguments: args, binding: { origin, siteUrl: `${origin}/`, principalId: "3", courseId: "2" }, expiresAt: Date.now() + 60_000 }),
    );
    const sourceRequests = () => requests.filter((request) => request.pathname === "/course/modedit.php" || request.pathname === "/lib/ajax/service.php").length;
    const beforeInvalid = sourceRequests();
    assert.deepEqual(await invoke({ course_id: 2, module_id: 8, extra: true }), { ok: false, sent: false, error: "moodle_quiz_attempt_summary_arguments_invalid" });
    assert.equal(sourceRequests(), beforeInvalid);

    const summary = await invoke();
    assert.equal(summary.ok, true, JSON.stringify(summary)); assert.equal(summary.complete, true);
    assert.deepEqual(summary.data, {
      schema: "morrow.moodle-quiz-attempt-summary.v1", provider: "moodle", course_id: 2, module_id: 8, quiz_id: 71,
      participant_count: 2, total_attempt_count: 3,
      attempt_state_counts: { notstarted: 0, inprogress: 1, overdue: 0, submitted: 1, finished: 1, abandoned: 0 },
      proof: { method: "core_table_get_dynamic_table_content+mod_quiz_get_user_quiz_attempts", complete: true, exact_module_binding: "course_modedit_form", participant_page_size: 50, participant_response_rows: 2, per_participant_attempt_limit: 50, total_attempt_limit: 500, attempt_response_rows: 3, attempt_request_count: 2 },
    });
    const serialized = JSON.stringify(summary);
    for (const privateValue of [PRIVATE_SESSION, "Jane Moodle", "Rowan Moodle", "private feedback", "private draft", "private answer", "jane@example.edu", '"id":501', '"sumgrades":100']) {
      assert.equal(serialized.includes(privateValue), false, `result leaked ${privateValue}`);
    }
    assert.equal(requests.some((request) => request.pathname === "/mod/quiz/view.php" || request.pathname === "/mod/quiz/report.php"), false);

    for (const failure of ["wrong-module", "wrong-course", "missing-instance", "wrong-type"]) {
      mode = failure;
      const before = requests.filter((request) => request.pathname === "/lib/ajax/service.php").length;
      assert.deepEqual(await invoke(), { ok: false, sent: false, error: "moodle_quiz_attempt_summary_target_unavailable" });
      assert.equal(requests.filter((request) => request.pathname === "/lib/ajax/service.php").length, before);
    }
    mode = "bad-state";
    assert.deepEqual(await invoke(), { ok: false, sent: false, error: "moodle_quiz_attempt_summary_response_invalid" });
    mode = "over-cap";
    assert.deepEqual(await invoke(), { ok: false, sent: false, complete: false, error: "moodle_quiz_attempt_summary_incomplete" });
    mode = "over-attempt-cap";
    assert.deepEqual(await invoke(), { ok: false, sent: false, complete: false, error: "moodle_quiz_attempt_summary_incomplete" });
  } finally {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
});
