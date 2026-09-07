import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { executeMoodleQbankInPage } from "../../connector/extension/src/moodle-qbank-executor.js";

const ANCHOR_SESSION = "moodle-qbank-session-a";
const FOREIGN_SESSION = "moodle-qbank-session-b";
const COURSE_ID = "2";
const SECTION_ID = "7";
const SECTION_NUMBER = "3";
const NEW_MODULE_ID = "21";
const CATEGORY_ID = "91";
const CONTEXT_ID = "305";
const BANK_NAME = "Reviewed isolation bank";

const operations = Object.freeze({
  creationForm: { key: "moodle.form.course.modedit.qbank.create.read.v1", toolName: "moodle_get_qbank_activity_creation_form", provider: "moodle", readOnly: true },
  create: { key: "moodle.form.course.modedit.qbank.create.write.v1", toolName: "moodle_create_qbank_activity", provider: "moodle", readOnly: false },
  activity: { key: "moodle.form.course.modedit.qbank.read.v1", toolName: "moodle_get_qbank_activity", provider: "moodle", readOnly: true },
  realize: { key: "moodle.form.question.bank.default_category.realize.write.v1", toolName: "moodle_realize_qbank_default_category", provider: "moodle", readOnly: false },
});

/** The executor's digest preimage rule, so a test can recompute a returned digest. */
function stableText(value) {
  if (Array.isArray(value)) return `[${value.map(stableText).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableText(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

function digestOf(value) {
  return createHash("sha256").update(stableText(value)).digest("hex");
}

function readBody(request) {
  return new Promise((resolve) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

test("the Moodle Qbank route is cataloged, wired, and leaves the Question bank hold in force", () => {
  const root = new URL("../..", import.meta.url);
  const catalog = JSON.parse(readFileSync(new URL("connector/extension/generated/moodle-browser-catalog.json", root), "utf8"));
  const entries = catalog.operations.filter((entry) => String(entry.key).includes(".qbank.") || String(entry.key).startsWith("moodle.form.question.bank.default_category."));
  assert.deepEqual(entries.map((entry) => entry.key).sort(), [
    "moodle.form.course.modedit.qbank.create.read.v1",
    "moodle.form.course.modedit.qbank.create.write.v1",
    "moodle.form.course.modedit.qbank.read.v1",
    "moodle.form.question.bank.default_category.realize.write.v1",
  ]);
  const byTool = new Map(entries.map((entry) => [entry.toolName, entry]));
  assert.equal(byTool.get("moodle_create_qbank_activity").reviewTool, "moodle_get_qbank_activity_creation_form");
  assert.equal(byTool.get("moodle_realize_qbank_default_category").reviewTool, "moodle_get_qbank_activity");
  assert.equal(byTool.get("moodle_get_qbank_activity_creation_form").readOnly, true);
  assert.equal(byTool.get("moodle_get_qbank_activity").readOnly, true);
  for (const entry of entries) {
    assert.equal(entry.provider, "moodle", entry.toolName);
    assert.equal(entry.destructive, undefined, entry.toolName);
    assert.match(entry.description, /Question bank updates stay held, and question creation stays held outside this dedicated hidden bank\./, entry.toolName);
  }
  assert.match(byTool.get("moodle_create_qbank_activity").description, /moodle\/course:manageactivities/);
  assert.match(byTool.get("moodle_create_qbank_activity").description, /the bank context and its categories are not established by this action/);
  assert.match(byTool.get("moodle_realize_qbank_default_category").description, /moodle\/question:add/);
  assert.match(byTool.get("moodle_realize_qbank_default_category").description, /created_or_existing/);
  assert.match(byTool.get("moodle_realize_qbank_default_category").description, /establishes no isolation on its own/);
  for (const toolName of ["moodle_create_qbank_activity", "moodle_realize_qbank_default_category"]) {
    assert.match(byTool.get(toolName).description, /Browser-fixture proof only; no signed-in Moodle site has run it\./, toolName);
    assert.deepEqual(byTool.get(toolName).inputSchema.required.includes("expected_digest"), true, toolName);
  }

  const worker = readFileSync(new URL("connector/extension/src/service-worker.js", root), "utf8");
  assert.match(worker, /import \{ executeMoodleQbankInPage \} from "\.\/moodle-qbank-executor\.js";/);
  assert.match(worker, /func: executeMoodleQbankInPage/);
  for (const entry of entries) assert.match(worker, new RegExp(`"${entry.key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`), entry.key);

  // Phase one adds no question and no Quiz slot, so the deterministic hold stays.
  const executor = readFileSync(new URL("connector/extension/src/moodle-executor.js", root), "utf8");
  assert.match(executor, /const runQuizQuestionCreation = async \(\) => error\("moodle_question_bank_impact_unresolved"\);/);
  assert.match(executor, /const runQuizQuestionUpdate = async \(\) => error\("moodle_question_bank_impact_unresolved"\);/);
  assert.equal(catalog.operations.some((entry) => /^moodle_(create|update)_quiz_.*_question$/.test(entry.toolName)), false);
  const qbank = readFileSync(new URL("connector/extension/src/moodle-qbank-executor.js", root), "utf8");
  assert.equal(/\/question\/bank\/editquestion\/question\.php/.test(qbank), false, "phase one must not reach the question controller");
  assert.equal(/mod\/quiz/.test(qbank), false, "phase one must not reach a Quiz route");
});

