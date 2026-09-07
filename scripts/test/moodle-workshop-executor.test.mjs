import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { executeMoodleWorkshopInPage } from "../../connector/extension/src/moodle-workshop-executor.js";

const SESSION = "synthetic-session";

const workshopRead = { key: "moodle.form.course.modedit.workshop.read.v1", toolName: "moodle_get_workshop", provider: "moodle", readOnly: true };
const creationRead = { key: "moodle.form.course.modedit.workshop.create.read.v1", toolName: "moodle_get_workshop_creation_form", provider: "moodle", readOnly: true };
const workshopCreate = { key: "moodle.form.course.modedit.workshop.create.write.v1", toolName: "moodle_create_workshop", provider: "moodle", readOnly: false };
const workshopUpdate = { key: "moodle.form.course.modedit.workshop.write.v1", toolName: "moodle_update_workshop", provider: "moodle", readOnly: false };
const phaseRead = { key: "moodle.form.workshop.phase.read.v1", toolName: "moodle_get_workshop_phase", provider: "moodle", readOnly: true };

const EDITORS = [["intro", "introeditor"], ["instructauthors", "instructauthorseditor"], ["instructreviewers", "instructreviewerseditor"], ["conclusion", "conclusioneditor"]];
const DATES = ["submissionstart", "submissionend", "assessmentstart", "assessmentend"];
const DATE_PARTS = ["year", "month", "day", "hour", "minute"];
const TYPES = ["submissiontypetextavailable", "submissiontypetextrequired", "submissiontypefileavailable", "submissiontypefilerequired"];
const SELECTS = {
  strategy: ["accumulative", "comments", "numerrors", "rubric"],
  grade: ["0", "50", "80", "100"],
  gradinggrade: ["0", "20", "50", "100"],
  gradedecimals: ["0", "1", "2"],
  nattachments: ["1", "2", "3"],
  maxbytes: ["0", "1048576"],
  overallfeedbackmode: ["0", "1", "2"],
  overallfeedbackfiles: ["0", "1"],
  overallfeedbackmaxbytes: ["0", "1048576"],
  examplesmode: ["0", "1", "2"],
  groupmode: ["0", "1", "2"],
  visible: ["0", "1"],
};

const CATALOG = [
  { key: "moodle.form.course.modedit.workshop.read.v1", toolName: "moodle_get_workshop", readOnly: true },
  { key: "moodle.form.course.modedit.workshop.create.read.v1", toolName: "moodle_get_workshop_creation_form", readOnly: true },
  { key: "moodle.form.course.modedit.workshop.create.write.v1", toolName: "moodle_create_workshop", readOnly: false, reviewTool: "moodle_get_workshop_creation_form" },
  { key: "moodle.form.course.modedit.workshop.write.v1", toolName: "moodle_update_workshop", readOnly: false, reviewTool: "moodle_get_workshop" },
  { key: "moodle.form.workshop.phase.read.v1", toolName: "moodle_get_workshop_phase", readOnly: true },
];

test("every Workshop operation is cataloged, routed through the extension worker, and shipped in the bridge", () => {
  const root = new URL("../..", import.meta.url);
  const catalog = JSON.parse(readFileSync(new URL("connector/extension/generated/moodle-browser-catalog.json", root), "utf8"));
  const worker = readFileSync(new URL("connector/extension/src/service-worker.js", root), "utf8");
  const bundle = readFileSync(new URL("scripts/package-mcp-bundle.mjs", root), "utf8");
  assert.match(worker, /import \{ executeMoodleWorkshopInPage \} from "\.\/moodle-workshop-executor\.js";/);
  assert.match(worker, /func: executeMoodleWorkshopInPage/);
  assert.ok(bundle.includes('"src/moodle-workshop-executor.js"'), "the executor is not in the Bridge release file set");

  const readTools = new Set(catalog.operations.filter((entry) => entry.readOnly === true).map((entry) => entry.toolName));
  for (const expected of CATALOG) {
    const entries = catalog.operations.filter((entry) => entry.key === expected.key);
    assert.equal(entries.length, 1, `${expected.key} is not in the catalog exactly once`);
    assert.equal(entries[0].toolName, expected.toolName);
    assert.equal(entries[0].provider, "moodle");
    assert.equal(entries[0].readOnly, expected.readOnly);
    assert.equal(entries[0].reviewTool, expected.reviewTool);
    if (expected.reviewTool) assert.ok(readTools.has(expected.reviewTool), `${expected.toolName} names a review tool that is not a catalog read`);
    assert.equal(entries[0].destructive, undefined, `${expected.toolName} removes nothing and must not be marked destructive`);
    assert.ok(worker.includes(`"${expected.key}",`), `${expected.key} is not routed by the worker`);
  }
});

