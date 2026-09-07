import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { executeCanvasCourseSummaryInPage } from "../../connector/extension/src/canvas-course-summary-read.js";

const ASSIGNMENT_SUMMARY = "canvas.api.v1.course.assignment.submissions.aggregate.read.v1";
const GRADEBOOK_SUMMARY = "canvas.api.v1.course.gradebook.aggregate.read.v1";
const ACTIVITY_SUMMARY = "canvas.api.v1.course.activity.aggregate.read.v1";
const TOOLS = Object.freeze({
  [ASSIGNMENT_SUMMARY]: "canvas_get_assignment_submission_summary",
  [GRADEBOOK_SUMMARY]: "canvas_get_course_gradebook_summary",
  [ACTIVITY_SUMMARY]: "canvas_get_course_activity_summary",
});
const PRIVATE_SESSION = "canvas-private-session";
const PRIVATE_VALUES = Object.freeze([
  PRIVATE_SESSION, "Instructor Private", "instructor@example.edu", "Private course name", "Private assignment title",
  "Jane Learner", "Rowan Learner", "jane.student@example.edu", "rowan.student@example.edu",
  "private grading comment", "private-essay.pdf", "Private page title", "Private discussion title",
  '"user_id":91', '"submission_id":100', '"score":100',
]);

/** One learner row, carrying every field the aggregate must never publish. */
function learnerRow(assignmentId, workflowState, extra = {}) {
  return {
    assignment_id: assignmentId,
    workflow_state: workflowState,
    user_id: 91,
    submission_id: 100,
    score: 100,
    user: { id: 91, name: "Jane Learner", email: "jane.student@example.edu" },
    submission_comments: [{ id: 5, author_name: "Rowan Learner", comment: "private grading comment" }],
    attachments: [{ id: 6, filename: "private-essay.pdf" }],
    validation_token: PRIVATE_SESSION,
    ...extra,
  };
}

function scoredRows(assignmentId, count, score) {
  return Array.from({ length: count }, () => learnerRow(assignmentId, "graded", { score, excused: false }));
}

