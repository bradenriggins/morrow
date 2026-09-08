import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { categoriesForBinding } from "../../connector/extension/src/edit-policy.js";
import { executeMoodleQbankQuestionInPage } from "../../connector/extension/src/moodle-qbank-question-executor.js";

const ANCHOR_SESSION = "moodle-qbank-question-session-a";
const FOREIGN_SESSION = "moodle-qbank-question-session-b";
const COURSE_ID = "2";
const BANK_MODULE_ID = "21";
const QUIZ_MODULE_ID = "9";
const PAGE_MODULE_ID = "5";
const CATEGORY_ID = "91";
const CONTEXT_ID = "305";
const BANK_NAME = "Reviewed isolation bank";
const QUIZ_NAME = "Unit 3 quiz";
const EXISTING_ENTRY_ID = "400";
const FOREIGN_ENTRY_ID = "401";
const DRAFT_ITEM = "884401";
const HELD_SENTENCE = "Question bank updates stay held, and question creation stays held outside this dedicated hidden bank.";

const operations = Object.freeze({
  creationForm: { key: "moodle.form.question.bank.editquestion.create.read.v1", toolName: "moodle_get_qbank_question_creation_form", provider: "moodle", readOnly: true },
  create: { key: "moodle.form.question.bank.editquestion.create.write.v1", toolName: "moodle_create_qbank_question", provider: "moodle", readOnly: false },
  slotPlan: { key: "moodle.form.mod.quiz.qbank_question.add.read.v1", toolName: "moodle_get_qbank_quiz_slot_plan", provider: "moodle", readOnly: true },
  addSlot: { key: "moodle.form.mod.quiz.qbank_question.add.write.v1", toolName: "moodle_add_qbank_question_to_quiz", provider: "moodle", readOnly: false },
});

const TRUE_FALSE = Object.freeze({
  course_id: 2,
  module_id: 21,
  category_id: 91,
  question_bank_context_id: 305,
  qtype: "truefalse",
  name: "Isolation check",
  question_text: "The dedicated bank holds this question.",
  correct_answer: true,
  true_feedback: "Correct.",
  false_feedback: "Not correct.",
});

