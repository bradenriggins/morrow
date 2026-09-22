import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import {
  executeMoodleAssignmentFeedbackInPage,
  executeMoodleAssignmentSubmissionInPage,
} from "../../connector/extension/src/moodle-assignment-submission-read.js";

const SUBMISSION_OPERATION = Object.freeze({
  key: "moodle.form.assign.submission.read.v1",
  toolName: "moodle_get_assignment_submission",
  provider: "moodle",
  readOnly: true,
});
const FEEDBACK_OPERATION = Object.freeze({
  key: "moodle.form.assign.feedback.read.v1",
  toolName: "moodle_get_assignment_feedback",
  provider: "moodle",
  readOnly: true,
});
const STATUS_METHOD = "mod_assign_get_submission_status";

test("Moodle Assignment learner reads are cataloged and routed through the extension worker", () => {
  const root = new URL("../..", import.meta.url);
  const catalog = JSON.parse(readFileSync(new URL("connector/extension/generated/moodle-browser-catalog.json", root), "utf8"));
  for (const [key, toolName, capability] of [
    ["moodle.form.assign.submission.read.v1", "moodle_get_assignment_submission", "mod/assign:viewgrades"],
    ["moodle.form.assign.feedback.read.v1", "moodle_get_assignment_feedback", "mod/assign:grade"],
  ]) {
    const entries = catalog.operations.filter((entry) => entry.key === key);
    assert.equal(entries.length, 1, `${key} must be cataloged exactly once`);
    assert.equal(entries[0].toolName, toolName);
    assert.equal(entries[0].provider, "moodle");
    assert.equal(entries[0].readOnly, true);
    assert.equal(entries[0].dataClass, "learner");
    assert.equal(entries[0].family, "learner-data");
    // The description must state the required capability and the route limit
    // before an assistant calls it.
    assert.ok(entries[0].description.includes(capability), `${toolName} must state ${capability}`);
    assert.match(entries[0].description, /without the AJAX flag/);
    assert.match(entries[0].description, /learner token/);
  }
  const worker = readFileSync(new URL("connector/extension/src/service-worker.js", root), "utf8");
  assert.match(worker, /import \{ executeMoodleAssignmentFeedbackInPage, executeMoodleAssignmentSubmissionInPage \} from "\.\/moodle-assignment-submission-read\.js";/);
  assert.match(worker, /MOODLE_ASSIGNMENT_SUBMISSION_OPERATION_KEY = "moodle\.form\.assign\.submission\.read\.v1"/);
  assert.match(worker, /MOODLE_ASSIGNMENT_FEEDBACK_OPERATION_KEY = "moodle\.form\.assign\.feedback\.read\.v1"/);
  assert.match(worker, /func: executeMoodleAssignmentSubmissionInPage/);
  assert.match(worker, /func: executeMoodleAssignmentFeedbackInPage/);
});

