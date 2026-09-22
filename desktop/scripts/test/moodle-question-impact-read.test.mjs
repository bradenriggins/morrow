import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { executeMoodleQuestionBankImpactScopeInPage } from "../../connector/extension/src/moodle-question-impact-read.js";

const OPERATION = Object.freeze({
  key: "moodle.form.question.bank.impact_scope.read.v1",
  toolName: "moodle_get_question_bank_impact_scope",
  provider: "moodle",
  readOnly: true,
});

test("Moodle Question Bank impact scope is cataloged, routed, and adds no write", () => {
  const root = new URL("../..", import.meta.url);
  const catalog = JSON.parse(readFileSync(new URL("connector/extension/generated/moodle-browser-catalog.json", root), "utf8"));
  const entries = catalog.operations.filter((entry) => entry.key === "moodle.form.question.bank.impact_scope.read.v1");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].toolName, "moodle_get_question_bank_impact_scope");
  assert.equal(entries[0].provider, "moodle");
  assert.equal(entries[0].readOnly, true);
  assert.equal(entries[0].dataClass, "course");
  assert.equal(entries[0].reviewTool, undefined);
  assert.match(entries[0].description, /mod\/quiz:manage/);
  assert.match(entries[0].description, /never authorizes a Question Bank write/);
  assert.match(entries[0].description, /does not expose a filter key's server-side PHP condition class or plugin component/);

  const worker = readFileSync(new URL("connector/extension/src/service-worker.js", root), "utf8");
  assert.match(worker, /import \{ executeMoodleQuestionBankImpactScopeInPage \} from "\.\/moodle-question-impact-read\.js";/);
  assert.match(worker, /MOODLE_QUESTION_BANK_IMPACT_SCOPE_OPERATION_KEY = "moodle\.form\.question\.bank\.impact_scope\.read\.v1"/);
  assert.match(worker, /func: executeMoodleQuestionBankImpactScopeInPage/);

  // The deterministic Question Bank hold this reader must never relax.
  const executor = readFileSync(new URL("connector/extension/src/moodle-executor.js", root), "utf8");
  assert.match(executor, /const runQuizQuestionCreation = async \(\) => error\("moodle_question_bank_impact_unresolved"\);/);
  assert.match(executor, /const runQuizQuestionUpdate = async \(\) => error\("moodle_question_bank_impact_unresolved"\);/);
  assert.equal(catalog.operations.some((entry) => /^moodle_(create|update)_quiz_.*_question$/.test(entry.toolName)), false);
});