const SHORT_ANSWER = Object.freeze({
  course_id: 2,
  module_id: 21,
  category_id: 91,
  question_bank_context_id: 305,
  qtype: "shortanswer",
  name: "Bank name check",
  question_text: "Name the bank this question lives in.",
  case_sensitive: false,
  answers: [
    { text: "Reviewed isolation bank", fraction: "1.0", feedback: "Correct." },
    { text: "Isolation bank", fraction: "0.5", feedback: "Close." },
  ],
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

test("phase two of the Moodle Qbank route is cataloged, wired, and leaves every question update held", () => {
  const root = new URL("../..", import.meta.url);
  const catalog = JSON.parse(readFileSync(new URL("connector/extension/generated/moodle-browser-catalog.json", root), "utf8"));
  const byTool = new Map(catalog.operations.map((entry) => [entry.toolName, entry]));
  const entries = Object.values(operations).map((operation) => {
    const entry = byTool.get(operation.toolName);
    assert.ok(entry, `the catalog is missing ${operation.toolName}`);
    assert.equal(entry.key, operation.key, operation.toolName);
    assert.equal(entry.provider, "moodle", operation.toolName);
    assert.equal(entry.readOnly, operation.readOnly, operation.toolName);
    assert.equal(entry.destructive, undefined, operation.toolName);
    assert.ok(entry.description.includes(HELD_SENTENCE), `${operation.toolName} must state what stays held`);
    return entry;
  });
  assert.equal(byTool.get("moodle_create_qbank_question").reviewTool, "moodle_get_qbank_question_creation_form");
  assert.equal(byTool.get("moodle_add_qbank_question_to_quiz").reviewTool, "moodle_get_qbank_quiz_slot_plan");
  for (const toolName of ["moodle_create_qbank_question", "moodle_add_qbank_question_to_quiz"]) {
    assert.ok(byTool.get(toolName).inputSchema.required.includes("expected_digest"), toolName);
    assert.match(byTool.get(toolName).description, /Browser-fixture proof only; no signed-in Moodle site has run it\./, toolName);
  }
  assert.match(byTool.get("moodle_create_qbank_question").description, /moodle\/question:add/);
  assert.match(byTool.get("moodle_create_qbank_question").description, /It never updates, clones or moves a saved entry/);
  assert.match(byTool.get("moodle_create_qbank_question").description, /it adds no Quiz slot/);
  assert.match(byTool.get("moodle_add_qbank_question_to_quiz").description, /mod\/quiz:manage/);
  assert.match(byTool.get("moodle_add_qbank_question_to_quiz").description, /moodle\/question:use/);
  assert.match(byTool.get("moodle_add_qbank_question_to_quiz").description, /version NULL/);
  assert.deepEqual(byTool.get("moodle_create_qbank_question").inputSchema.properties.qtype.enum, ["multichoice", "shortanswer", "truefalse"]);
  assert.deepEqual(byTool.get("moodle_get_qbank_question_creation_form").inputSchema.properties.qtype.enum, ["multichoice", "shortanswer", "truefalse"]);
  assert.equal(byTool.get("moodle_create_qbank_question").inputSchema.properties.single.type, "boolean");
  assert.equal(byTool.get("moodle_create_qbank_question").inputSchema.properties.answers.items.properties.text.maxLength, 8192);

  const worker = readFileSync(new URL("connector/extension/src/service-worker.js", root), "utf8");
  assert.match(worker, /import \{ executeMoodleQbankQuestionInPage \} from "\.\/moodle-qbank-question-executor\.js";/);
  assert.match(worker, /func: executeMoodleQbankQuestionInPage/);
  for (const entry of entries) assert.match(worker, new RegExp(`"${entry.key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`), entry.key);

  // Both writes stay outside every standing Edit grant: each one is approved on its own.
  const categories = categoriesForBinding({ provider: "moodle" }, catalog.operations);
  const byId = new Map(categories.map((entry) => [entry.id, entry]));
  for (const toolName of ["moodle_create_qbank_question", "moodle_add_qbank_question_to_quiz"]) {
    const category = byId.get(`action:moodle:${toolName}`);
    assert.ok(category, `${toolName} is missing from the Moodle Edit policy`);
    assert.equal(category.availability, "review", toolName);
    assert.match(category.reviewReason, /you approve them one at a time/, toolName);
  }
  assert.equal(byId.get("action:moodle:moodle_create_qbank_activity").availability, "edit", "phase one stays Edit-available");

  // The general Question bank hold is untouched: no create or update route for a Quiz question.
  const executor = readFileSync(new URL("connector/extension/src/moodle-executor.js", root), "utf8");
  assert.match(executor, /const runQuizQuestionCreation = async \(\) => error\("moodle_question_bank_impact_unresolved"\);/);
  assert.match(executor, /const runQuizQuestionUpdate = async \(\) => error\("moodle_question_bank_impact_unresolved"\);/);
  assert.equal(catalog.operations.some((entry) => /^moodle_(create|update)_quiz_.*_question$/.test(entry.toolName)), false);
  const phaseTwo = readFileSync(new URL("connector/extension/src/moodle-qbank-question-executor.js", root), "utf8");
  assert.equal(/\/mod\/quiz\/(?:view|attempt|review|report)\.php/.test(phaseTwo), false, "phase two must not open a Quiz attempt or report route");
});

test("the Moodle Qbank route creates one new entry and one Quiz slot as two separate effects", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morrow-moodle-qbank-question-"));
  const key = join(directory, "key.pem");
  const certificate = join(directory, "certificate.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", certificate], { stdio: "ignore" });

  const state = {
    activities: [
      { id: Number(PAGE_MODULE_ID), module: "page", sectionid: 7, name: "Overview", visible: true },
      { id: Number(QUIZ_MODULE_ID), module: "quiz", sectionid: 7, name: QUIZ_NAME, visible: true },
      { id: Number(BANK_MODULE_ID), module: "qbank", sectionid: 7, name: BANK_NAME, visible: false },
    ],
    entries: [{ id: EXISTING_ENTRY_ID, qtype: "truefalse", name: "Existing bank entry", questionText: "Already saved.", status: "ready", category: `${CATEGORY_ID},${CONTEXT_ID}`, correctanswer: "1", feedbacktrue: "", feedbackfalse: "" }],
    slots: [
      { slotId: 17, questionId: FOREIGN_ENTRY_ID, name: "Existing quiz question", version: "0" },
      { slotId: 18, random: true },
    ],
    nextEntryId: 402,
    quizView: "core",
    bankView: "core",
    chooserView: "core",
    formView: "core",
    formSessionQueue: [],
    postOutcome: "saved",
    savedNameOverride: "",
    numbering: "abc",
    savedNumberingOverride: "",
    normalizeSavedFractions: false,
    gradeOptions: ["1.0", "0.5", "0.0", "-1.0"],
  };
  const requests = [];
  const posts = [];
  let origin = "";
  let browser;
  let context;

  const control = (name, value, type = "hidden") => `<input type="${type}" name="${name}" value="${value}">`;
  const escaped = (value) => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  const bankReturnUrl = `/question/edit.php?cat=${CATEGORY_ID},${CONTEXT_ID}&cmid=${BANK_MODULE_ID}`;

  const quizSlotMarkup = (slot) => {
    if (slot.random) {
      const jointype = state.quizView === "none-filter" ? 0 : 2;
      const condition = escaped(JSON.stringify({
        filter: { category: { jointype, values: [42], filteroptions: { includesubcategories: true } } },
        jointype: 2,
        questionscontextid: Number(CONTEXT_ID),
      }));
      return `<li class="activity random qtype_random slot" id="slot-${slot.slotId}" data-filtercondition="${condition}" data-questionscontextid="${CONTEXT_ID}"><div class="activityinstance"><span class="instancename">Random question</span></div></li>`;
    }
    const link = state.quizView === "unresolved"
      ? `<span class="instancename">${slot.name}</span>`
      : `<a href="/question/bank/editquestion/question.php?id=${slot.questionId}&amp;cmid=${QUIZ_MODULE_ID}"><span class="instancename">${slot.name}</span></a>`;
    return `<li class="activity truefalse qtype_truefalse slot" id="slot-${slot.slotId}"><div class="activityinstance">${link}</div>
      <div class="actions"><select class="form-select version-selection" data-slot-id="${slot.slotId}">
        <option value="0"${slot.version === "0" ? " selected=\"selected\"" : ""}>Always latest</option>
        <option value="1"${slot.version === "1" ? " selected=\"selected\"" : ""}>Version 1</option>
      </select></div></li>`;
  };
  const quizPage = () => `<!doctype html><html><body class="path-mod-quiz course-2">
    <ul class="slots"><li class="section main" id="section-1"><ul class="section img-text">
      ${state.slots.map(quizSlotMarkup).join("")}
    </ul></li></ul></body></html>`;

  const bankPage = () => {
    const addControl = state.bankView === "no-add"
      ? '<div class="createnewquestion me-1">You do not have permission to add questions.</div>'
      : `<div class="createnewquestion me-1"><form method="get" action="/question/bank/editquestion/addquestion.php">
          ${control("returnurl", escaped(state.bankView === "quiz-return" ? `/mod/quiz/edit.php?cmid=${QUIZ_MODULE_ID}` : bankReturnUrl))}
          ${control("cmid", BANK_MODULE_ID)}${control("category", CATEGORY_ID)}
          ${state.bankView === "append-quiz" ? control("appendqnumstring", "addquestion") : ""}
          <div id="qtypechoicecontainer"><div class="qtypes">
            <input type="radio" name="qtype" value="truefalse"><input type="radio" name="qtype" value="shortanswer"><input type="radio" name="qtype" value="multichoice">
          </div></div>
          <button type="submit">Create a new question</button></form></div>`;
    const secondContext = state.bankView === "two-contexts"
      ? '<option value="" disabled class="suggestions-heading">Another bank</option><option value="140">Default for another bank</option>'
      : "";
    return `<!doctype html><html><body class="path-mod-qbank course-2">${addControl}
      <div class="questionbank">${state.entries.map((entry) => `<a href="/question/bank/editquestion/question.php?id=${entry.id}&amp;cmid=${BANK_MODULE_ID}">${entry.name}</a>`).join("")}</div>
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

  const editor = (field, text, itemid) => `<textarea name="${field}[text]">${escaped(text)}</textarea>${control(`${field}[format]`, "1")}${control(`${field}[itemid]`, itemid)}`;
  // Core Short answer uses a plain answer input. Multichoice uses an editor.
  const answerRow = (index, answer, qtype, saved = false) => `${qtype === "multichoice"
    ? editor(`answer[${index}]`, answer?.text || "", `88460${index}`)
    : `<input type="text" name="answer[${index}]" value="${escaped(answer?.text || "")}">`}
    <select name="fraction[${index}]">${(qtype === "multichoice" ? state.gradeOptions : ["1.0", "0.5", "0.0"]).map((value) => saved && state.normalizeSavedFractions ? String(Number(value)) : value).map((value) => `<option value="${value}"${Number(answer?.fraction || "0.0") === Number(value) ? " selected" : ""}>${value}</option>`).join("")}</select>
    ${editor(`feedback[${index}]`, answer?.feedback || "", `88450${index}`)}`;
  const questionForm = (qtype, saved) => {
    const view = saved ? "core" : state.formView;
    const sesskey = state.formSessionQueue.shift() || ANCHOR_SESSION;
    const status = view === "draft-status" ? "draft" : (saved?.status || "ready");
    const category = view === "wrong-category" ? "42,420" : (saved?.category || `${CATEGORY_ID},${CONTEXT_ID}`);
    const name = saved ? (state.savedNameOverride || saved.name) : "";
    const questionText = view === "dirty-editor" ? "Left-over text" : (saved?.questionText || "");
    const typed = qtype === "truefalse"
      ? `<select name="correctanswer"><option value="0"${saved?.correctanswer === "0" ? " selected=\"selected\"" : ""}>False</option><option value="1"${(saved?.correctanswer || "1") === "1" ? " selected=\"selected\"" : ""}>True</option></select>
         ${editor("feedbacktrue", saved?.feedbacktrue || "", "884403")}${editor("feedbackfalse", saved?.feedbackfalse || "", "884404")}`
      : qtype === "multichoice"
        ? `<select name="single"><option value="0"${saved?.single === "0" ? " selected" : ""}>Multiple answers</option><option value="1"${(saved?.single || "1") === "1" ? " selected" : ""}>One answer</option></select>
           ${control("shuffleanswers", "0")}<input type="checkbox" name="shuffleanswers" value="1" checked>
           <select name="answernumbering">${["abc", "123"].map((value) => `<option value="${value}"${(saved ? state.savedNumberingOverride || saved.numbering : state.numbering) === value ? " selected" : ""}>${value}</option>`).join("")}</select>
           <select name="showstandardinstruction"><option value="0">No</option><option value="1" selected>Yes</option></select>
           ${["correctfeedback", "partiallycorrectfeedback", "incorrectfeedback"].map((field) => editor(field, "Native default feedback.", "884607")).join("")}
           ${[0, 1, 2, 3, 4].map((index) => answerRow(index, saved?.answers?.[index], qtype, Boolean(saved))).join("")}`
      : `<select name="usecase"><option value="0"${(saved?.usecase || "0") === "0" ? " selected=\"selected\"" : ""}>No</option><option value="1"${saved?.usecase === "1" ? " selected=\"selected\"" : ""}>Yes</option></select>
         ${[0, 1, 2].map((index) => answerRow(index, saved?.answers?.[index], qtype, Boolean(saved))).join("")}`;
    return `<!doctype html><html><body class="path-question course-2"><form method="post" action="/question/bank/editquestion/question.php">
      ${control("sesskey", sesskey)}${control("qtype", qtype)}${control("category", category)}
      ${control("cmid", BANK_MODULE_ID)}${control("courseid", COURSE_ID)}${control("returnurl", escaped(bankReturnUrl))}
      ${control(`_qf__qtype_${qtype}_edit_form`, "1")}
      ${saved ? control("id", saved.id) : view === "existing-id" ? control("id", EXISTING_ENTRY_ID) : control("id", "")}
      ${view === "makecopy" ? control("makecopy", "1") : ""}${view === "append-quiz" ? control("appendqnumstring", "addquestion") : ""}
      <select name="status"><option value="ready"${status === "ready" ? " selected=\"selected\"" : ""}>Ready</option><option value="draft"${status === "draft" ? " selected=\"selected\"" : ""}>Draft</option></select>
      <input type="text" name="name" value="${escaped(name)}">
      ${editor("questiontext", questionText, DRAFT_ITEM)}
      <input type="text" name="defaultmark" value="1.0000000">
      ${editor("generalfeedback", "", "884402")}
      <select name="tags[]" multiple><option value="7"${view === "tags" ? " selected=\"selected\"" : ""}>authoring-tag</option></select>
      ${view === "file-manager" ? '<div data-fieldtype="filemanager"><input type="hidden" name="attachments" value="99"></div>' : ""}
      ${typed}
      <input type="submit" name="submitbutton" value="Save changes">
      <input type="submit" name="cancel" value="Cancel">
    </form></body></html>`;
  };

  const savedEntryOf = (values) => {
    const qtype = values.get("qtype") || "";
    const answers = (qtype === "multichoice" ? [0, 1, 2, 3, 4] : [0, 1, 2])
      .map((index) => ({ text: values.get(qtype === "shortanswer" ? `answer[${index}]` : `answer[${index}][text]`) || "", fraction: values.get(`fraction[${index}]`) || "", feedback: values.get(`feedback[${index}][text]`) || "" }));
    return {
      id: String(state.nextEntryId++),
      qtype,
      name: values.get("name") || "",
      questionText: values.get("questiontext[text]") || "",
      status: values.get("status") || "",
      category: values.get("category") || "",
      ...(qtype === "truefalse"
        ? { correctanswer: values.get("correctanswer") || "", feedbacktrue: values.get("feedbacktrue[text]") || "", feedbackfalse: values.get("feedbackfalse[text]") || "" }
        : { usecase: values.get("usecase") || "", single: values.get("single") || "", numbering: values.get("answernumbering") || "", answers }),
    };
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
        section: [{ id: 7, number: 3, title: "Assessment" }],
        cm: state.activities,
      }) }]));
      return;
    }
    if (request.method === "GET" && url.pathname === "/mod/quiz/edit.php") {
      const cmid = url.searchParams.get("cmid") || "";
      const addquestion = url.searchParams.get("addquestion") || "";
      if (cmid !== QUIZ_MODULE_ID) { response.writeHead(404).end(); return; }
      if (addquestion) {
        if (url.searchParams.get("sesskey") !== ANCHOR_SESSION) { response.writeHead(403).end(); return; }
        if (state.entries.some((entry) => entry.id === addquestion) && !state.slots.some((slot) => slot.questionId === addquestion)) {
          state.slots = [...state.slots, { slotId: 30 + state.slots.length, questionId: addquestion, name: state.entries.find((entry) => entry.id === addquestion).name, version: "0" }];
        }
        response.writeHead(303, { location: `/mod/quiz/edit.php?cmid=${QUIZ_MODULE_ID}` });
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "text/html" });
      response.end(quizPage());
      return;
    }
    if (request.method === "GET" && url.pathname === "/question/edit.php") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(bankPage());
      return;
    }
    if (request.method === "GET" && url.pathname === "/question/bank/editquestion/addquestion.php") {
      const qtype = url.searchParams.get("qtype") || "";
      const params = new URLSearchParams({ qtype, cmid: url.searchParams.get("cmid") || "", category: url.searchParams.get("category") || "", courseid: COURSE_ID });
      if (state.chooserView === "existing") params.set("id", EXISTING_ENTRY_ID);
      response.writeHead(303, { location: `/question/bank/editquestion/question.php?${params.toString()}` });
      response.end();
      return;
    }
    if (request.method === "GET" && url.pathname === "/question/bank/editquestion/question.php") {
      const id = url.searchParams.get("id") || "";
      if (id) {
        const saved = state.entries.find((entry) => entry.id === id);
        if (!saved || url.searchParams.get("cmid") !== BANK_MODULE_ID) { response.writeHead(404).end(); return; }
        response.writeHead(200, { "content-type": "text/html" });
        response.end(questionForm(saved.qtype, saved));
        return;
      }
      response.writeHead(200, { "content-type": "text/html" });
      response.end(questionForm(url.searchParams.get("qtype") || "truefalse", null));
      return;
    }
    if (request.method === "POST" && url.pathname === "/question/bank/editquestion/question.php") {
      const values = new URLSearchParams(await readBody(request));
      posts.push({ pathname: url.pathname, search: url.search, values });
      if (state.postOutcome === "validation") {
        response.writeHead(200, { "content-type": "text/html" });
        response.end(questionForm(values.get("qtype") || "truefalse", null));
        return;
      }
      state.entries = [...state.entries, savedEntryOf(values)];
      // A site that saved a second entry in the same request is not the approved change.
      if (state.postOutcome === "extra-entry") state.entries = [...state.entries, { ...state.entries[0], id: String(state.nextEntryId++) }];
      response.writeHead(303, { location: bankReturnUrl });
      response.end();
      return;
    }
    response.writeHead(404).end();
  });

  try {
    await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", (error) => error ? reject(error) : resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("qbank question test server did not bind");
    origin = `https://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
    context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    await page.goto(`${origin}/course/view.php?id=1`);
    const binding = { origin, siteUrl: `${origin}/`, principalId: "3", courseId: COURSE_ID };
    const results = [];
    const execute = async (operation, argumentsValue, expiresAt = Date.now() + 60_000) => {
      const result = await page.evaluate(executeMoodleQbankQuestionInPage, JSON.stringify({ mode: "execute", operation, arguments: argumentsValue, binding, expiresAt }));
      results.push(result);
      return result;
    };
    const loseNextResponse = (pathname, method, searchMatch = "") => page.evaluate(([targetPath, targetMethod, targetSearch]) => {
      const nativeFetch = globalThis.fetch;
      globalThis.fetch = async (...parameters) => {
        const response = await nativeFetch(...parameters);
        const requested = new URL(parameters[0], globalThis.location.href);
        if (String(parameters[1]?.method || "GET").toUpperCase() === targetMethod && requested.pathname === targetPath
          && requested.search.includes(targetSearch)) {
          globalThis.fetch = nativeFetch;
          throw new TypeError("response lost after dispatch");
        }
        return response;
      };
    }, [pathname, method, searchMatch]);
    const SOURCE_PATHS = ["/lib/ajax/service.php", "/mod/quiz/edit.php", "/question/edit.php", "/question/bank/editquestion/addquestion.php", "/question/bank/editquestion/question.php"];
    const nativeRequests = () => requests.filter((entry) => SOURCE_PATHS.includes(entry.pathname)).length;
    const slotDispatches = () => requests.filter((entry) => entry.pathname === "/mod/quiz/edit.php" && entry.search.includes("addquestion=")).length;
    const formArguments = (extra = {}) => ({ course_id: 2, module_id: 21, category_id: 91, question_bank_context_id: 305, qtype: "truefalse", ...extra });
    const slotArguments = (extra = {}) => ({ course_id: 2, module_id: 21, category_id: 91, question_bank_context_id: 305, question_id: Number(EXISTING_ENTRY_ID), quiz_module_id: 9, ...extra });

    // 1. Arguments are refused before any native request.
    const beforeArguments = nativeRequests();
    for (const [args, label] of [
      [formArguments({ course_id: 3 }), "another course"],
      [formArguments({ qtype: "calculated" }), "an unsupported type"],
      [formArguments({ name: "x" }), "an unexpected field"],
      [{ course_id: 2, module_id: 21, category_id: 91, qtype: "truefalse" }, "a missing bank context"],
    ]) {
      assert.deepEqual(await execute(operations.creationForm, args), { ok: false, sent: false, error: "moodle_qbank_question_arguments_invalid" }, label);
    }
    for (const [args, label] of [
      [{ ...TRUE_FALSE }, "a missing digest"],
      [{ ...TRUE_FALSE, name: " padded ", expected_digest: "a".repeat(64) }, "an uncollapsed name"],
      [{ ...TRUE_FALSE, question_text: "<img src=\"data:image/png;base64,AA\">", expected_digest: "a".repeat(64) }, "a file reference"],
      [{ ...SHORT_ANSWER, answers: [{ text: "Nearly", fraction: "0.5", feedback: "" }], expected_digest: "a".repeat(64) }, "no full-credit answer"],
      [{ ...SHORT_ANSWER, answers: [{ text: "Same", fraction: "1.0", feedback: "" }, { text: "Same", fraction: "0.5", feedback: "" }], expected_digest: "a".repeat(64) }, "duplicate answers"],
    ]) {
      assert.deepEqual(await execute(operations.create, args), { ok: false, sent: false, error: "moodle_qbank_question_arguments_invalid" }, label);
    }
    assert.deepEqual(await execute({ ...operations.creationForm, readOnly: false }, formArguments()), { ok: false, sent: false, error: "moodle_operation_refused" });
    assert.deepEqual(await execute(operations.creationForm, formArguments(), Date.now() - 1), { ok: false, sent: false, error: "moodle_execution_expired" });
    assert.equal(nativeRequests(), beforeArguments);

    // 2. The module targets are bound through the course state, not through the arguments.
    assert.deepEqual(await execute(operations.creationForm, formArguments({ module_id: 5 })), { ok: false, sent: false, status: 200, error: "moodle_qbank_module_target_invalid" });
    assert.deepEqual(await execute(operations.slotPlan, slotArguments({ quiz_module_id: 21 })), { ok: false, sent: false, status: 200, error: "moodle_qbank_question_quiz_target_invalid" });

    // 3. An incomplete impact scope, and a NONE filter, refuse both effects before the bank page.
    state.quizView = "unresolved";
    assert.deepEqual(await execute(operations.creationForm, formArguments()), { ok: false, sent: false, status: 200, error: "moodle_qbank_question_impact_scope_incomplete" });
    assert.deepEqual(await execute(operations.slotPlan, slotArguments()), { ok: false, sent: false, status: 200, error: "moodle_qbank_question_impact_scope_incomplete" });
    state.quizView = "none-filter";
    assert.deepEqual(await execute(operations.creationForm, formArguments()), { ok: false, sent: false, status: 200, error: "moodle_qbank_question_random_filter_none" });
    assert.deepEqual(await execute(operations.slotPlan, slotArguments()), { ok: false, sent: false, status: 200, error: "moodle_qbank_question_random_filter_none" });
    state.quizView = "core";
    assert.equal(requests.some((entry) => entry.pathname === "/question/edit.php"), false, "an incomplete scope never opens the bank page");

    // 4. The bank page must show the add-question control, one context group, and a bank-scoped route.
    for (const [view, error] of [
      ["no-add", "moodle_qbank_question_add_absent"],
      ["two-contexts", "moodle_qbank_category_not_isolated"],
      ["append-quiz", "moodle_qbank_question_route_not_bank_scoped"],
      ["quiz-return", "moodle_qbank_question_route_not_bank_scoped"],
    ]) {
      state.bankView = view;
      assert.deepEqual(await execute(operations.creationForm, formArguments()), { ok: false, sent: false, status: 200, error }, view);
    }
    state.bankView = "core";

    // 5. The native chain must land on a creation form, and that form must be one.
    state.chooserView = "existing";
    assert.deepEqual(await execute(operations.creationForm, formArguments()), { ok: false, sent: false, status: 200, error: "moodle_qbank_question_entry_exists" });
    state.chooserView = "core";
    state.formSessionQueue.push(FOREIGN_SESSION);
    assert.deepEqual(await execute(operations.creationForm, formArguments()), { ok: false, sent: false, status: 200, error: "moodle_form_session_mismatch" });
    for (const [view, error] of [
      ["existing-id", "moodle_qbank_question_entry_exists"],
      ["makecopy", "moodle_qbank_question_entry_exists"],
      ["append-quiz", "moodle_qbank_question_route_not_bank_scoped"],
      ["draft-status", "moodle_qbank_question_status_unexpected"],
      ["wrong-category", "moodle_qbank_question_category_mismatch"],
      ["file-manager", "moodle_qbank_question_file_area_unexpected"],
      ["dirty-editor", "moodle_qbank_question_file_area_unexpected"],
      ["tags", "moodle_qbank_question_tags_unexpected"],
    ]) {
      state.formView = view;
      assert.deepEqual(await execute(operations.creationForm, formArguments()), { ok: false, sent: false, status: 200, error }, view);
    }
    state.formView = "core";
    assert.equal(posts.length, 0, "no refusal reached a POST");

    // 6. The reviewed creation form.
    const form = await execute(operations.creationForm, formArguments());
    assert.equal(form.ok, true, JSON.stringify(form));
    assert.deepEqual(form.targets, [
      { field: "course_id", label: "Course", name: "Question bank isolation evidence" },
      { field: "module_id", label: "Question bank", name: BANK_NAME },
    ]);
    const impactScope = {
      status: "complete",
      quiz_count: 1,
      slot_count: 2,
      direct_reference_count: 1,
      random_reference_count: 1,
      recognised_filter_keys: ["category"],
      scope: "approved_course_only",
      condition_class_resolution: "not_exposed",
    };
    const creationProof = {
      method: "native_question_bank_creation_chain",
      route: "/question/bank/editquestion/question.php",
      entry_route: "/question/edit.php",
      chooser_route: "/question/bank/editquestion/addquestion.php",
      required_capability: "moodle/question:add",
      capability_source: "bank_page_add_question_control",
      scope: "one_new_entry_in_the_approved_qbank_category",
      file_policy: "empty",
      tag_policy: "empty",
      existing_entry_policy: "never_cloned_moved_or_updated",
      question_bank_update_eligibility: "held",
    };
    assert.deepEqual(form.data, {
      schema: "morrow.moodle-qbank-question.v1",
      provider: "moodle",
      course_id: 2,
      module_id: 21,
      category_id: 91,
      question_bank_context_id: 305,
      qtype: "truefalse",
      question_status: "ready",
      question_text_format: "1",
      general_feedback_format: "1",
      default_mark: "1.0000000",
      correct_answer_options: ["0", "1"],
      category_contexts_listed: 1,
      category_option_count: 2,
      question_add_capability: "present",
      file_areas_empty: true,
      tags_empty: true,
      impact_scope: impactScope,
      protected_settings_digest: form.data.protected_settings_digest,
      protected_setting_names: [
        "_qf__qtype_truefalse_edit_form", "category", "cmid", "courseid", "defaultmark",
        "feedbackfalse[format]", "feedbackfalse[itemid]", "feedbacktrue[format]", "feedbacktrue[itemid]",
        "generalfeedback[format]", "generalfeedback[itemid]", "generalfeedback[text]", "id",
        "qtype", "questiontext[format]", "questiontext[itemid]", "returnurl", "status",
      ],
      proof: creationProof,
    });
    assert.equal(form.snapshot_digest, digestOf(form.data));
    assert.equal(posts.length, 0, "a review read sends no POST");

    // 7. A stale digest never reaches a POST, and the impact scope is part of that digest.
    assert.deepEqual(await execute(operations.create, { ...TRUE_FALSE, expected_digest: "b".repeat(64) }), { ok: false, sent: false, status: 200, error: "moodle_expected_digest_mismatch" });
    state.slots = [...state.slots, { slotId: 19, questionId: FOREIGN_ENTRY_ID, name: "Question added after the review read", version: "0" }];
    assert.deepEqual(await execute(operations.create, { ...TRUE_FALSE, expected_digest: form.snapshot_digest }), { ok: false, sent: false, status: 200, error: "moodle_expected_digest_mismatch" });
    state.slots = state.slots.slice(0, 2);
    assert.equal(posts.length, 0);

    // 8. The native form answers a refused save with itself, which saved nothing.
    state.postOutcome = "validation";
    assert.deepEqual(await execute(operations.create, { ...TRUE_FALSE, expected_digest: form.snapshot_digest }), {
      ok: false, sent: true, status: 200, outcomeUnknown: false,
      verification: { schema: "morrow.browser-verification.v1", status: "mismatch", reason: "moodle_form_validation_failed" },
      error: "moodle_form_validation_failed",
    });
    assert.equal(posts.length, 1);
    assert.equal(state.entries.length, 1, "a refused save added no bank entry");

    // 8b. A save that left more than one new entry behind is reported as applied or unknown.
    state.postOutcome = "extra-entry";
    assert.deepEqual(await execute(operations.create, { ...TRUE_FALSE, expected_digest: form.snapshot_digest }), {
      ok: false, sent: true, status: 200, outcomeUnknown: true,
      verification: { schema: "morrow.browser-verification.v1", status: "unconfirmed", reason: "moodle_qbank_question_create_not_verified" },
      error: "moodle_qbank_question_create_not_verified",
    });
    assert.equal(state.entries.length, 3);
    // The fixture returns to one saved entry, and to the first free entry ID, for the exact counts below.
    state.entries = state.entries.slice(0, 1);
    state.nextEntryId = 402;
    state.postOutcome = "saved";

    // 9. One approved creation, one POST, and an exact saved readback.
    const approvedPost = posts.length;
    const created = await execute(operations.create, { ...TRUE_FALSE, expected_digest: form.snapshot_digest });
    assert.equal(created.ok, true, JSON.stringify(created));
    assert.equal(posts.length, approvedPost + 1, "one approved creation sends one POST");
    const sent = posts[approvedPost].values;
    assert.equal(sent.get("name"), TRUE_FALSE.name);
    assert.equal(sent.get("questiontext[text]"), TRUE_FALSE.question_text);
    assert.equal(sent.get("correctanswer"), "1");
    assert.equal(sent.get("feedbacktrue[text]"), TRUE_FALSE.true_feedback);
    assert.equal(sent.get("feedbackfalse[text]"), TRUE_FALSE.false_feedback);
    assert.equal(sent.get("category"), `${CATEGORY_ID},${CONTEXT_ID}`);
    assert.equal(sent.get("cmid"), BANK_MODULE_ID);
    assert.equal(sent.get("status"), "ready");
    assert.equal(sent.get("id"), "");
    assert.equal(sent.get("makecopy"), null, "a creation never carries a copy control");
    assert.equal(sent.get("submitbutton"), "Save changes");
    assert.equal(sent.get("cancel"), null, "only the reviewed submit control is sent");
    assert.equal(sent.getAll("name").length, 1);
    assert.equal(sent.get("sesskey"), ANCHOR_SESSION, "the native session key stays inside the page");
    assert.deepEqual(created.verification, { schema: "morrow.browser-verification.v1", status: "verified" });
    assert.deepEqual(created.data, {
      schema: "morrow.moodle-qbank-question.v1",
      provider: "moodle",
      course_id: 2,
      module_id: 21,
      question_id: 402,
      name: TRUE_FALSE.name,
      question_text: TRUE_FALSE.question_text,
      qtype: "truefalse",
      version_status: "ready",
      category_id: 91,
      question_bank_context_id: 305,
      correct_answer: true,
      true_feedback: TRUE_FALSE.true_feedback,
      false_feedback: TRUE_FALSE.false_feedback,
      created: true,
      quiz_slots_added: 0,
      later_updates: "held",
      impact_scope: impactScope,
      proof: creationProof,
    });
    assert.equal(created.snapshot_digest, digestOf(created.data));
    assert.equal(state.entries.length, 2, "exactly one new bank entry");
    assert.equal(state.entries[0].name, "Existing bank entry", "the existing entry is untouched");
    assert.equal(slotDispatches(), 0, "creating a question adds no Quiz slot");

    // 10. The second supported type, through the same two reads.
    const shortForm = await execute(operations.creationForm, formArguments({ qtype: "shortanswer" }));
    assert.equal(shortForm.ok, true, JSON.stringify(shortForm));
    assert.deepEqual(shortForm.data.answer_row_count, 3);
    assert.deepEqual(shortForm.data.fraction_options, ["1.0", "0.5", "0.0"]);
    const shortCreated = await execute(operations.create, { ...SHORT_ANSWER, expected_digest: shortForm.snapshot_digest });
    assert.equal(shortCreated.ok, true, JSON.stringify(shortCreated));
    assert.equal(shortCreated.data.question_id, 403);
    assert.equal(shortCreated.data.case_sensitive, false);
    assert.deepEqual(shortCreated.data.answers, SHORT_ANSWER.answers.map((answer) => ({ text: answer.text, fraction: answer.fraction, feedback: answer.feedback })));
    assert.equal(shortCreated.data.later_updates, "held");
    assert.equal(posts.at(-1).values.get("answer[0]"), SHORT_ANSWER.answers[0].text);
    assert.equal(posts.at(-1).values.has("answer[0][text]"), false);
    assert.equal(state.entries.length, 3);

    // 11. A saved entry that does not match the approval is applied-or-unknown.
    const driftForm = await execute(operations.creationForm, formArguments());
    state.savedNameOverride = "Name the site kept";
    const drifted = await execute(operations.create, { ...TRUE_FALSE, name: "Requested question name", expected_digest: driftForm.snapshot_digest });
    assert.deepEqual(drifted, {
      ok: false, sent: true, status: 200, outcomeUnknown: true,
      verification: { schema: "morrow.browser-verification.v1", status: "unconfirmed", reason: "moodle_qbank_question_create_not_verified" },
      error: "moodle_qbank_question_create_not_verified",
    });
    assert.equal(state.entries.length, 4, "the site kept the entry the browser could not confirm");
    state.savedNameOverride = "";
    // The site kept that entry. The fixture drops it so the later entry counts stay exact.
    state.entries = state.entries.slice(0, 3);

    // 12. The slot plan reads the saved entry and the complete Quiz structure.
    const plan = await execute(operations.slotPlan, slotArguments({ question_id: 402 }));
    assert.equal(plan.ok, true, JSON.stringify(plan));
    assert.deepEqual(plan.targets, [
      { field: "course_id", label: "Course", name: "Question bank isolation evidence" },
      { field: "quiz_module_id", label: "Quiz", name: QUIZ_NAME },
    ]);
    const slotProof = {
      method: "native_quiz_add_question_action",
      route: "/mod/quiz/edit.php",
      required_capabilities: ["mod/quiz:manage", "moodle/question:use"],
      capability_source: "native_quiz_edit_page_and_action_result",
      scope: "one_new_slot_at_the_end_of_the_approved_quiz",
      slot_reference: "direct_entry_reference",
      slot_version: "latest",
      existing_slots: "unchanged",
      question_bank_update_eligibility: "held",
    };
    const priorSlots = [
      { slot_id: 17, position: 1, reference: "direct", resolved: true, question_id: 401, version_mode: "latest" },
      { slot_id: 18, position: 2, reference: "random", resolved: true },
    ];
    assert.deepEqual(plan.data, {
      schema: "morrow.moodle-qbank-quiz-slot.v1",
      provider: "moodle",
      course_id: 2,
      quiz_module_id: 9,
      module_id: 21,
      category_id: 91,
      question_bank_context_id: 305,
      question_id: 402,
      question_name: TRUE_FALSE.name,
      question_digest: plan.data.question_digest,
      qtype: "truefalse",
      question_status: "ready",
      quiz_slot_count: 2,
      quiz_slots: priorSlots,
      question_in_quiz: false,
      impact_scope: impactScope,
      proof: slotProof,
    });
    assert.equal(plan.snapshot_digest, digestOf(plan.data));

    // 13. An entry outside the approved category, and a stale digest, never reach the Quiz action.
    const bankScoped = await execute(operations.slotPlan, slotArguments({ question_id: Number(EXISTING_ENTRY_ID) }));
    assert.equal(bankScoped.ok, true, JSON.stringify(bankScoped));
    state.entries = state.entries.map((entry) => (entry.id === EXISTING_ENTRY_ID ? { ...entry, category: "42,420" } : entry));
    assert.deepEqual(await execute(operations.slotPlan, slotArguments({ question_id: Number(EXISTING_ENTRY_ID) })), { ok: false, sent: false, status: 200, error: "moodle_qbank_question_category_mismatch" });
    state.entries = state.entries.map((entry) => (entry.id === EXISTING_ENTRY_ID ? { ...entry, category: `${CATEGORY_ID},${CONTEXT_ID}` } : entry));
    assert.deepEqual(await execute(operations.addSlot, slotArguments({ question_id: 402, expected_digest: "c".repeat(64) })), { ok: false, sent: false, status: 200, error: "moodle_expected_digest_mismatch" });
    assert.equal(slotDispatches(), 0);

    // 14. One approved slot addition: one dispatch, no POST, exactly one new slot.
    const postsBefore = posts.length;
    const added = await execute(operations.addSlot, slotArguments({ question_id: 402, expected_digest: plan.snapshot_digest }));
    assert.equal(added.ok, true, JSON.stringify(added));
    assert.equal(slotDispatches(), 1, "one native Quiz action");
    assert.equal(posts.length, postsBefore, "adding a slot sends no form post");
    assert.deepEqual(added.verification, { schema: "morrow.browser-verification.v1", status: "verified" });
    assert.deepEqual(added.data, {
      ...plan.data,
      quiz_slot_count: 3,
      quiz_slots: [...priorSlots, { slot_id: 32, position: 3, reference: "direct", resolved: true, question_id: 402, version_mode: "latest" }],
      question_in_quiz: true,
      added_slot_id: 32,
      added_slot_position: 3,
      later_updates: "held",
    });
    assert.equal(added.snapshot_digest, digestOf(added.data));
    assert.equal(state.slots.length, 3);
    assert.equal(state.entries.length, 3, "adding a slot creates no bank entry");

    // 15. The same entry is never added twice.
    assert.deepEqual(await execute(operations.slotPlan, slotArguments({ question_id: 402 })), { ok: false, sent: false, status: 200, error: "moodle_qbank_question_already_in_quiz" });
    assert.equal(slotDispatches(), 1);

    // 16. A lost response after either dispatch is applied-or-unknown, never retried.
    const lostForm = await execute(operations.creationForm, formArguments());
    const lostPostsBefore = posts.length;
    await loseNextResponse("/question/bank/editquestion/question.php", "POST");
    assert.deepEqual(await execute(operations.create, { ...TRUE_FALSE, name: "Lost response question", expected_digest: lostForm.snapshot_digest }), {
      ok: false, sent: true, outcomeUnknown: true,
      verification: { schema: "morrow.browser-verification.v1", status: "unconfirmed", reason: "moodle_qbank_question_create_unconfirmed" },
      error: "moodle_qbank_question_create_unconfirmed",
    });
    assert.equal(posts.length, lostPostsBefore + 1);
    assert.equal(state.entries.filter((entry) => entry.name === "Lost response question").length, 1, "the site kept the change the browser could not confirm");

    const lostPlan = await execute(operations.slotPlan, slotArguments({ question_id: 405 }));
    assert.equal(lostPlan.ok, true, JSON.stringify(lostPlan));
    const lostDispatchesBefore = slotDispatches();
    await loseNextResponse("/mod/quiz/edit.php", "GET", "addquestion=");
    assert.deepEqual(await execute(operations.addSlot, slotArguments({ question_id: 405, expected_digest: lostPlan.snapshot_digest })), {
      ok: false, sent: true, outcomeUnknown: true,
      verification: { schema: "morrow.browser-verification.v1", status: "unconfirmed", reason: "moodle_qbank_quiz_slot_unconfirmed" },
      error: "moodle_qbank_quiz_slot_unconfirmed",
    });
    assert.equal(slotDispatches(), lostDispatchesBefore + 1);
    assert.equal(state.slots.length, 4, "the site kept the slot the browser could not confirm");

    // Native Multiple choice can create either one-answer or multiple-answer questions.
    const choiceBase = {
      course_id: 2, module_id: 21, category_id: 91, question_bank_context_id: 305,
      qtype: "multichoice", name: "Choice question", question_text: "Select the correct choices.",
    };
    for (const single of [true, false]) {
      const choices = [
        { text: "<p>First choice</p>", fraction: single ? "1.0" : "0.5", feedback: "First feedback." },
        { text: "<p>Second choice</p>", fraction: single ? "0.0" : "0.5", feedback: "Second feedback." },
        { text: "<p>Incorrect choice</p>", fraction: "-1.0", feedback: "Third feedback." },
      ];
      const choiceForm = await execute(operations.creationForm, formArguments({ qtype: "multichoice" }));
      assert.equal(choiceForm.ok, true, JSON.stringify(choiceForm));
      assert.deepEqual(choiceForm.data.single_options, ["0", "1"]);
      assert.equal(choiceForm.data.answer_row_count, 5);
      const countBefore = posts.length;
      const choicesCreated = await execute(operations.create, { ...choiceBase, single, answers: choices, expected_digest: choiceForm.snapshot_digest });
      assert.equal(choicesCreated.ok, true, JSON.stringify(choicesCreated));
      assert.equal(posts.length, countBefore + 1);
      assert.equal(choicesCreated.data.single, single);
      assert.deepEqual(choicesCreated.data.answers, choices);
      assert.equal(posts.at(-1).values.get("answer[0][text]"), choices[0].text);
      assert.equal(posts.at(-1).values.get("correctfeedback[text]"), "Native default feedback.");
      assert.equal(posts.at(-1).values.get("answernumbering"), "abc");
      assert.deepEqual(posts.at(-1).values.getAll("shuffleanswers"), ["0", "1"]);
      const choicePlan = await execute(operations.slotPlan, slotArguments({ question_id: choicesCreated.data.question_id }));
      assert.equal(choicePlan.ok, true, JSON.stringify(choicePlan));
      assert.equal(choicePlan.data.qtype, "multichoice");
      const choiceSlot = await execute(operations.addSlot, slotArguments({ question_id: choicesCreated.data.question_id, expected_digest: choicePlan.snapshot_digest }));
      assert.equal(choiceSlot.ok, true, JSON.stringify(choiceSlot));
    }

    const validChoices = [
      { text: "First", fraction: "1.0", feedback: "" },
      { text: "Second", fraction: "0.0", feedback: "" },
    ];
    const beforeInvalidChoices = nativeRequests();
    for (const args of [
      { single: true, answers: validChoices.slice(0, 1) },
      { single: false, answers: validChoices.map((answer) => ({ ...answer, fraction: "0.5" })).concat({ text: "Third", fraction: "0.5", feedback: "" }) },
      { single: true, answers: validChoices.map((answer) => ({ ...answer, fraction: "0.5" })) },
      { single: true, answers: [{ ...validChoices[0], fraction: "1.1" }, validChoices[1]] },
      { single: true, answers: [{ ...validChoices[0], text: '<img src="draftfile.php/x">' }, validChoices[1]] },
    ]) {
      const refused = await execute(operations.create, { ...choiceBase, ...args, expected_digest: "a".repeat(64) });
      assert.equal(refused.error, "moodle_qbank_question_arguments_invalid", JSON.stringify(refused));
      assert.equal(refused.sent, false);
    }
    assert.equal(nativeRequests(), beforeInvalidChoices);

    // A changed protected default invalidates the reviewed form, even when field names stay identical.
    const protectedForm = await execute(operations.creationForm, formArguments({ qtype: "multichoice" }));
    state.numbering = "123";
    const protectedPosts = posts.length;
    const protectedDrift = await execute(operations.create, { ...choiceBase, single: true, answers: validChoices, expected_digest: protectedForm.snapshot_digest });
    assert.equal(protectedDrift.error, "moodle_expected_digest_mismatch", JSON.stringify(protectedDrift));
    assert.equal(posts.length, protectedPosts);
    state.numbering = "abc";

    // Moodle may render a saved fraction with fewer trailing zeroes.
    const normalizationForm = await execute(operations.creationForm, formArguments({ qtype: "multichoice" }));
    state.normalizeSavedFractions = true;
    const normalized = await execute(operations.create, { ...choiceBase, single: true, answers: validChoices, expected_digest: normalizationForm.snapshot_digest });
    assert.equal(normalized.ok, true, JSON.stringify(normalized));
    assert.equal(normalized.data.answers[0].fraction, "1");
    assert.equal(normalized.data.answers[1].fraction, "0");
    state.normalizeSavedFractions = false;

    // Native fractions must be offered by the reviewed form before any POST.
    const fractionForm = await execute(operations.creationForm, formArguments({ qtype: "multichoice" }));
    const fractionPosts = posts.length;
    const absentFraction = await execute(operations.create, { ...choiceBase, single: false,
      answers: [{ ...validChoices[0], fraction: "0.75" }, { ...validChoices[1], fraction: "0.25" }], expected_digest: fractionForm.snapshot_digest });
    assert.equal(absentFraction.error, "moodle_qbank_question_content_unwritable", JSON.stringify(absentFraction));
    assert.equal(posts.length, fractionPosts);

    // Saved native defaults must survive the write, not only the preflight.
    const savedDefaultForm = await execute(operations.creationForm, formArguments({ qtype: "multichoice" }));
    state.savedNumberingOverride = "123";
    const savedDefaultDrift = await execute(operations.create, { ...choiceBase, single: true, answers: validChoices, expected_digest: savedDefaultForm.snapshot_digest });
    assert.equal(savedDefaultDrift.error, "moodle_qbank_question_create_not_verified", JSON.stringify(savedDefaultDrift));
    assert.equal(savedDefaultDrift.outcomeUnknown, true);
    assert.equal(posts.length, fractionPosts + 1);
    state.savedNumberingOverride = "";

    // The slot approval binds the full saved question, including text and answers.
    const stablePlan = await execute(operations.slotPlan, slotArguments({ question_id: 403 }));
    const entry = state.entries.find((entry) => entry.id === "403");
    entry.questionText = "A different question after review.";
    const stableDispatches = slotDispatches();
    const changedEntry = await execute(operations.addSlot, slotArguments({ question_id: 403, expected_digest: stablePlan.snapshot_digest }));
    assert.equal(changedEntry.error, "moodle_expected_digest_mismatch", JSON.stringify(changedEntry));
    assert.equal(slotDispatches(), stableDispatches);

    // 17. Route and secret boundaries across the whole run.
    assert.equal(requests.some((entry) => /^\/mod\/quiz\/(?:view|attempt|review|report)\.php/.test(entry.pathname)), false, "no Quiz attempt or report route was opened");
    assert.equal(requests.some((entry) => entry.method === "POST" && !["/question/bank/editquestion/question.php", "/lib/ajax/service.php"].includes(entry.pathname)), false);
    assert.equal(requests.some((entry) => entry.pathname === "/mod/qbank/view.php"), false, "phase two never re-runs the phase one route");
    assert.equal(JSON.stringify(results).includes(ANCHOR_SESSION), false, "a result leaked the session key");
    assert.equal(JSON.stringify(results).includes(FOREIGN_SESSION), false, "a result leaked a session key");
    assert.equal(JSON.stringify(results).includes(DRAFT_ITEM), false, "a result leaked a draft item ID");
  } finally {
    await context?.close();
    await browser?.close();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});
