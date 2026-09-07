import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { executeCanvasClassicQuizSubmissionSummaryInPage } from "../../connector/extension/src/canvas-classic-quiz-submission-read.js";

const OPERATION = Object.freeze({
  key: "canvas.api.v1.course.quiz.submissions.aggregate.read.v1",
  toolName: "canvas_get_classic_quiz_submission_summary",
  provider: "canvas",
  readOnly: true,
});

test("Canvas Classic Quiz submission summary follows only bounded exact pagination and returns aggregate counts", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morrow-canvas-classic-quiz-submissions-"));
  const key = join(directory, "key.pem");
  const certificate = join(directory, "certificate.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", certificate], { stdio: "ignore" });
  const PRIVATE_SESSION = "canvas-private-session";
  const requests = [];
  let origin = "";
  let mode = "complete";
  let browser;
  const submissionsPath = "/api/v1/courses/2/quizzes/8/submissions";
  const privateRows = (page) => {
    if (mode === "unknown") return [{ quiz_id: 8, workflow_state: "graded", user_id: 91, score: 100, answer: "private answer" }];
    if (mode === "wrong-quiz") return [{ quiz_id: 9, workflow_state: "complete", user_id: 91, score: 100 }];
    if (mode === "overflow") return [{ quiz_id: 8, workflow_state: "complete", user_id: 91, score: 100 }];
    if (page === "two") return [
      { quiz_id: 8, workflow_state: "untaken", user_id: 93, submission_id: 102, score: null, answers: [{ id: 7, answer: "private answer" }], comments: "private second comment", email: "rowan.student@example.edu" },
      { quiz_id: 8, workflow_state: "settings_only", user_id: 94, submission_id: 103, score: null, email: "taylor.student@example.edu" },
    ];
    return [
      { quiz_id: 8, workflow_state: "complete", user_id: 91, submission_id: 100, score: 100, user: { id: 91, name: "Jane Learner", email: "jane.student@example.edu" }, answers: [{ id: 6, answer: "private answer" }], comments: "private grading comment", validation_token: PRIVATE_SESSION },
      { quiz_id: 8, workflow_state: "pending_review", user_id: 92, submission_id: 101, score: 42, user: { id: 92, name: "Rowan Learner", email: "rowan.student@example.edu" }, answer: "private pending answer", comment: "private review comment" },
    ];
  };
  const server = createServer({ key: readFileSync(key), cert: readFileSync(certificate) }, (request, response) => {
    const target = new URL(request.url || "/", origin);
    requests.push({ pathname: target.pathname, search: target.search });
    const json = (body, headers = {}) => {
      response.writeHead(200, { "content-type": "application/json", ...headers });
      response.end(JSON.stringify(body));
    };
    if (target.pathname === "/courses/2/quizzes/8") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<!doctype html><title>Canvas fixture</title>");
      return;
    }
    if (target.pathname === "/api/v1/users/self/profile") return json({ id: 3, name: "Instructor Private", primary_email: "instructor@example.edu", session: PRIVATE_SESSION });
    if (target.pathname === "/api/v1/courses/2") return json({ id: mode === "wrong-course" ? 9 : 2, name: "Private course name", enrollment: { user_id: 3 } });
    if (target.pathname === "/api/v1/courses/2/quizzes/8") return json({ id: mode === "wrong-target" ? 9 : 8, title: "Private quiz title", description: "Private quiz description" });
    if (target.pathname === submissionsPath) {
      const page = target.searchParams.get("page");
      const headers = {};
      if (mode === "off-origin") headers.link = '<https://outside.example/api/v1/courses/2/quizzes/8/submissions?per_page=100&page=two>; rel="next"';
      else if (mode === "wrong-path") headers.link = `<${origin}/api/v1/courses/2/quizzes/9/submissions?per_page=100&page=two>; rel="next"`;
      else if (mode === "cycle") headers.link = `<${origin}${submissionsPath}?per_page=100&page=two>; rel="next"`;
      else if (mode === "overflow") {
        const current = Number(page || "0");
        headers.link = `<${origin}${submissionsPath}?per_page=100&page=${current + 1}>; rel="next"`;
      } else if (!page) headers.link = `<${origin}${submissionsPath}?per_page=100&page=two>; rel="next"`;
      return json({ quiz_submissions: privateRows(page) }, headers);
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
    await page.goto(`${origin}/courses/2/quizzes/8`);
    const invoke = (args = { course_id: 2, quiz_id: 8 }, binding = { origin, siteUrl: `${origin}/courses/2/quizzes/8`, principalId: "3", courseId: "2" }, expiresAt = Date.now() + 60_000) => page.evaluate(
      executeCanvasClassicQuizSubmissionSummaryInPage,
      JSON.stringify({ operation: OPERATION, arguments: args, binding, expiresAt }),
    );
    const submissionRequests = () => requests.filter((entry) => entry.pathname === submissionsPath).length;

    const beforeInvalid = submissionRequests();
    assert.deepEqual(await invoke({ course_id: 9, quiz_id: 8 }), { ok: false, sent: false, error: "canvas_classic_quiz_submission_summary_arguments_invalid" });
    assert.deepEqual(await invoke(undefined, { origin, siteUrl: `${origin}/courses/2/quizzes/8`, principalId: "3", courseId: "2" }, Date.now() - 1), { ok: false, sent: false, error: "canvas_classic_quiz_submission_summary_arguments_invalid" });
    assert.equal(submissionRequests(), beforeInvalid);

    mode = "complete";
    const summary = await invoke();
    assert.equal(summary.ok, true, JSON.stringify(summary));
    assert.equal(summary.complete, true);
    assert.match(summary.snapshot_digest, /^[0-9a-f]{64}$/);
    assert.deepEqual(summary.data, {
      schema: "morrow.canvas-classic-quiz-submission-summary.v1",
      provider: "canvas",
      course_id: 2,
      quiz_id: 8,
      attempt_count: 4,
      complete_count: 1,
      pending_review_count: 1,
      workflow_state_counts: { untaken: 1, pending_review: 1, complete: 1, settings_only: 1, preview: 0 },
      proof: {
        method: "GET /api/v1/courses/:course_id/quizzes/:quiz_id/submissions",
        complete: true,
        pagination_complete: true,
        pages_read: 2,
        response_row_count: 4,
        needs_grading_count_proven: false,
      },
    });
    const serialized = JSON.stringify(summary);
    for (const privateValue of [PRIVATE_SESSION, "Instructor Private", "instructor@example.edu", "Private course name", "Private quiz title", "Jane Learner", "Rowan Learner", "jane.student@example.edu", "rowan.student@example.edu", "taylor.student@example.edu", "private answer", "private grading comment", "private review comment", '"user_id":91', '"submission_id":100', '"score":100']) {
      assert.equal(serialized.includes(privateValue), false, `result leaked ${privateValue}`);
    }

    mode = "unknown";
    assert.deepEqual(await invoke(), { ok: false, sent: false, error: "canvas_classic_quiz_submission_response_invalid" });
    mode = "wrong-quiz";
    assert.deepEqual(await invoke(), { ok: false, sent: false, error: "canvas_classic_quiz_submission_response_invalid" });
    mode = "wrong-course";
    assert.deepEqual(await invoke(), { ok: false, sent: false, error: "canvas_classic_quiz_submission_summary_target_unavailable" });
    mode = "wrong-target";
    assert.deepEqual(await invoke(), { ok: false, sent: false, error: "canvas_classic_quiz_submission_summary_target_unavailable" });

    for (const refusal of ["off-origin", "wrong-path", "cycle"]) {
      mode = refusal;
      const before = submissionRequests();
      assert.deepEqual(await invoke(), { ok: false, sent: false, error: "canvas_classic_quiz_submission_pagination_refused" });
      assert.equal(submissionRequests() - before, refusal === "cycle" ? 2 : 1);
    }
    mode = "overflow";
    const beforeOverflow = submissionRequests();
    assert.deepEqual(await invoke(), { ok: false, sent: false, complete: false, error: "canvas_classic_quiz_submission_summary_incomplete" });
    assert.equal(submissionRequests() - beforeOverflow, 25);
  } finally {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Canvas Classic Quiz submission summary is cataloged and routed through the extension worker", () => {
  const root = new URL("../..", import.meta.url);
  const catalog = JSON.parse(readFileSync(new URL("connector/extension/generated/canvas-browser-catalog.json", root), "utf8"));
  const entries = catalog.operations.filter((entry) => entry.key === "canvas.api.v1.course.quiz.submissions.aggregate.read.v1");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].toolName, "canvas_get_classic_quiz_submission_summary");
  assert.equal(entries[0].provider, "canvas");
  assert.equal(entries[0].readOnly, true);
  const worker = readFileSync(new URL("connector/extension/src/service-worker.js", root), "utf8");
  assert.match(worker, /import \{ executeCanvasClassicQuizSubmissionSummaryInPage \} from "\.\/canvas-classic-quiz-submission-read\.js";/);
  assert.match(worker, /CANVAS_CLASSIC_QUIZ_SUBMISSION_SUMMARY_OPERATION_KEY = "canvas\.api\.v1\.course\.quiz\.submissions\.aggregate\.read\.v1"/);
  assert.match(worker, /func: executeCanvasClassicQuizSubmissionSummaryInPage/);
});