test("Moodle Question Bank impact scope enumerates stored references and fails closed", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morrow-moodle-question-impact-"));
  const key = join(directory, "key.pem");
  const certificate = join(directory, "certificate.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", certificate], { stdio: "ignore" });
  const PRIVATE_SESSION = "moodle-private-session";
  const requests = [];
  let origin = "";
  let mode = "complete";
  let browser;

  const escape = (value) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  const CATEGORY_FILTER = { jointype: 1, values: ["17"], filteroptions: { includesubcategories: true } };
  const filterCondition = () => {
    if (mode === "malformed-filter") return "{not json";
    if (mode === "foreign-field") return JSON.stringify({ filter: { category: CATEGORY_FILTER }, jointype: 2, courseid: 2 });
    if (mode === "unknown-filter") return JSON.stringify({ filter: { qbank_customfilter: { jointype: 1, values: ["7"] } }, jointype: 2 });
    if (mode === "jointype-none") return JSON.stringify({ filter: { category: { ...CATEGORY_FILTER, jointype: 0 } }, jointype: 2 });
    return JSON.stringify({ filter: { category: CATEGORY_FILTER }, jointype: 2, qpage: 0 });
  };
  const randomSlot = () => {
    const attributes = mode === "not-exposed"
      ? ""
      : ` data-filtercondition="${escape(filterCondition())}"${mode === "no-context" ? "" : ' data-questionscontextid="42"'}`;
    return `<li class="activity random qtype_random slot" id="slot-18"${attributes}>
      <div class="activityinstance"><span class="instancename">Random question based on Unit 1</span></div><span class="instancemaxmark"></span></li>`;
  };
  const directSlot = (slotId, questionId) => `<li class="activity multichoice qtype_multichoice slot" id="slot-${slotId}">
      <div class="activityinstance"><a href="/question/bank/editquestion/question.php?id=${questionId}&amp;cmid=9"><span class="instancename">Evidence check</span></a></div>
      <span class="instancemaxmark">1.00</span>
      <div class="actions"><select class="form-select version-selection" data-slot-id="${slotId}"><option value="0" selected="selected">Always latest</option><option value="1">v1</option></select></div></li>`;
  const quizEditPage = (moduleId) => {
    const slots = moduleId !== "9"
      ? ""
      : mode === "truncated-slots"
        ? Array.from({ length: 101 }, (_, index) => directSlot(100 + index, 500 + index)).join("")
        : `${directSlot(17, 401)}${randomSlot()}`;
    return `<!doctype html><html><body><ul class="slots" role="presentation">
      <li class="section main clearfix" id="section-1" role="presentation"><div class="content">
      <ul class="section img-text">${slots}</ul></div></li></ul></body></html>`;
  };
  const courseState = () => JSON.stringify({
    course: { id: 2, fullname: "Question impact evidence" },
    section: [{ id: 7, number: 1, title: "Assessment" }],
    cm: [
      { id: 5, module: "page", sectionid: 7, name: "Overview" },
      { id: 9, module: "quiz", sectionid: 7, name: "Unit 1 Quiz" },
      { id: 12, module: "quiz", sectionid: 7, name: "Unit 2 Quiz" },
    ],
  });

  const server = createServer({ key: readFileSync(key), cert: readFileSync(certificate) }, async (request, response) => {
    const target = new URL(request.url || "/", origin);
    requests.push({ method: request.method, pathname: target.pathname, search: target.search });
    if (target.pathname === "/course/view.php") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<!doctype html><body class="path-course course-2"><script>var M = { cfg: ${JSON.stringify({ wwwroot: origin, sesskey: PRIVATE_SESSION, userId: 3, courseId: 2 })} };</script></body>`);
      return;
    }
    if (request.method === "GET" && target.pathname === "/mod/quiz/edit.php") {
      const moduleId = target.searchParams.get("cmid") || "";
      if (!["9", "12"].includes(moduleId)) { response.writeHead(404).end(); return; }
      response.writeHead(200, { "content-type": "text/html" });
      response.end(quizEditPage(moduleId));
      return;
    }
    if (request.method === "POST" && target.pathname === "/lib/ajax/service.php") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const call = JSON.parse(Buffer.concat(chunks).toString("utf8"))[0];
      assert.equal(target.search, `?sesskey=${PRIVATE_SESSION}&info=core_courseformat_get_state`);
      assert.equal(call.methodname, "core_courseformat_get_state");
      assert.deepEqual(call.args, { courseid: 2 });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify([{ index: 0, data: courseState() }]));
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
    const invoke = (args = { course_id: 2 }) => page.evaluate(
      executeMoodleQuestionBankImpactScopeInPage,
      JSON.stringify({ operation: OPERATION, arguments: args, binding: { origin, siteUrl: `${origin}/`, principalId: "3", courseId: "2" }, expiresAt: Date.now() + 60_000 }),
    );
    const sourceRequests = () => requests.filter((entry) => entry.pathname === "/lib/ajax/service.php" || entry.pathname === "/mod/quiz/edit.php").length;

    const beforeInvalid = sourceRequests();
    assert.deepEqual(await invoke({ course_id: 2, module_id: 9 }), { ok: false, sent: false, error: "moodle_question_bank_impact_scope_arguments_invalid" });
    assert.deepEqual(await invoke({ course_id: 3 }), { ok: false, sent: false, error: "moodle_question_bank_impact_scope_arguments_invalid" });
    assert.equal(sourceRequests(), beforeInvalid);

    const scope = await invoke();
    assert.equal(scope.ok, true, JSON.stringify(scope));
    assert.equal(scope.sent, false);
    assert.equal(scope.complete, true);
    assert.match(scope.snapshot_digest, /^[0-9a-f]{64}$/);
    // packages/mcp-server/test/moodle-question-impact.test.ts re-validates this
    // exact shape at the MCP boundary. Keep the two in step.
    assert.deepEqual(scope.data, {
      schema: "morrow.moodle-question-bank-impact-scope.v1",
      provider: "moodle",
      course_id: 2,
      status: "complete",
      quiz_count: 2,
      slot_count: 2,
      direct_reference_count: 1,
      random_reference_count: 1,
      quizzes: [
        {
          module_id: 9,
          name: "Unit 1 Quiz",
          slot_count: 2,
          slots_readable: true,
          slots: [
            { slot_id: 17, position: 1, reference: "direct", resolved: true, question_id: 401, version: { mode: "latest" } },
            {
              slot_id: 18, position: 2, reference: "random", resolved: true, questions_context_id: 42,
              filter_source: "quiz_edit_slot_data", filter_jointype: 2, filter_jointype_name: "all",
              filters: [{ key: "category", jointype: 1, jointype_name: "any", values: ["17"], recognised: true, include_subcategories: true }],
            },
          ],
        },
        { module_id: 12, name: "Unit 2 Quiz", slot_count: 0, slots_readable: true, slots: [] },
      ],
      incomplete_reasons: [],
      incomplete_reasons_truncated: false,
      proof: {
        method: "core_courseformat_get_state",
        slot_source: "mod_quiz_edit_page",
        required_capability: "mod/quiz:manage",
        scope: "approved_course_only",
        cross_course_references: "not_enumerated",
        condition_class_resolution: "not_exposed",
        plugin_components: "not_exposed",
        recognised_filter_keys: ["category"],
        quiz_limit: 50,
        slot_limit_per_quiz: 100,
        reason_limit: 200,
        question_bank_write_eligibility: "held",
      },
    });
    assert.equal(JSON.stringify(scope).includes(PRIVATE_SESSION), false, "result leaked the session key");
    assert.equal(requests.some((entry) => /^\/mod\/quiz\/(?:view|attempt|review|report|startattempt|summary)\.php$/.test(entry.pathname)), false);
    assert.equal(requests.some((entry) => entry.method !== "GET" && entry.pathname !== "/lib/ajax/service.php"), false);

    const incomplete = async (nextMode) => {
      mode = nextMode;
      const result = await invoke();
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.data.status, "impact_scope_incomplete", nextMode);
      assert.equal(result.data.proof.question_bank_write_eligibility, "held");
      return result.data;
    };

    const unknownFilter = await incomplete("unknown-filter");
    assert.deepEqual(unknownFilter.incomplete_reasons, [{ reason: "filter_class_unrecognised", module_id: 9, slot_id: 18, filter_key: "qbank_customfilter" }]);
    assert.equal(unknownFilter.quizzes[0].slots[1].filters[0].recognised, false);

    for (const malformed of ["malformed-filter", "foreign-field"]) {
      const data = await incomplete(malformed);
      assert.deepEqual(data.incomplete_reasons, [{ reason: "random_filter_condition_malformed", module_id: 9, slot_id: 18 }]);
      assert.deepEqual(data.quizzes[0].slots[1], { slot_id: 18, position: 2, reference: "random", resolved: false });
    }

    const noneJoin = await incomplete("jointype-none");
    assert.deepEqual(noneJoin.incomplete_reasons, [{ reason: "filter_jointype_none", module_id: 9, slot_id: 18, filter_key: "category" }]);

    const notExposed = await incomplete("not-exposed");
    assert.deepEqual(notExposed.incomplete_reasons, [{ reason: "random_filter_condition_not_exposed", module_id: 9, slot_id: 18 }]);

    const noContext = await incomplete("no-context");
    assert.deepEqual(noContext.incomplete_reasons, [{ reason: "random_context_not_exposed", module_id: 9, slot_id: 18 }]);
    assert.equal(noContext.quizzes[0].slots[1].questions_context_id, null);
    assert.equal(noContext.quizzes[0].slots[1].filters.length, 1);

    const truncated = await incomplete("truncated-slots");
    assert.deepEqual(truncated.incomplete_reasons, [{ reason: "slot_list_truncated", module_id: 9 }]);
    assert.equal(truncated.quizzes[0].slot_count, 100);
    assert.equal(truncated.slot_count, 100);
    assert.equal(truncated.direct_reference_count, 100);
  } finally {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
});