function readBody(request) {
  return new Promise((resolve) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

function option(value, selected) {
  return `<option value="${value}"${value === selected ? " selected" : ""}>${value}</option>`;
}

function selectControl(name, selected, values) {
  return `<select name="${name}">${values.map((value) => option(value, selected)).join("")}</select>`;
}

function dateControls(field, value) {
  const toggle = `<input type="checkbox" name="${field}[enabled]" value="1"${value ? " checked" : ""}>`;
  const defaults = { year: "2026", month: "9", day: "6", hour: "8", minute: "20" };
  const selects = DATE_PARTS.map((part) => {
    const current = String((value || defaults)[part]);
    return selectControl(`${field}[${part}]`, current, [current]);
  }).join("");
  return `${toggle}${selects}`;
}

// Moodle renders an advcheckbox as a hidden zero followed by the checkbox itself.
function advCheckbox(name, on) {
  return `<input type="hidden" name="${name}" value="0"><input type="checkbox" name="${name}" value="1"${on ? " checked" : ""}>`;
}

function plainCheckbox(name, on) {
  return `<input type="checkbox" name="${name}" value="1"${on ? " checked" : ""}>`;
}

function newState(overrides = {}) {
  return {
    name: "Peer review of unit one",
    intro: "<p>Read the brief before you start.</p>",
    instructauthors: "<p>Submit one file.</p>",
    instructreviewers: "<p>Give two reasons for each score.</p>",
    conclusion: "",
    strategy: "accumulative",
    grade: "80",
    gradinggrade: "20",
    gradedecimals: "2",
    nattachments: "1",
    maxbytes: "1048576",
    overallfeedbackmode: "1",
    overallfeedbackfiles: "0",
    overallfeedbackmaxbytes: "1048576",
    examplesmode: "0",
    groupmode: "0",
    submissionfiletypes: "",
    overallfeedbackfiletypes: "",
    submissiongradepass: "40.00",
    gradinggradepass: "10.00",
    latesubmissions: false,
    useselfassessment: false,
    useexamples: false,
    phaseswitchassessment: false,
    types: { submissiontypetextavailable: true, submissiontypetextrequired: false, submissiontypefileavailable: true, submissiontypefilerequired: false },
    dates: { submissionstart: null, submissionend: null, assessmentstart: null, assessmentend: null },
    cmidnumber: "",
    visible: true,
    phase: 10,
    sectionId: "7",
    instance: "44",
    ...overrides,
  };
}

function settingsBody(state, drafts) {
  return `
      <input name="name" value="${state.name}">
      ${EDITORS.map(([key, field]) => `<textarea name="${field}[text]">${state[key]}</textarea><input type="hidden" name="${field}[format]" value="1"><input type="hidden" name="${field}[itemid]" value="${drafts[field]}">`).join("")}
      ${selectControl("strategy", state.strategy, SELECTS.strategy)}
      ${selectControl("grade", state.grade, SELECTS.grade)}
      ${selectControl("gradinggrade", state.gradinggrade, SELECTS.gradinggrade)}
      ${selectControl("gradedecimals", state.gradedecimals, SELECTS.gradedecimals)}
      <input name="submissiongradepass" value="${state.submissiongradepass}">
      <input name="gradinggradepass" value="${state.gradinggradepass}">
      ${TYPES.map((name) => advCheckbox(name, state.types[name])).join("")}
      ${selectControl("nattachments", state.nattachments, SELECTS.nattachments)}
      <input name="submissionfiletypes" value="${state.submissionfiletypes}">
      ${selectControl("maxbytes", state.maxbytes, SELECTS.maxbytes)}
      ${plainCheckbox("latesubmissions", state.latesubmissions)}
      ${plainCheckbox("useselfassessment", state.useselfassessment)}
      ${selectControl("overallfeedbackmode", state.overallfeedbackmode, SELECTS.overallfeedbackmode)}
      ${selectControl("overallfeedbackfiles", state.overallfeedbackfiles, SELECTS.overallfeedbackfiles)}
      <input name="overallfeedbackfiletypes" value="${state.overallfeedbackfiletypes}">
      ${selectControl("overallfeedbackmaxbytes", state.overallfeedbackmaxbytes, SELECTS.overallfeedbackmaxbytes)}
      ${plainCheckbox("useexamples", state.useexamples)}
      ${selectControl("examplesmode", state.examplesmode, SELECTS.examplesmode)}
      ${DATES.map((field) => dateControls(field, state.dates[field])).join("")}
      ${plainCheckbox("phaseswitchassessment", state.phaseswitchassessment)}
      ${selectControl("groupmode", state.groupmode, SELECTS.groupmode)}
      <input name="cmidnumber" value="${state.cmidnumber}">
      ${selectControl("visible", state.visible ? "1" : "0", SELECTS.visible)}
      <input type="submit" name="submitbutton" value="Save and display">
      <input type="submit" name="submitbutton2" value="Save and return to course">`;
}

function updateForm(state, cmid, drafts) {
  const route = `update=${cmid}&amp;return=0`;
  return `<!doctype html><html><body class="path-course course-2">
    <form method="post" action="/course/modedit.php?${route}">
      <input type="hidden" name="update" value="${cmid}"><input type="hidden" name="course" value="2">
      <input type="hidden" name="modulename" value="workshop"><input type="hidden" name="return" value="0">
      <input type="hidden" name="coursemodule" value="${cmid}"><input type="hidden" name="instance" value="${state.instance}">
      <input type="hidden" name="sr" value="0"><input type="hidden" name="sesskey" value="${SESSION}">
      <input type="hidden" name="_qf__mod_workshop_mod_form" value="1">
      <input type="hidden" name="coursecontentnotification" value="1">
      ${settingsBody(state, drafts)}
    </form>
  </body></html>`;
}

function addForm(state, sectionId, sectionNumber, drafts) {
  const route = `add=workshop&amp;course=2&amp;sectionid=${sectionId}&amp;return=0`;
  return `<!doctype html><html><body class="path-course course-2">
    <form method="post" action="/course/modedit.php?${route}">
      <input type="hidden" name="add" value="workshop"><input type="hidden" name="course" value="2">
      <input type="hidden" name="modulename" value="workshop"><input type="hidden" name="section" value="${sectionNumber}">
      <input type="hidden" name="return" value="0"><input type="hidden" name="sr" value="0">
      <input type="hidden" name="sesskey" value="${SESSION}">
      <input type="hidden" name="_qf__mod_workshop_mod_form" value="1">
      <input type="hidden" name="coursecontentnotification" value="1">
      ${settingsBody(state, drafts)}
    </form>
  </body></html>`;
}

function dateFrom(values, field) {
  if (values.get(`${field}[enabled]`) !== "1") return null;
  return Object.fromEntries(DATE_PARTS.map((part) => [part, values.get(`${field}[${part}]`) || ""]));
}

function stateFromPost(base, values) {
  const next = { ...base, types: { ...base.types }, dates: { ...base.dates } };
  next.name = values.get("name") || "";
  for (const [key, field] of EDITORS) next[key] = values.get(`${field}[text]`) || "";
  for (const name of ["strategy", "grade", "gradinggrade", "gradedecimals", "nattachments", "maxbytes", "overallfeedbackmode", "overallfeedbackfiles", "overallfeedbackmaxbytes", "examplesmode", "groupmode", "submissionfiletypes", "overallfeedbackfiletypes", "cmidnumber"]) {
    next[name] = values.get(name) ?? next[name];
  }
  for (const name of ["latesubmissions", "useselfassessment", "useexamples", "phaseswitchassessment"]) next[name] = values.get(name) === "1";
  for (const name of TYPES) next.types[name] = values.getAll(name).at(-1) === "1";
  for (const field of DATES) next.dates[field] = dateFrom(values, field);
  next.visible = values.get("visible") === "1";
  // Moodle stores an empty pass grade as zero and formats it for the edit form.
  for (const name of ["submissiongradepass", "gradinggradepass"]) {
    const posted = values.get(name);
    next[name] = posted === "" ? "0.00" : posted ?? next[name];
  }
  return next;
}

test("Moodle Workshop executor reads, creates hidden, edits bounded settings, and never touches a phase", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morrow-moodle-workshop-"));
  const key = join(directory, "key.pem");
  const certificate = join(directory, "certificate.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", certificate], { stdio: "ignore" });

  const sections = [{ id: 7, number: 3 }, { id: 8, number: 4 }];
  const workshops = new Map([["99", newState()]]);
  const creationDefaults = newState({
    name: "", intro: "", instructauthors: "", instructreviewers: "", conclusion: "",
    submissiongradepass: "", gradinggradepass: "", visible: true, instance: "",
  });
  const options = { saveUnknown: false, rejectSave: false, driftProtectedOnSave: false, driftOnCreate: false, draftFiles: "empty", overviewBroken: false };
  const drafts = new Map();
  const posts = [];
  const requests = [];
  let nextDraft = 500;
  let nextModule = 130;
  let origin = "";

  const issueDrafts = () => {
    const issued = {};
    for (const [, field] of EDITORS) {
      const item = String(nextDraft);
      nextDraft += 1;
      drafts.set(item, options.draftFiles);
      issued[field] = item;
    }
    return issued;
  };
  const courseState = () => JSON.stringify({
    course: { id: 2, fullname: "Peer assessment course" },
    section: sections.map((entry) => ({ id: entry.id, number: entry.number, title: `Section ${entry.number}` })),
    cm: [...workshops.entries()].map(([cmid, state]) => ({
      id: Number(cmid), module: "workshop", name: state.name, sectionid: Number(state.sectionId), visible: state.visible,
    })),
  });
  const overview = () => ({
    courseid: 2,
    hasintegration: true,
    headers: [{ name: "Name", key: "name", align: "start" }, { name: "Phase", key: "phase", align: "start" }],
    activities: [...workshops.entries()].map(([cmid, state]) => ({
      name: state.name,
      modname: "workshop",
      contextid: 900 + Number(cmid),
      cmid: Number(cmid),
      url: `${origin}/mod/workshop/view.php?id=${cmid}`,
      haserror: false,
      items: [
        { key: "name", name: "Name", contenttype: "text", exportertype: null, alertlabel: null, alertcount: 0, contentjson: JSON.stringify({ value: state.name, datatype: "string", content: state.name }) },
        { key: "phase", name: "Phase", contenttype: "text", exportertype: null, alertlabel: null, alertcount: 0, contentjson: JSON.stringify({ value: state.phase, datatype: "integer", content: "Setup phase" }) },
        { key: "submissions", name: "Submissions", contenttype: "text", exportertype: null, alertlabel: null, alertcount: 0, contentjson: JSON.stringify({ value: 0, datatype: "integer", content: "-" }) },
      ],
    })),
  });

  const server = createServer({ key: readFileSync(key), cert: readFileSync(certificate) }, async (request, response) => {
    const url = new URL(request.url || "/", origin || "https://127.0.0.1");
    requests.push(`${request.method} ${url.pathname}${url.search}`);
    if (url.pathname === "/course/view.php") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end('<!doctype html><html><body class="path-course course-2"><h1>Peer assessment course</h1></body></html>');
      return;
    }
    if (request.method === "GET" && url.pathname === "/course/modedit.php") {
      const cmid = url.searchParams.get("update") || "";
      if (cmid && url.search === `?update=${cmid}&return=0` && workshops.has(cmid)) {
        response.writeHead(200, { "content-type": "text/html" });
        response.end(updateForm(workshops.get(cmid), cmid, issueDrafts()));
        return;
      }
      const sectionId = url.searchParams.get("sectionid") || "";
      const section = sections.find((entry) => String(entry.id) === sectionId);
      if (url.search === `?add=workshop&course=2&sectionid=${sectionId}&return=0` && section) {
        response.writeHead(200, { "content-type": "text/html" });
        response.end(addForm(creationDefaults, sectionId, section.number, issueDrafts()));
        return;
      }
      response.writeHead(404).end();
      return;
    }
    if (request.method === "POST" && url.pathname === "/repository/draftfiles_ajax.php") {
      const values = new URLSearchParams((await readBody(request)).toString("utf8"));
      assert.equal(values.get("sesskey"), SESSION);
      const state = drafts.get(values.get("itemid") || "") || "empty";
      if (state === "broken") {
        response.writeHead(500).end("no");
        return;
      }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(state === "nonempty"
        ? { filecount: 1, list: [{ filename: "brief.pdf", filepath: "/", type: "file", size: 12 }], tree: { children: [] } }
        : { filecount: 0, list: [], tree: { children: [] } }));
      return;
    }
    if (request.method === "POST" && url.pathname === "/lib/ajax/service.php") {
      const info = url.searchParams.get("info") || "";
      assert.equal(url.searchParams.get("sesskey"), SESSION);
      response.setHeader("content-type", "application/json");
      if (info === "core_courseformat_get_state") {
        response.end(JSON.stringify([{ error: false, data: courseState() }]));
        return;
      }
      if (info === "core_courseformat_get_overview_information") {
        if (options.overviewBroken) {
          response.end(JSON.stringify([{ error: true, exception: { message: "no capability" } }]));
          return;
        }
        response.end(JSON.stringify([{ error: false, data: overview() }]));
        return;
      }
      response.writeHead(404).end();
      return;
    }
    if (request.method === "POST" && url.pathname === "/course/modedit.php") {
      const values = new URLSearchParams((await readBody(request)).toString("utf8"));
      posts.push(values);
      if (options.saveUnknown) {
        response.writeHead(500).end("unknown");
        return;
      }
      const cmid = values.get("update") || "";
      if (options.rejectSave) {
        response.writeHead(200, { "content-type": "text/html" });
        response.end(cmid
          ? updateForm(workshops.get(cmid), cmid, issueDrafts())
          : addForm(creationDefaults, values.get("sectionid") || "7", values.get("section") || "3", issueDrafts()));
        return;
      }
      if (cmid && workshops.has(cmid)) {
        const saved = stateFromPost(workshops.get(cmid), values);
        if (options.driftProtectedOnSave) saved.strategy = "rubric";
        workshops.set(cmid, saved);
      } else {
        const created = stateFromPost(creationDefaults, values);
        if (options.driftOnCreate) created.strategy = "rubric";
        created.sectionId = url.searchParams.get("sectionid") || "7";
        created.instance = String(70 + nextModule);
        created.phase = 10;
        workshops.set(String(nextModule), created);
        nextModule += 1;
      }
      response.writeHead(303, { location: "/course/view.php?id=2" });
      response.end();
      return;
    }
    response.writeHead(404).end();
  });

  let browser;
  let context;
  try {
    await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", (error) => error ? reject(error) : resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Workshop test server did not bind");
    origin = `https://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
    context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    await page.goto(`${origin}/course/view.php?id=2`);
    await page.evaluate((wwwroot) => { globalThis.M = { cfg: { wwwroot, sesskey: "synthetic-session", userId: 3, courseId: 2 } }; }, origin);
    const binding = { origin, siteUrl: `${origin}/`, principalId: "3", courseId: "2" };
    const base = { mode: "execute", binding, expiresAt: Date.now() + 120_000 };
    const run = (operation, argumentsValue) => page.evaluate(
      executeMoodleWorkshopInPage,
      JSON.stringify({ ...base, operation, arguments: argumentsValue }),
    );
    const read = (moduleId = 99) => run(workshopRead, { course_id: 2, module_id: moduleId });
    const creationForm = (sectionId = 7) => run(creationRead, { course_id: 2, section_id: sectionId });
    const workshopRoutes = () => requests.filter((entry) => entry.includes("/mod/workshop/"));

    // 1. The settings read returns the exact native values and no secret.
    const prepared = await read();
    assert.equal(prepared.ok, true, JSON.stringify(prepared));
    assert.equal(prepared.data.name, "Peer review of unit one");
    assert.equal(prepared.data.instructions, "<p>Read the brief before you start.</p>");
    assert.equal(prepared.data.submission_instructions, "<p>Submit one file.</p>");
    assert.equal(prepared.data.assessment_instructions, "<p>Give two reasons for each score.</p>");
    assert.equal(prepared.data.strategy, "accumulative");
    assert.equal(prepared.data.grade, "80");
    assert.equal(prepared.data.gradinggrade, "20");
    assert.deepEqual(prepared.data.submission_types, { text_available: true, text_required: false, file_available: true, file_required: false });
    assert.equal(prepared.data.phaseswitchassessment, false);
    assert.equal(prepared.data.submission_start, null);
    assert.equal(prepared.data.visible, true);
    assert.equal(prepared.data.proof.required_capability, "moodle/course:manageactivities");
    assert.equal(prepared.data.proof.phase_change, "not_available");
    assert.equal(JSON.stringify(prepared).includes(SESSION), false);
    assert.equal(JSON.stringify(prepared).includes("500"), false, "no draft item ID may leave the page");

    // A second read of the same unchanged Workshop issues new draft areas and
    // still produces the same digest, so a review digest is stable.
    const again = await read();
    assert.equal(again.snapshot_digest, prepared.snapshot_digest);

    // 2. The phase read states the stored phase and nothing about any learner.
    const phase = await run(phaseRead, { course_id: 2, module_id: 99 });
    assert.equal(phase.ok, true, JSON.stringify(phase));
    assert.deepEqual(Object.keys(phase.data).sort(), ["course_id", "module_id", "name", "phase", "phase_key", "proof"]);
    assert.equal(phase.data.phase, 10);
    assert.equal(phase.data.phase_key, "setup");
    workshops.get("99").phase = 30;
    const assessing = await run(phaseRead, { course_id: 2, module_id: 99 });
    assert.equal(assessing.data.phase, 30);
    assert.equal(assessing.data.phase_key, "assessment");
    workshops.get("99").phase = 10;
    assert.deepEqual(await run(phaseRead, { course_id: 2, module_id: 4242 }),
      { ok: false, sent: false, status: 200, error: "moodle_workshop_phase_unavailable" });
    options.overviewBroken = true;
    assert.deepEqual(await run(phaseRead, { course_id: 2, module_id: 99 }),
      { ok: false, sent: false, status: 200, error: "moodle_workshop_ajax_failed" });
    options.overviewBroken = false;

    // 3. Arguments the catalog does not allow never reach the site.
    assert.deepEqual(await run(workshopUpdate, { course_id: 2, module_id: 99, expected_digest: prepared.snapshot_digest }),
      { ok: false, sent: false, error: "moodle_workshop_arguments_invalid" });
    assert.deepEqual(await run(workshopUpdate, { course_id: 2, module_id: 99, instructions: '<p><img src="@@PLUGINFILE@@/x.png"></p>', expected_digest: prepared.snapshot_digest }),
      { ok: false, sent: false, error: "moodle_workshop_arguments_invalid" });
    assert.deepEqual(await run(workshopUpdate, { course_id: 2, module_id: 99, strategy: "rubric", expected_digest: prepared.snapshot_digest }),
      { ok: false, sent: false, error: "moodle_workshop_arguments_invalid" });
    assert.deepEqual(await run(workshopUpdate, { course_id: 2, module_id: 99, name: "Never saved", expected_digest: "0".repeat(64) }),
      { ok: false, sent: false, status: 200, error: "moodle_expected_digest_mismatch" });
    assert.equal(posts.length, 0);

    // 4. A bounded change: one POST, and every protected control travels unchanged.
    const settings = {
      course_id: 2, module_id: 99,
      name: "Peer review of unit one, revised",
      instructions: "<p>Read the revised brief.</p>",
      submission_start: { year: 2026, month: 10, day: 1, hour: 9, minute: 0 },
      submission_end: { year: 2026, month: 10, day: 8, hour: 17, minute: 0 },
      expected_digest: prepared.snapshot_digest,
    };
    const updated = await run(workshopUpdate, settings);
    assert.equal(updated.ok, true, JSON.stringify(updated));
    assert.equal(updated.verification.status, "verified");
    assert.equal(posts.length, 1);
    assert.equal(posts[0].get("name"), "Peer review of unit one, revised");
    assert.equal(posts[0].get("introeditor[text]"), "<p>Read the revised brief.</p>");
    assert.equal(posts[0].get("submissionstart[enabled]"), "1");
    assert.equal(posts[0].get("submissionstart[year]"), "2026");
    assert.equal(posts[0].get("submissionend[day]"), "8");
    assert.equal(posts[0].get("assessmentstart[enabled]"), null);
    assert.equal(posts[0].get("strategy"), "accumulative");
    assert.equal(posts[0].get("grade"), "80");
    assert.equal(posts[0].get("gradinggrade"), "20");
    assert.deepEqual(posts[0].getAll("submissiontypefileavailable"), ["0", "1"]);
    assert.equal(posts[0].get("instructauthorseditor[text]"), "<p>Submit one file.</p>");
    assert.equal(posts[0].get("visible"), "1");
    assert.equal(posts[0].get("submitbutton2"), "Save and return to course");
    assert.equal(posts[0].get("submitbutton"), null);
    assert.equal(posts[0].get("coursecontentnotification"), null);
    assert.deepEqual(updated.data.submission_start, { year: 2026, month: 10, day: 1, hour: 9, minute: 0 });
    assert.deepEqual(updated.data.submission_end, { year: 2026, month: 10, day: 8, hour: 17, minute: 0 });
    assert.equal(updated.data.assessment_start, null);
    assert.equal(updated.data.strategy, "accumulative");
    assert.ok(updated.data.protected_setting_names.includes("strategy"));
    assert.ok(updated.data.protected_setting_names.includes("grade"));
    assert.equal(updated.data.protected_setting_names.includes("name"), false);
    assert.equal(JSON.stringify(updated).includes(SESSION), false);

    // 5. A protected control the site changes during the save is reported.
    const beforeDrift = await read();
    options.driftProtectedOnSave = true;
    const drifted = await run(workshopUpdate, { course_id: 2, module_id: 99, name: "Drifted workshop", expected_digest: beforeDrift.snapshot_digest });
    options.driftProtectedOnSave = false;
    assert.equal(drifted.ok, false, JSON.stringify(drifted));
    assert.equal(drifted.error, "moodle_write_not_verified");
    assert.deepEqual(drifted.verification, { schema: "morrow.browser-verification.v1", status: "mismatch", reason: "moodle_workshop_readback_mismatch" });
    assert.equal(posts.length, 2);
    // The drift case saved a name and a strategy Morrow refused to confirm. The
    // fixture is put back to the last approved state before the next case.
    workshops.get("99").strategy = "accumulative";
    workshops.get("99").name = "Peer review of unit one, revised";

    // 6. A date change while Moodle's own automatic phase switch is set is
    //    refused, because saving it would schedule a phase change.
    workshops.get("99").phaseswitchassessment = true;
    const withSwitch = await read();
    assert.equal(withSwitch.data.phaseswitchassessment, true);
    assert.deepEqual(await run(workshopUpdate, { course_id: 2, module_id: 99, submission_end: { year: 2026, month: 11, day: 1, hour: 9, minute: 0 }, expected_digest: withSwitch.snapshot_digest }),
      { ok: false, sent: false, status: 200, error: "moodle_workshop_automatic_phase_switch_refused" });
    assert.equal(posts.length, 2);
    // A text change is still allowed while that setting is on.
    const textOnly = await run(workshopUpdate, { course_id: 2, module_id: 99, conclusion: "<p>Thank you for reviewing.</p>", expected_digest: withSwitch.snapshot_digest });
    assert.equal(textOnly.ok, true, JSON.stringify(textOnly));
    assert.equal(textOnly.data.conclusion, "<p>Thank you for reviewing.</p>");
    assert.equal(textOnly.data.phaseswitchassessment, true);
    assert.equal(posts.length, 3);
    workshops.get("99").phaseswitchassessment = false;

    // 7. A native file area that is not empty, and one Morrow cannot verify,
    //    both stop the change before anything is sent.
    options.draftFiles = "nonempty";
    const withFiles = await read();
    assert.deepEqual(await run(workshopUpdate, { course_id: 2, module_id: 99, name: "Never saved", expected_digest: withFiles.snapshot_digest }),
      { ok: false, sent: false, status: 200, error: "moodle_workshop_form_files_refused" });
    options.draftFiles = "broken";
    const unverifiedFiles = await read();
    assert.deepEqual(await run(workshopUpdate, { course_id: 2, module_id: 99, name: "Never saved", expected_digest: unverifiedFiles.snapshot_digest }),
      { ok: false, sent: false, status: 200, error: "moodle_workshop_form_files_unverified" });
    options.draftFiles = "empty";
    assert.equal(posts.length, 3);

    // 8. A lost response and a rejected save are both reported exactly.
    const beforeUnknown = await read();
    options.saveUnknown = true;
    const unknown = await run(workshopUpdate, { course_id: 2, module_id: 99, name: "Unknown outcome", expected_digest: beforeUnknown.snapshot_digest });
    options.saveUnknown = false;
    assert.deepEqual(unknown, {
      ok: false, sent: true, status: 500, outcomeUnknown: true,
      verification: { schema: "morrow.browser-verification.v1", status: "unconfirmed", reason: "moodle_workshop_save_unknown" },
      error: "moodle_workshop_save_unknown",
    });
    assert.equal(posts.length, 4);
    assert.equal(workshops.get("99").name, "Peer review of unit one, revised");

    options.rejectSave = true;
    const rejected = await run(workshopUpdate, { course_id: 2, module_id: 99, name: "Rejected by Moodle", expected_digest: beforeUnknown.snapshot_digest });
    options.rejectSave = false;
    assert.equal(rejected.ok, false, JSON.stringify(rejected));
    assert.equal(rejected.error, "moodle_workshop_save_not_sent");
    assert.deepEqual(rejected.verification, { schema: "morrow.browser-verification.v1", status: "mismatch", reason: "moodle_workshop_save_not_sent" });
    assert.equal(posts.length, 5);
    assert.equal(workshops.get("99").name, "Peer review of unit one, revised");

    // 9. The creation form read, then one hidden create with one POST.
    const creation = await creationForm();
    assert.equal(creation.ok, true, JSON.stringify(creation));
    assert.equal(creation.data.section_id, 7);
    assert.equal(creation.data.name, "");
    assert.equal(creation.data.strategy, "accumulative");
    assert.equal(creation.data.proof.created_visibility, "hidden");
    assert.equal(JSON.stringify(creation).includes(SESSION), false);

    assert.deepEqual(await run(workshopCreate, { course_id: 2, section_id: 7, name: "Never created", expected_digest: "0".repeat(64) }),
      { ok: false, sent: false, status: 200, error: "moodle_expected_digest_mismatch" });
    // A section the course state does not carry stops before the form is opened.
    assert.deepEqual(await run(workshopCreate, { course_id: 2, section_id: 91, name: "Never created", expected_digest: creation.snapshot_digest }),
      { ok: false, sent: false, status: 200, error: "moodle_workshop_section_target_invalid" });
    // A creation form whose editor area already holds a file is refused unsent.
    options.draftFiles = "nonempty";
    const creationWithFiles = await creationForm();
    assert.deepEqual(await run(workshopCreate, { course_id: 2, section_id: 7, name: "Never created", expected_digest: creationWithFiles.snapshot_digest }),
      { ok: false, sent: false, status: 200, error: "moodle_workshop_form_files_refused" });
    options.draftFiles = "empty";
    assert.equal(posts.length, 5);

    const createdBefore = workshops.size;
    const created = await run(workshopCreate, {
      course_id: 2, section_id: 7,
      name: "Peer review of unit two",
      instructions: "<p>Unit two brief.</p>",
      submission_instructions: "<p>Submit one page.</p>",
      submission_end: { year: 2026, month: 12, day: 1, hour: 12, minute: 0 },
      expected_digest: creation.snapshot_digest,
    });
    assert.equal(created.ok, true, JSON.stringify(created));
    assert.equal(created.verification.status, "verified");
    assert.equal(posts.length, 6);
    assert.equal(workshops.size, createdBefore + 1);
    assert.equal(posts[5].get("visible"), "0");
    assert.equal(posts[5].get("add"), "workshop");
    assert.equal(posts[5].get("name"), "Peer review of unit two");
    assert.equal(posts[5].get("strategy"), "accumulative");
    assert.equal(posts[5].get("submitbutton2"), "Save and return to course");
    assert.equal(posts[5].get("submitbutton"), null);
    assert.equal(created.data.module_id, 130);
    assert.equal(created.data.section_id, 7);
    assert.equal(created.data.visible, false);
    assert.equal(created.data.phase, 10);
    assert.equal(created.data.phase_key, "setup");
    assert.equal(created.data.name, "Peer review of unit two");
    assert.equal(created.data.instructions, "<p>Unit two brief.</p>");
    assert.equal(created.data.submission_instructions, "<p>Submit one page.</p>");
    assert.deepEqual(created.data.submission_end, { year: 2026, month: 12, day: 1, hour: 12, minute: 0 });
    assert.equal(created.data.assessment_instructions, "");
    assert.equal(created.data.strategy, "accumulative");
    // Moodle saves an empty pass grade as zero and formats it back; that is the
    // only native default the create readback is allowed to see change.
    assert.equal(created.data.submissiongradepass, "0.00");
    assert.equal(JSON.stringify(created).includes(SESSION), false);

    // A site that does not let this account read the overview leaves the phase
    // unread. The saved form and the course state still verify the create.
    const blindCreation = await creationForm();
    options.overviewBroken = true;
    const blindCreate = await run(workshopCreate, { course_id: 2, section_id: 7, name: "Peer review of unit two b", expected_digest: blindCreation.snapshot_digest });
    options.overviewBroken = false;
    assert.equal(blindCreate.ok, true, JSON.stringify(blindCreate));
    assert.equal(blindCreate.verification.status, "verified");
    assert.equal(blindCreate.data.phase, null);
    assert.equal(blindCreate.data.phase_key, null);
    assert.equal(blindCreate.data.proof.created_phase, "unread");
    assert.equal(blindCreate.data.visible, false);
    assert.equal(posts.length, 7);

    // A native default the site changes while it saves is a mismatch, not a success.
    const driftCreation = await creationForm();
    options.driftOnCreate = true;
    const driftedCreate = await run(workshopCreate, { course_id: 2, section_id: 7, name: "Peer review of unit three", expected_digest: driftCreation.snapshot_digest });
    options.driftOnCreate = false;
    assert.equal(driftedCreate.ok, false, JSON.stringify(driftedCreate));
    assert.equal(driftedCreate.error, "moodle_write_not_verified");
    assert.deepEqual(driftedCreate.verification, { schema: "morrow.browser-verification.v1", status: "mismatch", reason: "moodle_workshop_readback_mismatch" });
    assert.equal(driftedCreate.data.module_id, 132);
    assert.equal(posts.length, 8);

    // A create Moodle refuses is reported as not sent, and creates nothing.
    const nextCreation = await creationForm();
    options.rejectSave = true;
    const notCreated = await run(workshopCreate, { course_id: 2, section_id: 7, name: "Not created", expected_digest: nextCreation.snapshot_digest });
    options.rejectSave = false;
    assert.equal(notCreated.ok, false, JSON.stringify(notCreated));
    assert.equal(notCreated.error, "moodle_workshop_save_not_sent");
    assert.equal(workshops.size, createdBefore + 3);

    // 10. No request in the whole fixture reached a Workshop learner route.
    assert.deepEqual(workshopRoutes(), []);
    assert.equal(requests.some((entry) => entry.includes("switchphase")), false);
  } finally {
    await context?.close();
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
});