test("Moodle Assignment learner reads bind one activity and return metadata only", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morrow-moodle-assign-learner-"));
  const key = join(directory, "key.pem");
  const certificate = join(directory, "certificate.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", certificate], { stdio: "ignore" });
  const PRIVATE_SESSION = "moodle-private-session";
  const PRIVATE_ESSAY = "Jane Moodle wrote this essay about mitosis.";
  const PRIVATE_COMMENT = "Good work Jane, see the marked copy.";
  const requests = [];
  let origin = "";
  let mode = "complete";
  let browser;
  const submissionFiles = () => {
    if (mode === "over-file-cap") {
      return Array.from({ length: 201 }, (_, index) => ({
        filename: `page-${index}.pdf`, filepath: "/", filesize: 100, fileurl: `${origin}/pluginfile.php/99/assignsubmission_file/submission_files/501/page-${index}.pdf`,
        timemodified: 1_700_000_600, mimetype: "application/pdf", isexternalfile: false,
      }));
    }
    return [{
      filename: "Jane Moodle essay.pdf", filepath: "/", filesize: 18_321,
      fileurl: `${origin}/pluginfile.php/99/assignsubmission_file/submission_files/501/Jane%20Moodle%20essay.pdf?forcedownload=1`,
      timemodified: 1_700_000_600, mimetype: "application/pdf", isexternalfile: false, repositorytype: "",
    }];
  };
  const lastAttempt = () => {
    const attempt = {
      submissionsenabled: true, locked: false, graded: true, canedit: false, caneditowner: false,
      cansubmit: false, extensionduedate: 0, blindmarking: false, gradingstatus: "readyforrelease", usergroups: [],
      submission: {
        id: 501, userid: 7, attemptnumber: 1, timecreated: 1_700_000_000, timemodified: 1_700_000_600,
        timestarted: 1_699_999_000, status: "submitted", groupid: 0, assignment: 71, latest: 1,
        plugins: [
          {
            type: "onlinetext", name: "Online text",
            editorfields: [{ name: "onlinetext", description: "Online text", text: `<p>${PRIVATE_ESSAY}</p>`, format: 1 }],
            fileareas: [{ area: "submissions_onlinetext", files: [] }],
          },
          { type: "file", name: "File submissions", fileareas: [{ area: "submission_files", files: submissionFiles() }] },
          { type: "comments", name: "Submission comments" },
        ],
      },
    };
    if (mode === "no-submission") {
      delete attempt.submission;
      attempt.graded = false;
      attempt.gradingstatus = "notmarked";
    }
    if (mode === "team-submission") attempt.teamsubmission = { id: 900, userid: 0, attemptnumber: 0, timecreated: 1, timemodified: 1, status: "submitted", groupid: 4 };
    if (mode === "bad-status") attempt.submission.status = "invented";
    return attempt;
  };
  const feedback = () => ({
    grade: {
      id: 9, assignment: 71, userid: 7, attemptnumber: 1, timecreated: 1_700_001_000,
      timemodified: 1_700_001_200, grader: 3, grade: mode === "ungraded" ? "-1.00000" : "85.00000",
    },
    gradefordisplay: "85.00 / 100.00", gradeddate: 1_700_001_200,
    plugins: [
      {
        type: "comments", name: "Feedback comments",
        editorfields: [{ name: "comments", description: "Feedback comments", text: `<p>${PRIVATE_COMMENT}</p>`, format: 1 }],
      },
      {
        type: "file", name: "Feedback files",
        fileareas: [{ area: "feedback_files", files: [{
          filename: "marked-Jane Moodle.pdf", filepath: "/", filesize: 4_096,
          fileurl: `${origin}/pluginfile.php/99/assignfeedback_file/feedback_files/9/marked-Jane%20Moodle.pdf`,
          timemodified: 1_700_001_200, mimetype: "application/pdf", isexternalfile: false,
        }] }],
      },
    ],
  });
  const submissionStatus = () => {
    const payload = {
      gradingsummary: { participantcount: 2, submissiondraftscount: 0, submissionsenabled: true, submissionssubmittedcount: 1, submissionsneedgradingcount: 0, warnofungroupedusers: "" },
      lastattempt: lastAttempt(),
      feedback: feedback(),
      previousattempts: [{ attemptnumber: 0, submission: { id: 500, userid: 7, attemptnumber: 0, timecreated: 1, timemodified: 2, status: "submitted", groupid: 0 } }],
      assignmentdata: { activity: "Write an essay", activityformat: 1 },
      warnings: [],
    };
    if (mode === "no-feedback") delete payload.feedback;
    if (mode === "no-last-attempt") delete payload.lastattempt;
    return payload;
  };
  const assignForm = () => {
    const module = mode === "wrong-module" ? "99" : "8";
    const course = mode === "wrong-course" ? "9" : "2";
    const instance = mode === "missing-instance" ? "" : "71";
    const name = mode === "wrong-type" ? "quiz" : "assign";
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
      response.writeHead(200, { "content-type": "text/html" }); response.end(assignForm()); return;
    }
    if (request.method === "POST" && target.pathname === "/lib/ajax/service.php") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const call = message[0];
      const json = (payload) => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(payload)); };
      if (target.search === `?sesskey=${PRIVATE_SESSION}&info=${STATUS_METHOD}`) {
        assert.deepEqual(call, { index: 0, methodname: STATUS_METHOD, args: { assignid: 71, userid: 7, groupid: 0 } });
        if (mode === "service-blocked") {
          json([{ index: 0, error: true, exception: { message: "Service not available.", errorcode: "servicenotavailable", module: "webservice" } }]);
          return;
        }
        if (mode === "permission-blocked") {
          json([{ index: 0, error: true, exception: { message: "Sorry, but you do not currently have permissions to do that.", errorcode: "nopermission", module: "" } }]);
          return;
        }
        json([{ index: 0, data: submissionStatus() }]);
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
    const submission = (args = { course_id: 2, module_id: 8, user_id: 7 }) => call(executeMoodleAssignmentSubmissionInPage, SUBMISSION_OPERATION, args);
    const feedbackRead = (args = { course_id: 2, module_id: 8, user_id: 7 }) => call(executeMoodleAssignmentFeedbackInPage, FEEDBACK_OPERATION, args);
    const sourceRequests = () => requests.filter((entry) => entry.pathname === "/course/modedit.php" || entry.pathname === "/lib/ajax/service.php").length;
    const ajaxRequests = () => requests.filter((entry) => entry.pathname === "/lib/ajax/service.php").length;

    const beforeInvalid = sourceRequests();
    assert.deepEqual(await submission({ course_id: 2, module_id: 8 }), { ok: false, sent: false, error: "moodle_assignment_submission_arguments_invalid" });
    assert.deepEqual(await feedbackRead({ course_id: 2, module_id: 8, user_id: 7, extra: true }), { ok: false, sent: false, error: "moodle_assignment_feedback_arguments_invalid" });
    assert.equal(sourceRequests(), beforeInvalid);

    const learner = await submission();
    assert.equal(learner.ok, true, JSON.stringify(learner));
    assert.equal(learner.complete, true);
    assert.deepEqual(learner.data, {
      schema: "morrow.moodle-assignment-submission.v1", provider: "moodle", course_id: 2, module_id: 8, assignment_id: 71,
      learner: { user_id: "7" },
      attempt: { attempt_number: 1, status: "submitted", time_created: 1_700_000_000, time_modified: 1_700_000_600, time_started: 1_699_999_000 },
      grading_status: "readyforrelease", locked: false, graded: true, blind_marking: false, extension_due_date: null,
      submission_types: [
        { type: "comments", has_content: false, file_count: 0 },
        { type: "file", has_content: true, file_count: 1 },
        { type: "onlinetext", has_content: true, file_count: 0 },
      ],
      files: [{
        plugin_type: "file", area: "submission_files", file_name: "Jane Moodle essay.pdf", file_path: "/",
        file_size: 18_321, mime_type: "application/pdf", time_modified: 1_700_000_600,
      }],
      proof: {
        method: STATUS_METHOD, complete: true, exact_module_binding: "course_modedit_form",
        required_capability: "mod/assign:viewgrades", submission_type_limit: 20, file_limit: 200,
        file_count: 1, includes_file_bytes: false,
      },
    });

    const marked = await feedbackRead();
    assert.equal(marked.ok, true, JSON.stringify(marked));
    assert.deepEqual(marked.data, {
      schema: "morrow.moodle-assignment-feedback.v1", provider: "moodle", course_id: 2, module_id: 8, assignment_id: 71,
      learner: { user_id: "7" }, grading_status: "readyforrelease", marking_workflow_state: "readyforrelease",
      graded: true, grade_value: 85, grade_attempt_number: 1, graded_date: 1_700_001_200,
      feedback_types: [
        { type: "comments", comment_present: true, file_count: 0 },
        { type: "file", comment_present: false, file_count: 1 },
      ],
      files: [{
        plugin_type: "file", area: "feedback_files", file_name: "marked-Jane Moodle.pdf", file_path: "/",
        file_size: 4_096, mime_type: "application/pdf", time_modified: 1_700_001_200,
      }],
      proof: {
        method: STATUS_METHOD, complete: true, exact_module_binding: "course_modedit_form",
        required_capability: "mod/assign:grade", feedback_type_limit: 20, file_limit: 200,
        file_count: 1, includes_feedback_text: false, includes_file_bytes: false,
      },
    });

    const submissionText = JSON.stringify(learner);
    const feedbackText = JSON.stringify(marked);
    for (const privateValue of [PRIVATE_SESSION, PRIVATE_ESSAY, PRIVATE_COMMENT, "pluginfile.php", "fileurl", "gradefordisplay", "grader", "Write an essay"]) {
      assert.equal(submissionText.includes(privateValue), false, `submission read leaked ${privateValue}`);
      assert.equal(feedbackText.includes(privateValue), false, `feedback read leaked ${privateValue}`);
    }
    // Each read names exactly one learner, and only inside `learner`.
    assert.equal(submissionText.includes('"user_id":"7"'), true);
    assert.equal(feedbackText.includes('"user_id":"7"'), true);
    assert.equal(submissionText.split('"user_id"').length - 1, 1);
    assert.equal(feedbackText.split('"user_id"').length - 1, 1);

    // A view of the Assignment records completion and a grading-table event, so
    // neither read may open one.
    for (const path of ["/mod/assign/view.php", "/mod/assign/grade.php", "/mod/assign/index.php"]) {
      assert.equal(requests.some((entry) => entry.pathname === path), false, `an Assignment learner read requested ${path}`);
    }

    mode = "no-submission";
    const empty = await submission();
    assert.equal(empty.ok, true, JSON.stringify(empty));
    assert.equal(empty.data.attempt, null);
    assert.deepEqual(empty.data.submission_types, []);
    assert.deepEqual(empty.data.files, []);
    assert.equal(empty.data.grading_status, "notmarked");

    mode = "no-feedback";
    const unmarked = await feedbackRead();
    assert.equal(unmarked.ok, true, JSON.stringify(unmarked));
    assert.equal(unmarked.data.grade_value, null);
    assert.equal(unmarked.data.grade_attempt_number, null);
    assert.equal(unmarked.data.graded_date, null);
    assert.deepEqual(unmarked.data.feedback_types, []);

    mode = "ungraded";
    const negative = await feedbackRead();
    assert.equal(negative.ok, true, JSON.stringify(negative));
    assert.equal(negative.data.grade_value, null);
    assert.equal(negative.data.grade_attempt_number, 1);

    for (const failure of ["wrong-module", "wrong-course", "missing-instance", "wrong-type"]) {
      mode = failure;
      const before = ajaxRequests();
      assert.deepEqual(await submission(), { ok: false, sent: false, error: "moodle_assignment_submission_target_unavailable" });
      assert.deepEqual(await feedbackRead(), { ok: false, sent: false, error: "moodle_assignment_feedback_target_unavailable" });
      assert.equal(ajaxRequests(), before, `${failure} still reached the AJAX service`);
    }

    // Moodle v5.2.2 registers mod_assign_get_submission_status without the AJAX
    // flag, so lib/ajax/service.php refuses it. Both reads must name that exact
    // condition and return no record.
    mode = "service-blocked";
    assert.deepEqual(await submission(), { ok: false, sent: false, error: "moodle_assignment_submission_service_unavailable" });
    assert.deepEqual(await feedbackRead(), { ok: false, sent: false, error: "moodle_assignment_feedback_service_unavailable" });

    mode = "permission-blocked";
    assert.deepEqual(await submission(), { ok: false, sent: false, error: "moodle_assignment_submission_permission_unavailable" });
    assert.deepEqual(await feedbackRead(), { ok: false, sent: false, error: "moodle_assignment_feedback_permission_unavailable" });

    mode = "team-submission";
    assert.deepEqual(await submission(), { ok: false, sent: false, error: "moodle_assignment_submission_team_unsupported" });
    assert.deepEqual(await feedbackRead(), { ok: false, sent: false, error: "moodle_assignment_feedback_team_unsupported" });

    mode = "no-last-attempt";
    assert.deepEqual(await submission(), { ok: false, sent: false, error: "moodle_assignment_submission_detail_unavailable" });
    assert.deepEqual(await feedbackRead(), { ok: false, sent: false, error: "moodle_assignment_feedback_detail_unavailable" });

    mode = "bad-status";
    assert.deepEqual(await submission(), { ok: false, sent: false, error: "moodle_assignment_submission_response_invalid" });

    mode = "over-file-cap";
    assert.deepEqual(await submission(), { ok: false, sent: false, complete: false, error: "moodle_assignment_submission_incomplete" });

    mode = "complete";
    const expired = await page.evaluate(
      executeMoodleAssignmentSubmissionInPage,
      JSON.stringify({ operation: SUBMISSION_OPERATION, arguments: { course_id: 2, module_id: 8, user_id: 7 }, binding: { origin, siteUrl: `${origin}/`, principalId: "3", courseId: "2" }, expiresAt: Date.now() - 1 }),
    );
    assert.deepEqual(expired, { ok: false, sent: false, error: "moodle_assignment_submission_arguments_invalid" });

    const allowed = ["/course/view.php", "/course/modedit.php", "/lib/ajax/service.php", "/favicon.ico"];
    assert.deepEqual([...new Set(requests.map((entry) => entry.pathname))].filter((path) => !allowed.includes(path)), []);
  } finally {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
});
