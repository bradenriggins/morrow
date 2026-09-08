import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { executeMoodleEnrolmentCandidateInPage } from "../../connector/extension/src/moodle-enrolment-executor.js";

const COURSE_ID = 2;
const PRINCIPAL_ID = 3;
const OPERATION = Object.freeze({
  key: "moodle.private.enrolment_candidate.find.v1",
  toolName: "morrow_private_moodle_find_enrolment_candidate",
  provider: "moodle",
  readOnly: true,
  morrowPrivate: true,
});

test("the private resolver returns only one native candidate ID and refuses unsafe or incomplete readings", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morrow-moodle-candidate-"));
  const key = join(directory, "key.pem");
  const certificate = join(directory, "certificate.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", certificate], { stdio: "ignore" });
  const requests = [];
  let origin = "";
  let browser;
  const initialModel = () => ({
    courseId: COURSE_ID,
    methods: ["7"],
    candidates: [{ id: "21", name: "Mary Jackson", email: "mary@example.edu" }],
    echoQuery: true,
    includeSearch: true,
    includeCandidates: true,
    includeRole: true,
    includeAdd: true,
    candidateMultiple: true,
    redirectManage: false,
    oversizedManage: false,
  });
  let model = initialModel();
  const escape = (value) => String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const courseBody = (content, courseId = model.courseId) => `<!doctype html><html><body class="path-enrol course-${courseId}">${content}</body></html>`;
  const methodsPage = () => courseBody(`<table><tbody>${model.methods.map((enrolId) => (
    `<tr><td>Manual enrolments</td><td><a href="/enrol/manual/manage.php?enrolid=${enrolId}&amp;id=${COURSE_ID}">Enrol users</a></td></tr>`
  )).join("")}</tbody></table>`);
  const managePage = (query) => {
    const options = model.candidates.map((candidate) => (
      `<option value="${candidate.id}">${escape(candidate.name)} (${escape(candidate.email)})</option>`
    )).join("");
    return courseBody(`<form id="assignform" method="post" action="/enrol/manual/manage.php?enrolid=7&amp;id=${COURSE_ID}"><div>`
      + (model.includeSearch ? `<input type="text" name="addselect_searchtext" value="${escape(model.echoQuery ? query : "different query")}">` : "")
      + (model.includeCandidates ? `<select name="addselect[]"${model.candidateMultiple ? " multiple" : ""}>${options}</select>` : "")
      + (model.includeRole ? `<select name="roleid"><option value="5">Student</option></select>` : "")
      + (model.includeAdd ? `<input type="submit" name="add" value="Add">` : "")
      + `</div></form>`);
  };

  const server = createServer({ key: readFileSync(key), cert: readFileSync(certificate) }, (request, response) => {
    const target = new URL(request.url || "/", origin);
    requests.push({ method: request.method, pathname: target.pathname, search: target.search });
    if (request.method === "GET" && target.pathname === "/course/view.php") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<!doctype html><html><body class="path-course course-${COURSE_ID}"><script>var M = { cfg: ${JSON.stringify({ wwwroot: origin, userId: PRINCIPAL_ID, courseId: COURSE_ID })} };</script></body></html>`);
      return;
    }
    if (request.method === "GET" && target.pathname === "/enrol/instances.php") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(methodsPage());
      return;
    }
    if (request.method === "GET" && target.pathname === "/enrol/manual/manage.php") {
      if (model.redirectManage) {
        response.writeHead(302, { location: `/login/index.php` }).end();
        return;
      }
      if (model.oversizedManage) {
        response.writeHead(200, { "content-type": "text/html", "content-length": String(2 * 1024 * 1024 + 1) });
        response.end("x");
        return;
      }
      response.writeHead(200, { "content-type": "text/html" });
      response.end(managePage(target.searchParams.get("addselect_searchtext") || ""));
      return;
    }
    response.writeHead(404, { "content-type": "text/plain" }).end("missing");
  });

  try {
    await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", (error) => (error ? reject(error) : resolve())));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("candidate fixture did not bind");
    origin = `https://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
    const page = await browser.newPage({ ignoreHTTPSErrors: true });
    await page.goto(`${origin}/course/view.php?id=${COURSE_ID}`);
    const binding = { origin, siteUrl: `${origin}/`, principalId: String(PRINCIPAL_ID), courseId: String(COURSE_ID) };
    const run = (query = "Mary Jackson", overrides = {}) => page.evaluate(
      executeMoodleEnrolmentCandidateInPage,
      JSON.stringify({
        operation: overrides.operation || OPERATION,
        arguments: overrides.arguments || { course_id: COURSE_ID, query },
        binding: overrides.binding || binding,
        expiresAt: overrides.expiresAt ?? Date.now() + 60_000,
      }),
    );
    const refusal = async (error, configure = () => undefined, overrides = {}) => {
      model = initialModel();
      configure(model);
      const before = requests.length;
      const result = await run(overrides.query, overrides);
      assert.deepEqual([result.ok, result.sent, result.error], [false, false, error], JSON.stringify(result));
      assert.ok(requests.slice(before).every((entry) => entry.method === "GET"), `resolver sent a non-GET while refusing ${error}`);
      return result;
    };

    let before = requests.length;
    const resolved = await run();
    assert.deepEqual(resolved, {
      ok: true,
      sent: false,
      status: 200,
      complete: true,
      data: {
        schema: "morrow.moodle-enrolment-candidate.private.v1",
        provider: "moodle",
        course_id: COURSE_ID,
        candidate: { user_id: "21" },
        match: { kind: "exact_native_query", candidate_count: 1 },
        proof: {
          method: "native_manual_enrolment_candidate_search",
          route: "/enrol/manual/manage.php",
          complete: true,
          dispatch_count: 0,
          read_request_count: 2,
          candidate_limit: 100,
        },
      },
    });
    const safe = JSON.stringify(resolved);
    for (const privateValue of ["Mary Jackson", "mary@example.edu"]) assert.ok(!safe.includes(privateValue));
    const successRequests = requests.slice(before).filter((entry) => entry.pathname.startsWith("/enrol/"));
    assert.equal(successRequests.length, 2);
    assert.ok(successRequests.every((entry) => entry.method === "GET"));
    const manageRequest = successRequests.find((entry) => entry.pathname === "/enrol/manual/manage.php");
    const manageQuery = new URLSearchParams(manageRequest.search);
    assert.equal(manageQuery.get("addselect_searchtext"), "Mary Jackson");
    assert.equal(manageQuery.has("userselector_searchtype"), false, "read must not change Moodle's search-type preference");

    model = initialModel();
    const fullLabel = await run("Mary Jackson (mary@example.edu)");
    assert.equal(fullLabel.data.candidate.user_id, "21");
    assert.ok(!JSON.stringify(fullLabel).includes("mary@example.edu"));

    await refusal("moodle_enrolment_candidate_absent", (state) => { state.candidates = []; });
    await refusal("moodle_enrolment_candidate_absent", undefined, { query: "Katherine Johnson" });
    await refusal("moodle_enrolment_candidate_ambiguous", (state) => {
      state.candidates.push({ id: "22", name: "Mary Jackson", email: "other@example.edu" });
    });
    await refusal("moodle_enrolment_candidate_ambiguous", (state) => {
      state.candidates.push({ id: "21", name: "Mary Jackson", email: "duplicate@example.edu" });
    });
    await refusal("moodle_enrolment_candidate_excess", (state) => {
      state.candidates = Array.from({ length: 101 }, (_, index) => ({ id: String(1000 + index), name: `Candidate ${index}`, email: `c${index}@example.edu` }));
    });
    await refusal("moodle_enrolment_candidate_course_mismatch", (state) => { state.courseId = 9; });
    await refusal("moodle_enrolment_candidate_manual_method_unavailable", (state) => { state.methods = []; });
    await refusal("moodle_enrolment_candidate_manual_method_ambiguous", (state) => { state.methods = ["7", "8"]; });
    await refusal("moodle_enrolment_candidate_form_invalid", (state) => { state.includeSearch = false; });
    await refusal("moodle_enrolment_candidate_form_invalid", (state) => { state.echoQuery = false; });
    await refusal("moodle_enrolment_candidate_form_invalid", (state) => { state.includeCandidates = false; });
    await refusal("moodle_enrolment_candidate_form_invalid", (state) => { state.includeRole = false; });
    await refusal("moodle_enrolment_candidate_form_invalid", (state) => { state.includeAdd = false; });
    await refusal("moodle_enrolment_candidate_form_invalid", (state) => { state.candidateMultiple = false; });
    await refusal("moodle_enrolment_candidate_request_failed", (state) => { state.redirectManage = true; });
    await refusal("moodle_enrolment_candidate_response_invalid", (state) => { state.oversizedManage = true; });

    // Local input, operation, binding, and expiry refusals make no provider request.
    model = initialModel();
    before = requests.length;
    assert.equal((await run(" Mary Jackson")).error, "moodle_enrolment_candidate_arguments_invalid");
    assert.equal((await run(undefined, { arguments: { course_id: 9, query: "Mary Jackson" } })).error, "moodle_enrolment_candidate_arguments_invalid");
    assert.equal((await run(undefined, { arguments: { course_id: COURSE_ID, query: "Mary Jackson", user_id: 21 } })).error, "moodle_enrolment_candidate_arguments_invalid");
    assert.equal((await run(undefined, { operation: { ...OPERATION, morrowPrivate: false } })).error, "moodle_enrolment_candidate_operation_refused");
    assert.equal((await run(undefined, { binding: { ...binding, courseId: "9" } })).error, "moodle_binding_mismatch");
    assert.equal((await run(undefined, { expiresAt: Date.now() - 1 })).error, "moodle_execution_expired");
    assert.equal(requests.length, before);

    const worker = readFileSync(new URL("../../connector/extension/src/service-worker.js", import.meta.url), "utf8");
    assert.match(worker, /import \{ executeMoodleEnrolmentCandidateInPage, executeMoodleEnrolmentInPage \} from "\.\/moodle-enrolment-executor\.js";/);
    assert.match(worker, /PRIVATE_MOODLE_ENROLMENT_CANDIDATE_OPERATION_KEY = "moodle\.private\.enrolment_candidate\.find\.v1"/);
    assert.match(worker, /func: executeMoodleEnrolmentCandidateInPage/);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});