test("the Moodle Qbank route creates one hidden bank and realizes its category as two separate effects", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morrow-moodle-qbank-"));
  const key = join(directory, "key.pem");
  const certificate = join(directory, "certificate.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", certificate], { stdio: "ignore" });

  const state = {
    activities: [{ id: 5, module: "page", sectionid: Number(SECTION_ID), name: "Overview", visible: true }],
    sections: [{ id: Number(SECTION_ID), number: Number(SECTION_NUMBER), title: "Assessment" }],
    creationSessionQueue: [],
    creationView: "core",
    activityView: "core",
    postOutcome: "saved",
    bankRedirect: "category",
    bankPage: "complete",
    savedNameOverride: "",
  };
  const requests = [];
  const posts = [];
  let origin = "";
  let browser;
  let context;

  const control = (name, value, type = "hidden") => `<input type="${type}" name="${name}" value="${value}">`;
  const qbankForm = (view, sesskey, identity) => {
    const moduleName = view === "wrong-module" ? "page" : "qbank";
    const bankType = view === "wrong-type" ? "system" : "standard";
    const visible = view === "visible" ? "1" : "0";
    const action = view === "query-action" ? "/course/modedit.php?add=qbank&course=2" : view === "external-action" ? "https://outside.example/course/modedit.php" : "/course/modedit.php";
    const fileArea = view === "file-manager" ? '<div data-fieldtype="filemanager"><input type="hidden" name="attachments" value="99"></div>' : "";
    const extraDraft = view === "extra-draft" ? control("attachments[itemid]", "990011") : "";
    const introduction = view === "described" ? "Pre-filled description" : "";
    return `<!doctype html><html><body class="path-course course-2"><form method="post" action="${action}" id="mform1">
      ${Object.entries(identity).map(([name, value]) => control(name, value)).join("")}
      ${control("module", "41")}${control("modulename", moduleName)}${control("instance", identity.update && identity.update !== "0" ? "1" : "0")}
      ${control("sr", "0")}${control("beforemod", "0")}${control("sesskey", sesskey)}${control("_qf__mod_qbank_mod_form", "1")}
      ${control("visible", visible)}${control("type", bankType)}
      <input type="text" name="name" value="${identity.update && identity.update !== "0" ? (state.savedNameOverride || state.activities.find((entry) => String(entry.id) === identity.update)?.name || "") : ""}">
      <textarea name="introeditor[text]">${introduction}</textarea>${control("introeditor[format]", "1")}${control("introeditor[itemid]", "884401")}
      ${control("showdescription", "0")}<input type="checkbox" name="showdescription" value="1">
      <input type="text" name="cmidnumber" value="">
      ${fileArea}${extraDraft}
      <input type="submit" name="submitbutton2" value="Save and return to course">
      <input type="submit" name="submitbutton" value="Save and display">
      <input type="submit" name="cancel" value="Cancel">
    </form></body></html>`;
  };
  const creationForm = () => qbankForm(state.creationView, state.creationSessionQueue.shift() || ANCHOR_SESSION, {
    course: COURSE_ID, coursemodule: "0", section: SECTION_NUMBER, add: "qbank", update: "0", return: "0",
  });
  const activityForm = (moduleId) => qbankForm(state.activityView, ANCHOR_SESSION, {
    course: COURSE_ID, coursemodule: moduleId, section: SECTION_NUMBER, add: "", update: moduleId, return: "0",
  });
  const bankPage = (moduleId) => {
    const canAdd = state.bankPage !== "no-add";
    const addControl = canAdd
      ? `<div class="createnewquestion me-1"><form method="get" action="/question/bank/editquestion/addquestion.php">
          ${control("returnurl", "/question/edit.php")}${control("cmid", state.bankPage === "foreign-add" ? "999" : moduleId)}${control("category", CATEGORY_ID)}
          <button type="submit">Create a new question</button></form>
          <div id="qtypechoicecontainer"><div class="qtypes"></div></div></div>`
      : '<div class="createnewquestion me-1">You do not have permission to add questions.</div>';
    const secondContext = state.bankPage === "two-contexts"
      ? '<option value="" disabled class="suggestions-heading">Another bank</option><option value="140">Default for another bank</option>'
      : "";
    return `<!doctype html><html><body class="path-mod-qbank">${addControl}
      <div data-filterregion="filtertypedata" class="hidden">
        <select data-field-name="category" data-field-title="Category" data-allow-custom="0" data-required="true" data-join-list="1" class="hidden" data-filter-type-class="qbank_managecategories/datafilter/filtertypes/categories">
          <option value="" disabled class="suggestions-heading">${BANK_NAME}</option>
          <option value="90">Top</option>
          <option value="${CATEGORY_ID}">Default for ${BANK_NAME}</option>
          ${secondContext}
        </select>
        <select data-field-name="status" data-field-title="Status" data-allow-custom="0" data-required="false" data-join-list="1,2" class="hidden"><option value="ready">Ready</option></select>
      </div></body></html>`;
  };

  const server = createServer({ key: readFileSync(key), cert: readFileSync(certificate) }, async (request, response) => {
    const url = new URL(request.url || "/", origin || "https://127.0.0.1");
    requests.push({ method: request.method, pathname: url.pathname, search: url.search });
    if (url.pathname === "/course/view.php") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<!doctype html><body class="path-course course-1"><script>var M = {}; M.cfg = ${JSON.stringify({ wwwroot: origin, sesskey: ANCHOR_SESSION, userId: 3, courseId: 1 })};</script></body>`);
      return;
    }
    if (request.method === "POST" && url.pathname === "/lib/ajax/service.php") {
      const call = JSON.parse(await readBody(request))[0];
      assert.equal(url.search, `?sesskey=${ANCHOR_SESSION}&info=core_courseformat_get_state`);
      assert.equal(call.methodname, "core_courseformat_get_state");
      assert.deepEqual(call.args, { courseid: 2 });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify([{ index: 0, data: JSON.stringify({
        course: { id: 2, fullname: "Question bank isolation evidence" },
        section: state.sections,
        cm: state.activities,
      }) }]));
      return;
    }
    if (request.method === "GET" && url.pathname === "/course/modedit.php") {
      if (url.search === `?add=qbank&course=${COURSE_ID}&sectionid=${SECTION_ID}&return=0`) {
        response.writeHead(200, { "content-type": "text/html" });
        response.end(creationForm());
        return;
      }
      const update = url.searchParams.get("update") || "";
      if (url.search === `?update=${update}&return=0` && state.activities.some((entry) => String(entry.id) === update)) {
        response.writeHead(200, { "content-type": "text/html" });
        response.end(activityForm(update));
        return;
      }
      response.writeHead(404).end();
      return;
    }
    if (request.method === "POST" && url.pathname === "/course/modedit.php") {
      const values = new URLSearchParams(await readBody(request));
      posts.push({ pathname: url.pathname, search: url.search, values });
      if (state.postOutcome === "validation") {
        response.writeHead(200, { "content-type": "text/html" });
        response.end(creationForm());
        return;
      }
      state.activities = [...state.activities, {
        id: Number(NEW_MODULE_ID) + state.activities.length - 1,
        module: "qbank",
        sectionid: Number(SECTION_ID),
        name: values.get("name") || "",
        visible: values.get("visible") === "1",
      }];
      response.writeHead(303, { location: `/course/view.php?id=${COURSE_ID}#module-${state.activities[state.activities.length - 1].id}` });
      response.end();
      return;
    }
    if (request.method === "GET" && url.pathname === "/mod/qbank/view.php") {
      const moduleId = url.searchParams.get("id") || "";
      if (!state.activities.some((entry) => String(entry.id) === moduleId && entry.module === "qbank")) { response.writeHead(404).end(); return; }
      const target = state.bankRedirect === "no-cat"
        ? `/question/edit.php?cmid=${moduleId}`
        : state.bankRedirect === "foreign-module"
          ? `/question/edit.php?cat=${CATEGORY_ID},${CONTEXT_ID}&cmid=999`
          : `/question/edit.php?cat=${CATEGORY_ID},${CONTEXT_ID}&cmid=${moduleId}`;
      response.writeHead(303, { location: target });
      response.end();
      return;
    }
    if (request.method === "GET" && url.pathname === "/question/edit.php") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(bankPage(url.searchParams.get("cmid") || ""));
      return;
    }
    response.writeHead(404).end();
  });

  try {
    await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", (error) => error ? reject(error) : resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("qbank test server did not bind");
    origin = `https://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
    context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    await page.goto(`${origin}/course/view.php?id=1`);
    const binding = { origin, siteUrl: `${origin}/`, principalId: "3", courseId: COURSE_ID };
    const results = [];
    const execute = async (operation, argumentsValue, expiresAt = Date.now() + 60_000) => {
      const result = await page.evaluate(executeMoodleQbankInPage, JSON.stringify({ mode: "execute", operation, arguments: argumentsValue, binding, expiresAt }));
      results.push(result);
      return result;
    };
    const loseNextResponse = (pathname, method) => page.evaluate(([targetPath, targetMethod]) => {
      const nativeFetch = globalThis.fetch;
      globalThis.fetch = async (...parameters) => {
        const response = await nativeFetch(...parameters);
        const requested = new URL(parameters[0], globalThis.location.href);
        if (String(parameters[1]?.method || "GET").toUpperCase() === targetMethod && requested.pathname === targetPath) {
          globalThis.fetch = nativeFetch;
          throw new TypeError("response lost after dispatch");
        }
        return response;
      };
    }, [pathname, method]);
    const SOURCE_PATHS = ["/lib/ajax/service.php", "/course/modedit.php", "/mod/qbank/view.php", "/question/edit.php"];
    const sourceRequests = () => requests.filter((entry) => SOURCE_PATHS.includes(entry.pathname)).length;
    const bankRouteRequests = () => requests.filter((entry) => entry.pathname === "/mod/qbank/view.php").length;

    // 1. Arguments are refused before any native request.
    const beforeArguments = sourceRequests();
    assert.deepEqual(await execute(operations.creationForm, { course_id: 3, section_id: 7 }), { ok: false, sent: false, error: "moodle_qbank_arguments_invalid" });
    assert.deepEqual(await execute(operations.creationForm, { course_id: 2, section_id: 7, name: "x" }), { ok: false, sent: false, error: "moodle_qbank_arguments_invalid" });
    assert.deepEqual(await execute(operations.create, { course_id: 2, section_id: 7, name: BANK_NAME }), { ok: false, sent: false, error: "moodle_qbank_arguments_invalid" });
    assert.deepEqual(await execute(operations.create, { course_id: 2, section_id: 7, name: " padded ", expected_digest: "a".repeat(64) }), { ok: false, sent: false, error: "moodle_qbank_arguments_invalid" });
    assert.deepEqual(await execute({ ...operations.creationForm, readOnly: false }, { course_id: 2, section_id: 7 }), { ok: false, sent: false, error: "moodle_operation_refused" });
    assert.deepEqual(await execute(operations.creationForm, { course_id: 2, section_id: 7 }, Date.now() - 1), { ok: false, sent: false, error: "moodle_execution_expired" });
    assert.equal(sourceRequests(), beforeArguments);

    // 2. A section outside the approved course state is refused before the form read.
    assert.deepEqual(await execute(operations.creationForm, { course_id: 2, section_id: 999 }), { ok: false, sent: false, status: 200, error: "moodle_qbank_section_target_invalid" });
    assert.equal(posts.length, 0);

    // 3. Every non-core creation form is refused, and none of them sends a POST.
    state.creationSessionQueue.push(FOREIGN_SESSION);
    assert.deepEqual(await execute(operations.creationForm, { course_id: 2, section_id: 7 }), { ok: false, sent: false, status: 200, error: "moodle_form_session_mismatch" });
    for (const [view, error] of [
      ["wrong-module", "moodle_qbank_module_type_unexpected"],
      ["wrong-type", "moodle_qbank_module_type_unexpected"],
      ["visible", "moodle_qbank_form_invalid"],
      ["file-manager", "moodle_qbank_file_area_unexpected"],
      ["extra-draft", "moodle_qbank_file_area_unexpected"],
      ["described", "moodle_qbank_form_invalid"],
      ["query-action", "moodle_qbank_form_invalid"],
      ["external-action", "moodle_qbank_form_invalid"],
    ]) {
      state.creationView = view;
      assert.deepEqual(await execute(operations.creationForm, { course_id: 2, section_id: 7 }), { ok: false, sent: false, status: 200, error }, view);
    }
    state.creationView = "core";
    assert.equal(posts.length, 0);

    // 4. The reviewed creation form.
    const form = await execute(operations.creationForm, { course_id: 2, section_id: 7 });
    assert.equal(form.ok, true, JSON.stringify(form));
    assert.deepEqual(form.targets, [
      { field: "course_id", label: "Course", name: "Question bank isolation evidence" },
      { field: "section_id", label: "Section", name: "Assessment" },
    ]);
    assert.deepEqual(form.data, {
      schema: "morrow.moodle-qbank-activity.v1",
      provider: "moodle",
      course_id: 2,
      section_id: 7,
      section_number: 3,
      module: "qbank",
      bank_type: "standard",
      visible: false,
      introduction_empty: true,
      protected_setting_names: [
        "_qf__mod_qbank_mod_form", "add", "beforemod", "cmidnumber", "course", "coursemodule",
        "instance", "introeditor[format]", "introeditor[itemid]", "introeditor[text]", "module",
        "modulename", "return", "section", "showdescription", "sr", "type", "update", "visible",
      ],
      proof: {
        method: "native_form_read",
        route: "/course/modedit.php",
        required_capability: "moodle/course:manageactivities",
        scope: "one_hidden_question_bank_activity",
        module: "qbank",
        bank_type: "standard",
        question_bank_context: "not_established",
        question_bank_write_eligibility: "held",
      },
    });
    assert.equal(form.snapshot_digest, digestOf(form.data));
    assert.equal(Object.hasOwn(form.data, "name"), false, "a creation form has no current activity name");

    // 5. A stale digest never reaches a POST.
    assert.deepEqual(await execute(operations.create, { course_id: 2, section_id: 7, name: BANK_NAME, expected_digest: "b".repeat(64) }), { ok: false, sent: false, status: 200, error: "moodle_expected_digest_mismatch" });
    assert.equal(posts.length, 0);

    // 6. The native form answers a refused save with itself, which saved nothing.
    state.postOutcome = "validation";
    const refused = await execute(operations.create, { course_id: 2, section_id: 7, name: BANK_NAME, expected_digest: form.snapshot_digest });
    assert.deepEqual(refused, {
      ok: false, sent: true, status: 200, outcomeUnknown: false,
      verification: { schema: "morrow.browser-verification.v1", status: "mismatch", reason: "moodle_form_validation_failed" },
      error: "moodle_form_validation_failed",
    });
    assert.equal(posts.length, 1);
    assert.equal(state.activities.length, 1);
    state.postOutcome = "saved";

    // 7. One approved creation, one POST, and an exact saved readback.
    const created = await execute(operations.create, { course_id: 2, section_id: 7, name: BANK_NAME, expected_digest: form.snapshot_digest });
    assert.equal(created.ok, true, JSON.stringify(created));
    assert.deepEqual(created.verification, { schema: "morrow.browser-verification.v1", status: "verified" });
    assert.equal(posts.length, 2);
    const sent = posts[1].values;
    assert.equal(sent.get("name"), BANK_NAME);
    assert.equal(sent.get("visible"), "0");
    assert.equal(sent.get("type"), "standard");
    assert.equal(sent.get("modulename"), "qbank");
    assert.equal(sent.get("add"), "qbank");
    assert.equal(sent.get("course"), COURSE_ID);
    assert.equal(sent.get("section"), SECTION_NUMBER);
    assert.equal(sent.get("submitbutton2"), "Save and return to course");
    assert.equal(sent.get("submitbutton"), null, "only the reviewed submit control is sent");
    assert.equal(sent.get("introeditor[text]"), "");
    assert.equal(sent.get("showdescription"), "0");
    assert.equal(sent.get("cmidnumber"), "");
    assert.equal(sent.getAll("name").length, 1);
    assert.equal(created.data.module_id, Number(NEW_MODULE_ID));
    assert.deepEqual(created.data, {
      schema: "morrow.moodle-qbank-activity.v1",
      provider: "moodle",
      course_id: 2,
      module_id: 21,
      section_id: 7,
      name: BANK_NAME,
      module: "qbank",
      bank_type: "standard",
      visible: false,
      introduction_empty: true,
      protected_setting_names: form.data.protected_setting_names,
      proof: form.data.proof,
      created: true,
    });
    // The creation effect never opens the Question bank, so it establishes no context.
    assert.equal(bankRouteRequests(), 0);

    // 8. The saved activity read is the review read of the second effect.
    const activity = await execute(operations.activity, { course_id: 2, module_id: 21 });
    assert.equal(activity.ok, true, JSON.stringify(activity));
    assert.deepEqual(activity.targets, [
      { field: "course_id", label: "Course", name: "Question bank isolation evidence" },
      { field: "module_id", label: "Question bank", name: BANK_NAME },
    ]);
    const { created: createdFlag, ...savedActivity } = created.data;
    assert.equal(createdFlag, true);
    assert.deepEqual(activity.data, savedActivity);
    assert.equal(activity.snapshot_digest, digestOf(activity.data));
    assert.equal(bankRouteRequests(), 0);
    assert.deepEqual(await execute(operations.activity, { course_id: 2, module_id: 5 }), { ok: false, sent: false, status: 200, error: "moodle_qbank_module_target_invalid" });

    // 9. A stale digest never reaches the Question bank route.
    assert.deepEqual(await execute(operations.realize, { course_id: 2, module_id: 21, expected_digest: "c".repeat(64) }), { ok: false, sent: false, status: 200, error: "moodle_expected_digest_mismatch" });
    assert.equal(bankRouteRequests(), 0);

    // 10. Missing moodle/question:add refuses the bind, and says the effect happened.
    state.bankPage = "no-add";
    const withoutAdd = await execute(operations.realize, { course_id: 2, module_id: 21, expected_digest: activity.snapshot_digest });
    assert.deepEqual(withoutAdd, {
      ok: false, sent: true, status: 200, outcomeUnknown: false,
      verification: { schema: "morrow.browser-verification.v1", status: "mismatch", reason: "moodle_qbank_question_add_absent" },
      error: "moodle_qbank_question_add_absent",
    });
    assert.equal(bankRouteRequests(), 1);
    state.bankPage = "foreign-add";
    assert.equal((await execute(operations.realize, { course_id: 2, module_id: 21, expected_digest: activity.snapshot_digest })).error, "moodle_qbank_question_add_absent");

    // 11. A category list with more than one context group is not isolated.
    state.bankPage = "two-contexts";
    const notIsolated = await execute(operations.realize, { course_id: 2, module_id: 21, expected_digest: activity.snapshot_digest });
    assert.deepEqual(notIsolated, {
      ok: false, sent: true, status: 200, outcomeUnknown: false,
      verification: { schema: "morrow.browser-verification.v1", status: "mismatch", reason: "moodle_qbank_category_not_isolated" },
      error: "moodle_qbank_category_not_isolated",
    });
    state.bankPage = "complete";

    // 12. A route that does not land on the approved module's bank page is unknown.
    for (const redirect of ["no-cat", "foreign-module"]) {
      state.bankRedirect = redirect;
      assert.deepEqual(await execute(operations.realize, { course_id: 2, module_id: 21, expected_digest: activity.snapshot_digest }), {
        ok: false, sent: true, status: 200, outcomeUnknown: true,
        verification: { schema: "morrow.browser-verification.v1", status: "unconfirmed", reason: "moodle_qbank_category_route_unexpected" },
        error: "moodle_qbank_category_route_unexpected",
      }, redirect);
    }
    state.bankRedirect = "category";

    // 13. The approved second effect: one dispatch, exact category and context readback.
    const bankRouteBefore = bankRouteRequests();
    const postsBefore = posts.length;
    const realized = await execute(operations.realize, { course_id: 2, module_id: 21, expected_digest: activity.snapshot_digest });
    assert.equal(realized.ok, true, JSON.stringify(realized));
    assert.equal(bankRouteRequests(), bankRouteBefore + 1);
    assert.equal(posts.length, postsBefore, "realizing the category sends no form post");
    assert.deepEqual(realized.verification, { schema: "morrow.browser-verification.v1", status: "verified" });
    assert.deepEqual(realized.data, {
      schema: "morrow.moodle-qbank-default-category.v1",
      provider: "moodle",
      course_id: 2,
      module_id: 21,
      category_id: 91,
      question_bank_context_id: 305,
      category_origin: "created_or_existing",
      category_contexts_listed: 1,
      category_option_count: 2,
      question_add_capability: "present",
      proof: {
        method: "native_question_bank_route",
        route: "/mod/qbank/view.php",
        landed_route: "/question/edit.php",
        required_capability: "moodle/question:add",
        capability_source: "bank_page_add_question_control",
        context_source: "question_edit_url_for_approved_module",
        scope: "one_question_bank_module_context",
        isolation_established: false,
        question_bank_write_eligibility: "held",
      },
    });
    assert.equal(realized.snapshot_digest, digestOf(realized.data));
    assert.deepEqual(realized.targets, activity.targets);

    // 14. A lost response after either dispatch is applied-or-unknown, never retried.
    const lostRealizeBefore = bankRouteRequests();
    await loseNextResponse("/mod/qbank/view.php", "GET");
    assert.deepEqual(await execute(operations.realize, { course_id: 2, module_id: 21, expected_digest: activity.snapshot_digest }), {
      ok: false, sent: true, outcomeUnknown: true,
      verification: { schema: "morrow.browser-verification.v1", status: "unconfirmed", reason: "moodle_qbank_realize_unconfirmed" },
      error: "moodle_qbank_realize_unconfirmed",
    });
    assert.equal(bankRouteRequests(), lostRealizeBefore + 1);

    const secondForm = await execute(operations.creationForm, { course_id: 2, section_id: 7 });
    assert.equal(secondForm.ok, true, JSON.stringify(secondForm));
    const lostCreateBefore = posts.length;
    await loseNextResponse("/course/modedit.php", "POST");
    assert.deepEqual(await execute(operations.create, { course_id: 2, section_id: 7, name: "Lost response bank", expected_digest: secondForm.snapshot_digest }), {
      ok: false, sent: true, outcomeUnknown: true,
      verification: { schema: "morrow.browser-verification.v1", status: "unconfirmed", reason: "moodle_qbank_create_unconfirmed" },
      error: "moodle_qbank_create_unconfirmed",
    });
    assert.equal(posts.length, lostCreateBefore + 1);
    assert.equal(state.activities.filter((entry) => entry.name === "Lost response bank").length, 1, "the site kept the change the browser could not confirm");

    // 15. A saved name that is not the approved name is applied-or-unknown.
    const driftForm = await execute(operations.creationForm, { course_id: 2, section_id: 7 });
    const driftBefore = posts.length;
    state.savedNameOverride = "Name the site kept";
    assert.deepEqual(await execute(operations.create, { course_id: 2, section_id: 7, name: "Requested bank name", expected_digest: driftForm.snapshot_digest }), {
      // The POST follows Moodle's own redirect, so the status is the course page's.
      ok: false, sent: true, status: 200, outcomeUnknown: true,
      verification: { schema: "morrow.browser-verification.v1", status: "unconfirmed", reason: "moodle_qbank_create_not_verified" },
      error: "moodle_qbank_create_not_verified",
    });
    assert.equal(posts.length, driftBefore + 1);
    state.savedNameOverride = "";

    // 16. Route and secret boundaries across the whole run.
    assert.equal(requests.some((entry) => /^\/mod\/quiz\//.test(entry.pathname)), false, "no Quiz route was opened");
    assert.equal(requests.some((entry) => entry.pathname.startsWith("/question/bank/")), false, "no question controller was opened");
    assert.equal(requests.some((entry) => entry.method !== "GET" && !["/course/modedit.php", "/lib/ajax/service.php"].includes(entry.pathname)), false);
    assert.equal(requests.some((entry) => entry.method === "POST" && entry.pathname === "/mod/qbank/view.php"), false);
    assert.equal(JSON.stringify(results).includes(ANCHOR_SESSION), false, "a result leaked the session key");
    assert.equal(JSON.stringify(results).includes(FOREIGN_SESSION), false, "a result leaked a session key");
    assert.equal(JSON.stringify(results).includes("884401"), false, "a result leaked a draft item ID");
  } finally {
    await context?.close();
    await browser?.close();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});