test("Canvas course summaries aggregate in the page and publish counts only", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morrow-canvas-course-summaries-"));
  const key = join(directory, "key.pem");
  const certificate = join(directory, "certificate.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", certificate], { stdio: "ignore" });
  const requests = [];
  let origin = "";
  let mode = "complete";
  let browser;
  const day = 24 * 60 * 60 * 1_000;
  const ago = (days) => new Date(Date.now() - (days * day)).toISOString();
  const assignmentSubmissionsPath = "/api/v1/courses/2/assignments/8/submissions";
  const courseSubmissionsPath = "/api/v1/courses/2/students/submissions";
  const assignmentRows = () => [
    { id: 11, name: "Private assignment title", points_possible: 100, updated_at: ago(1) },
    { id: 12, name: "Private assignment title", points_possible: 100, updated_at: ago(2) },
    { id: 13, name: "Private assignment title", points_possible: 50, updated_at: ago(40) },
    { id: 14, name: "Private assignment title", points_possible: 0, updated_at: ago(40) },
  ];
  const courseSubmissionRows = (page) => {
    if (page === "2") {
      return [
        ...scoredRows(13, 5, 48),
        learnerRow(13, "graded", { score: 20, excused: false }),
        ...scoredRows(14, 2, 0),
      ];
    }
    return [
      ...scoredRows(11, 10, 95),
      learnerRow(11, "submitted"),
      learnerRow(11, "submitted"),
      learnerRow(11, "pending_review"),
      learnerRow(11, "unsubmitted"),
      learnerRow(12, "graded", { score: 90, excused: false }),
      learnerRow(12, "graded", { score: 80, excused: false }),
      learnerRow(12, "graded", { score: 70, excused: false }),
    ];
  };
  const assignmentSubmissionRows = (page) => {
    if (mode === "unknown-state") return [learnerRow(8, "returned")];
    if (mode === "wrong-assignment") return [learnerRow(9, "graded")];
    if (mode === "overflow") return [learnerRow(8, "graded")];
    if (page === "2") {
      return [
        learnerRow(8, "unsubmitted", { late: false, missing: true, excused: false }),
        learnerRow(8, "graded", { late: false, missing: false, excused: true }),
      ];
    }
    return [
      learnerRow(8, "graded", { late: false, missing: false, excused: false }),
      learnerRow(8, "submitted", { late: true, missing: false, excused: null }),
      learnerRow(8, "pending_review", { late: false, missing: false }),
    ];
  };
  const server = createServer({ key: readFileSync(key), cert: readFileSync(certificate) }, (request, response) => {
    const target = new URL(request.url || "/", origin);
    requests.push({ pathname: target.pathname, search: target.search });
    const page = target.searchParams.get("page");
    const json = (body, headers = {}) => {
      response.writeHead(200, { "content-type": "application/json", ...headers });
      response.end(JSON.stringify(body));
    };
    const nextLink = (path, query) => ({ link: `<${origin}${path}?${query}&page=2>; rel="next"` });
    if (target.pathname === "/courses/2") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<!doctype html><title>Canvas fixture</title>");
      return;
    }
    if (target.pathname === "/api/v1/users/self/profile") return json({ id: 3, name: "Instructor Private", primary_email: "instructor@example.edu", session: PRIVATE_SESSION });
    if (target.pathname === "/api/v1/courses/2") return json({ id: 2, name: "Private course name" });
    if (target.pathname === "/api/v1/courses/2/assignments/8") {
      if (mode === "wrong-assignment-record") return json({ id: 9, name: "Private assignment title" });
      return json({
        id: 8,
        name: "Private assignment title",
        ...(mode === "no-needs-grading" ? {} : { needs_grading_count: 3 }),
      });
    }
    if (target.pathname === assignmentSubmissionsPath) {
      const headers = {};
      if (mode === "off-origin") headers.link = `<https://outside.example${assignmentSubmissionsPath}?per_page=100&page=2>; rel="next"`;
      else if (mode === "foreign-parameter") headers.link = `<${origin}${assignmentSubmissionsPath}?per_page=100&page=2&as_user_id=91>; rel="next"`;
      else if (mode === "overflow") headers.link = `<${origin}${assignmentSubmissionsPath}?per_page=100&page=${Number(page || "1") + 1}>; rel="next"`;
      else if (!page) Object.assign(headers, nextLink(assignmentSubmissionsPath, "per_page=100"));
      return json(assignmentSubmissionRows(page), headers);
    }
    if (target.pathname === courseSubmissionsPath) {
      const headers = page ? {} : nextLink(courseSubmissionsPath, "student_ids%5B%5D=all&per_page=100");
      return json(courseSubmissionRows(page), headers);
    }
    if (target.pathname === "/api/v1/courses/2/assignments") return json(assignmentRows());
    if (target.pathname === "/api/v1/courses/2/pages") {
      return json([
        { page_id: 21, title: "Private page title", updated_at: ago(1) },
        { page_id: 22, title: "Private page title", updated_at: ago(2) },
        { page_id: 23, title: "Private page title", updated_at: ago(30) },
      ]);
    }
    if (target.pathname === "/api/v1/courses/2/discussion_topics") {
      return json([
        { id: 31, title: "Private discussion title", updated_at: ago(1) },
        { id: 32, title: "Private discussion title", updated_at: ago(60) },
      ]);
    }
    if (target.pathname === "/api/v1/courses/2/quizzes") {
      return json(mode === "quiz-timestamps"
        ? [{ id: 41, title: "Private assignment title", updated_at: ago(3) }, { id: 42, title: "Private assignment title", updated_at: ago(90) }]
        : [{ id: 41, title: "Private assignment title" }, { id: 42, title: "Private assignment title" }]);
    }
    if (target.pathname === "/api/v1/courses/2/modules") return json([{ id: 51, name: "Private page title", updated_at: ago(1) }]);
    response.writeHead(404).end();
  });
  try {
    await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", (error) => error ? reject(error) : resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");
    origin = `https://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
    const page = await browser.newPage({ ignoreHTTPSErrors: true });
    await page.goto(`${origin}/courses/2`);
    const invoke = (key, args, binding, expiresAt = Date.now() + 60_000) => page.evaluate(
      executeCanvasCourseSummaryInPage,
      JSON.stringify({
        operation: { key, toolName: TOOLS[key], provider: "canvas", readOnly: true },
        arguments: args,
        binding: binding || { origin, siteUrl: `${origin}/courses/2`, principalId: "3", courseId: "2" },
        expiresAt,
      }),
    );
    const requestCount = (pathname) => requests.filter((entry) => entry.pathname === pathname).length;
    const noLeak = (value) => {
      const serialized = JSON.stringify(value);
      for (const privateValue of PRIVATE_VALUES) {
        assert.equal(serialized.includes(privateValue), false, `result leaked ${privateValue}`);
      }
    };

    // Arguments are checked before any provider request.
    const beforeInvalid = requestCount(assignmentSubmissionsPath);
    assert.deepEqual(
      await invoke(ASSIGNMENT_SUMMARY, { course_id: 9, assignment_id: 8 }),
      { ok: false, sent: false, error: "canvas_assignment_submission_summary_arguments_invalid" },
    );
    assert.deepEqual(
      await invoke(ASSIGNMENT_SUMMARY, { course_id: 2, assignment_id: 8 }, undefined, Date.now() - 1),
      { ok: false, sent: false, error: "canvas_assignment_submission_summary_arguments_invalid" },
    );
    assert.deepEqual(
      await invoke(ACTIVITY_SUMMARY, { course_id: 2, days: 0 }),
      { ok: false, sent: false, error: "canvas_course_activity_summary_arguments_invalid" },
    );
    assert.deepEqual(
      await invoke(GRADEBOOK_SUMMARY, { course_id: 2, assignment_id: 8 }),
      { ok: false, sent: false, error: "canvas_course_gradebook_summary_arguments_invalid" },
    );
    assert.equal(requestCount(assignmentSubmissionsPath), beforeInvalid);

    // 1. Assignment submission summary.
    const assignmentSummary = await invoke(ASSIGNMENT_SUMMARY, { course_id: 2, assignment_id: 8 });
    assert.equal(assignmentSummary.ok, true, JSON.stringify(assignmentSummary));
    assert.match(assignmentSummary.snapshot_digest, /^[0-9a-f]{64}$/);
    assert.deepEqual(assignmentSummary.data, {
      schema: "morrow.canvas-assignment-submission-summary.v1",
      provider: "canvas",
      course_id: 2,
      assignment_id: 8,
      submission_count: 5,
      workflow_state_counts: { unsubmitted: 1, submitted: 1, graded: 2, pending_review: 1 },
      late_count: 1,
      missing_count: 1,
      excused_count: 1,
      needs_grading_count: 3,
      proof: {
        method: "GET /api/v1/courses/:course_id/assignments/:assignment_id/submissions",
        complete: true,
        pagination_complete: true,
        pages_read: 2,
        response_row_count: 5,
        needs_grading_count_source: "assignment_record",
      },
    });
    noLeak(assignmentSummary);

    mode = "no-needs-grading";
    const withoutNeedsGrading = await invoke(ASSIGNMENT_SUMMARY, { course_id: 2, assignment_id: 8 });
    assert.equal(withoutNeedsGrading.data.needs_grading_count, null);
    assert.equal(withoutNeedsGrading.data.proof.needs_grading_count_source, "unavailable");

    // 2. Gradebook summary: a small cohort is suppressed instead of bucketed.
    mode = "complete";
    const gradebook = await invoke(GRADEBOOK_SUMMARY, { course_id: 2 });
    assert.equal(gradebook.ok, true, JSON.stringify(gradebook));
    assert.deepEqual(gradebook.data, {
      schema: "morrow.canvas-course-gradebook-summary.v1",
      provider: "canvas",
      course_id: 2,
      assignment_count: 4,
      submission_count: 25,
      minimum_cohort: 5,
      assignments: [
        {
          assignment_id: 11,
          submitted_count: 2,
          graded_count: 10,
          ungraded_count: 3,
          scored_count: 10,
          score_distribution_state: "reported",
          score_distribution: { below_60: 0, "60_to_69": 0, "70_to_79": 0, "80_to_89": 0, "90_and_above": 10 },
        },
        {
          assignment_id: 12,
          submitted_count: 0,
          graded_count: 3,
          ungraded_count: 0,
          scored_count: 3,
          score_distribution_state: "suppressed_cohort_below_minimum",
          score_distribution: null,
        },
        {
          assignment_id: 13,
          submitted_count: 0,
          graded_count: 6,
          ungraded_count: 0,
          scored_count: 6,
          score_distribution_state: "suppressed_bucket_below_minimum",
          score_distribution: null,
        },
        {
          assignment_id: 14,
          submitted_count: 0,
          graded_count: 2,
          ungraded_count: 0,
          scored_count: 0,
          score_distribution_state: "unscored_assignment",
          score_distribution: null,
        },
      ],
      proof: {
        method: "GET /api/v1/courses/:course_id/students/submissions",
        complete: true,
        pagination_complete: true,
        assignment_pages_read: 1,
        submission_pages_read: 2,
        response_row_count: 25,
        ungraded_definition: "submitted_and_pending_review",
        score_scale: "percentage_of_points_possible",
        minimum_bucket_population: 5,
      },
    });
    noLeak(gradebook);

    // 3. Course activity summary: a kind without the timestamp is not counted as unchanged.
    const activity = await invoke(ACTIVITY_SUMMARY, { course_id: 2, days: 7 });
    assert.equal(activity.ok, true, JSON.stringify(activity));
    assert.deepEqual(activity.data.kinds, {
      pages: { state: "counted", changed_count: 2, item_count: 3 },
      assignments: { state: "counted", changed_count: 2, item_count: 4 },
      discussions: { state: "counted", changed_count: 1, item_count: 2 },
      quizzes: { state: "timestamp_unavailable", changed_count: null, item_count: 2 },
      modules: { state: "counted", changed_count: 1, item_count: 1 },
    });
    assert.equal(activity.data.window_days, 7);
    assert.match(activity.data.window_start, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.deepEqual(activity.data.proof, {
      method: "GET /api/v1/courses/:course_id/{pages,assignments,discussion_topics,quizzes,modules}",
      complete: true,
      pagination_complete: true,
      pages_read: 5,
      timestamp_field: "updated_at",
      item_limit_per_kind: 2_000,
    });
    noLeak(activity);

    mode = "quiz-timestamps";
    const countedQuizzes = await invoke(ACTIVITY_SUMMARY, { course_id: 2, days: 7 });
    assert.deepEqual(countedQuizzes.data.kinds.quizzes, { state: "counted", changed_count: 1, item_count: 2 });

    // 4. Refusals: an unreadable row, a changed target, a foreign or extended
    //    pagination link, and a read that reaches the page cap.
    mode = "unknown-state";
    assert.deepEqual(
      await invoke(ASSIGNMENT_SUMMARY, { course_id: 2, assignment_id: 8 }),
      { ok: false, sent: false, error: "canvas_assignment_submission_summary_response_invalid" },
    );
    mode = "wrong-assignment";
    assert.deepEqual(
      await invoke(ASSIGNMENT_SUMMARY, { course_id: 2, assignment_id: 8 }),
      { ok: false, sent: false, error: "canvas_assignment_submission_summary_response_invalid" },
    );
    mode = "wrong-assignment-record";
    assert.deepEqual(
      await invoke(ASSIGNMENT_SUMMARY, { course_id: 2, assignment_id: 8 }),
      { ok: false, sent: false, error: "canvas_assignment_submission_summary_target_unavailable" },
    );
    for (const refusal of ["off-origin", "foreign-parameter"]) {
      mode = refusal;
      const before = requestCount(assignmentSubmissionsPath);
      assert.deepEqual(
        await invoke(ASSIGNMENT_SUMMARY, { course_id: 2, assignment_id: 8 }),
        { ok: false, sent: false, error: "canvas_assignment_submission_summary_pagination_refused" },
      );
      assert.equal(requestCount(assignmentSubmissionsPath) - before, 1);
    }
    mode = "overflow";
    const beforeOverflow = requestCount(assignmentSubmissionsPath);
    const truncated = await invoke(ASSIGNMENT_SUMMARY, { course_id: 2, assignment_id: 8 });
    assert.deepEqual(truncated, { ok: false, sent: false, complete: false, error: "canvas_assignment_submission_summary_incomplete" });
    assert.equal(requestCount(assignmentSubmissionsPath) - beforeOverflow, 25);
  } finally {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Canvas course summaries are cataloged and routed through the extension worker", () => {
  const root = new URL("../..", import.meta.url);
  const catalog = JSON.parse(readFileSync(new URL("connector/extension/generated/canvas-browser-catalog.json", root), "utf8"));
  const worker = readFileSync(new URL("connector/extension/src/service-worker.js", root), "utf8");
  assert.match(worker, /import \{ executeCanvasCourseSummaryInPage \} from "\.\/canvas-course-summary-read\.js";/);
  assert.match(worker, /func: executeCanvasCourseSummaryInPage/);
  for (const [key, toolName] of Object.entries(TOOLS)) {
    const entries = catalog.operations.filter((entry) => entry.key === key);
    assert.equal(entries.length, 1, `${key} must be cataloged once`);
    assert.equal(entries[0].toolName, toolName);
    assert.equal(entries[0].provider, "canvas");
    assert.equal(entries[0].readOnly, true);
    assert.equal(entries[0].inputSchema.additionalProperties, false);
    assert.ok(entries[0].inputSchema.required.includes("course_id"));
    assert.ok(entries[0].description.includes("counts only"));
    assert.ok(worker.includes(`["${key}", "${toolName}"]`), `${key} must be routed by the worker`);
  }
  const bundle = readFileSync(new URL("scripts/package-mcp-bundle.mjs", root), "utf8");
  assert.ok(bundle.includes('"src/canvas-course-summary-read.js"'), "the reader must ship in the extension bundle");
});
