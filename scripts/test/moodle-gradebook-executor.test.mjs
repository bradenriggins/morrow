import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { executeMoodleGradebookInPage } from "../../connector/extension/src/moodle-gradebook-executor.js";

const ANCHOR_SESSION = "moodle-session-a";
const FOREIGN_SESSION = "moodle-session-b";
const LEARNER_NAME = "Ada Lovelace";
const LEARNER_GRADE = "87.5";

const operations = Object.freeze({
  setup: { key: "moodle.form.grade.tree.index.read.v1", toolName: "moodle_get_gradebook_setup", provider: "moodle", readOnly: true },
  categoryRead: { key: "moodle.form.grade.tree.category.read.v1", toolName: "moodle_get_grade_category", provider: "moodle", readOnly: true },
  categoryWrite: { key: "moodle.form.grade.tree.category.write.v1", toolName: "moodle_update_grade_category", provider: "moodle", readOnly: false },
  categorySettingsWrite: { key: "moodle.form.grade.tree.category.settings.write.v1", toolName: "moodle_update_grade_category_settings", provider: "moodle", readOnly: false },
  itemRead: { key: "moodle.form.grade.tree.item.read.v1", toolName: "moodle_get_grade_item", provider: "moodle", readOnly: true },
  itemWrite: { key: "moodle.form.grade.tree.item.write.v1", toolName: "moodle_update_grade_item", provider: "moodle", readOnly: false },
  itemSettingsWrite: { key: "moodle.form.grade.tree.item.settings.write.v1", toolName: "moodle_update_grade_item_settings", provider: "moodle", readOnly: false },
  scales: { key: "moodle.form.grade.scale.index.read.v1", toolName: "moodle_get_grade_scales", provider: "moodle", readOnly: true },
  outcomes: { key: "moodle.form.grade.outcome.index.read.v1", toolName: "moodle_get_grade_outcomes", provider: "moodle", readOnly: true },
  settings: { key: "moodle.form.grade.settings.index.read.v1", toolName: "moodle_get_gradebook_settings", provider: "moodle", readOnly: true },
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

const learnerTable = `<table class="generaltable"><thead><tr><th>Learner</th><th>Grade</th></tr></thead><tbody><tr><td>${LEARNER_NAME}</td><td>${LEARNER_GRADE}</td></tr></tbody></table>`;

/** One option list, rendering the native `selected` marker for the current value. */
function options(entries, current) {
  return entries.map(([value, label]) => `<option value="${value}"${value === current ? " selected" : ""}>${label}</option>`).join("");
}

function categoryForm(state, action, sesskey, categoryId) {
  // Moodle renders the category weight as an advcheckbox override plus a float
  // control, and removes both for the course category and for a parent that
  // does not use natural weighting.
  const weight = state.weightControls === false ? ""
    : `<input type="hidden" name="grade_item_weightoverride" value="0"><input type="checkbox" name="grade_item_weightoverride" value="1"${state.weightOverride === "1" ? " checked" : ""}><input name="grade_item_aggregationcoef2" value="${state.weight}">`;
  return `<!doctype html><html><body><form method="post" action="${action}">
    <input type="hidden" name="id" value="${categoryId}"><input type="hidden" name="courseid" value="2"><input type="hidden" name="sesskey" value="${sesskey}">
    <input name="fullname" value="${state.name}"><select name="aggregation">${options([["10", "Natural"], ["0", "Mean of grades"], ["2", "Median of grades"]], state.aggregation)}</select><input name="aggregateonlygraded" value="${state.aggregateOnlyGraded}">
    <input name="keephigh" value="0"><input name="droplow" value="${state.dropLow}"><input name="grade_item_itemname" value="Assessments total"><input name="grade_item_iteminfo" value="configuration only">
    <input name="grade_item_gradetype" value="1"><input name="grade_item_grademax" value="${state.max}"><input name="grade_item_grademin" value="0"><input name="grade_item_gradepass" value="50">
    <select name="grade_item_display"><option value="-1" selected>Default (Real)</option><option value="2">Percentage</option></select>
    <select name="grade_item_decimals"><option value="-1" selected>Default (2)</option><option value="1">1</option></select>
    <input name="grade_item_hidden" value="0"><input name="grade_item_locked" value="0">${weight}
    <input name="grade_item_parentcategory" value="1"><input name="grade_item_rescalegrades" value="">
    <input type="submit" name="submitbutton" value="Save changes">
  </form>${learnerTable}</body></html>`;
}

function dateControls(field, state, malformed = false) {
  const toggle = `<input type="checkbox" name="${field}[enabled]" value="1"${state.enabled ? " checked" : ""}>`;
  const duplicate = malformed && field === "hiddenuntil" ? `<input type="checkbox" name="${field}[enabled]" value="1">` : "";
  const selects = ["year", "month", "day", "hour", "minute"].map((part) => `<select name="${field}[${part}]"><option value="${state[part]}" selected>${state[part]}</option></select>`).join("");
  return `${toggle}${duplicate}${selects}`;
}

function itemForm(state, action, sesskey) {
  // Moodle offers the rescale control only for an item that already has
  // grades, and never for a scale item.
  const rescale = state.hasGrades && state.gradeType !== "2"
    ? `<select name="rescalegrades">${options([["", "Choose"], ["no", "No"], ["yes", "Yes"]], "")}</select>`
    : "";
  const grade = (value) => value.toFixed(5).replace(".", state.separator);
  return `<!doctype html><html><body><form method="post" action="${action}">
    <input type="hidden" name="id" value="200"><input type="hidden" name="courseid" value="2"><input type="hidden" name="itemtype" value="${state.itemType}"><input type="hidden" name="sesskey" value="${sesskey}">
    <input name="itemname" value="${state.name}"><input name="iteminfo" value="configuration only"><input name="idnumber" value="score-200"><select name="gradetype">${options([["1", "Value"], ["0", "None"], ["2", "Scale"], ["3", "Text"]], state.gradeType)}</select>
    <input name="scaleid" value="0">${rescale}<input name="grademax" value="${grade(state.max)}"><input name="grademin" value="${grade(state.min)}"><input name="gradepass" value="50">
    <input name="multfactor" value="1.00000"><input name="plusfactor" value="0.00000">
    <select name="display">${options([["-1", "Default (Real)"], ["2", "Percentage"]], state.display)}</select>
    <select name="decimals">${options([["-1", "Default (2)"], ["1", "1"]], state.decimals)}</select>
    <input name="hidden" value="0"><input name="locked" value="0"><select name="parentcategory">${options([["1", "Course root"], ["100", "Assessments"]], state.parent)}</select><input name="weightoverride" value="0"><input name="aggregationcoef2" value="0">
    ${dateControls("hiddenuntil", state.hiddenUntil, state.malformedDateToggle)}${dateControls("locktime", state.lockTime)}
    <input type="submit" name="submitbutton" value="Save changes">
  </form>${learnerTable}</body></html>`;
}

function setupPage(origin, view = "complete") {
  if (view === "shell") return `<!doctype html><html><body class="path-course course-2"><h1>Gradebook setup</h1><button>Add grade item</button></body></html>`;
  const categoryControl = (targetId, courseId = "2") => `<a href="#" class="dropdown-item" data-trigger="add-category-form" data-courseid="${courseId}" data-category="${targetId}">Edit category</a>`;
  const itemControl = (targetId, courseId = "2") => `<a href="#" class="dropdown-item" data-trigger="add-item-form" data-courseid="${courseId}" data-itemid="${targetId}">Edit grade item</a>`;
  const menuButton = (kind, targetId) => `<button class="cellmenubtn" data-type="${kind}" data-id="${targetId}"></button>`;
  const categoryRow = (targetId, name, courseId, extra = "", controlTargetId = targetId) => `<tr class="category" data-category="category-${targetId}"><td class="column-name"><div class="rowtitle">${name}</div></td><td>${menuButton("category", targetId)}${categoryControl(controlTargetId, courseId)}${extra}</td></tr>`;
  const itemRow = (targetId, name, courseId, controlTargetId = targetId) => `<tr class="item" data-itemid="${targetId}"><td class="column-name"><div class="rowtitle">${name}</div></td><td>${menuButton("item", targetId)}${itemControl(controlTargetId, courseId)}</td></tr>`;
  const rootControl = view === "missing-control" ? "" : categoryControl(view === "invalid-target" ? "0" : "1", view === "wrong-course" ? "9" : "2");
  const rootRow = (classes, control = rootControl) => `<tr class="${classes}" data-category="category-1"><td class="column-name"><div class="rowtitle">Course root</div></td><td>${menuButton("category", "1")}${control}</td></tr>`;
  const rootRows = view === "root-row-missing" ? rootRow("category")
    : view === "root-row-duplicate" ? `${rootRow("coursecategory category")}${rootRow("coursecategory category")}`
      : view === "root-row-mismatched" ? rootRow("coursecategory category", categoryControl("999"))
        : rootRow("coursecategory category");
  const rows = view === "partial"
    ? `<tr class="coursecategory category" data-category="category-1"><td class="column-name"><div class="rowtitle">Course root</div></td><td>${menuButton("category", "1")}${categoryControl("1")}</td></tr>`
    : `${rootRows}<tr class="courseitem item" data-itemid="300"><td class="column-name"><div class="rowtitle">Course total</div></td><td>${menuButton("item", "300")}${itemControl("300")}</td></tr>${view === "empty" ? "" : `${categoryRow("100", "Assessments", undefined, view === "duplicate" ? categoryControl("100") : "", view === "swapped" ? "999" : undefined)}${itemRow("200", "Practice score", undefined, view === "item-swapped" ? "999" : undefined)}${itemRow("201", "External grade item")}`}`;
  return `<!doctype html><html><body class="path-course course-2"><form id="gradetreeform"><div class="gradetree-wrapper d-none"><table id="grade_edit_tree_table" class="setup-grades"><tbody>${rows}</tbody></table></div></form><table><tr><td>Student name</td><td>96</td></tr></table></body></html>`;
}

function scalesPage(view, sesskey) {
  const editLink = (scaleId, courseId = "2") => `<a href="edit.php?courseid=${courseId}&amp;id=${scaleId}" class="action-icon"><i class="icon fa fa-gear"></i><span class="visually-hidden">Edit</span></a>`;
  const deleteLink = (scaleId) => `<a href="index.php?id=2&amp;scaleid=${scaleId}&amp;action=delete&amp;sesskey=${sesskey}" class="action-icon"><i class="icon fa fa-trash"></i></a>`;
  const row = (name, options, controls, extraCell = "") => `<tr class="lastrow"><td class="cell c0">${name}<div class="scale_options">${options}</div></td><td class="cell c1">Yes</td><td class="cell c2">${controls}</td>${extraCell}</tr>`;
  const used = view === "foreign-course" ? row("Mastery scale", "Not yet,Developing,Secure", editLink("41", "9"))
    : view === "text-control" ? row("Mastery scale", "Not yet,Developing,Secure", `${editLink("41")} 2 grade items`)
      : view === "wide-row" ? row("Mastery scale", "Not yet,Developing,Secure", editLink("41"), '<td class="cell c3">extra</td>')
        : row("Mastery scale", "Not yet,Developing,Secure", editLink("41"));
  const unused = view === "delete-only" ? row("Draft rubric scale", "Low,High", deleteLink("42"))
    : row("Draft rubric scale", "Low,High", `${editLink("42")}${deleteLink("42")}`);
  const custom = `<h3 class="main mt-3">Custom scales</h3><table class="scaletable globalscales table generaltable table-hover"><thead><tr><th class="header c0">Scale</th><th class="header c1">Used</th><th class="header c2">Edit</th></tr></thead><tbody>${used}${unused}</tbody></table>`;
  const standard = `<h3 class="main  mt-3">Standard scales</h3><table class="generaltable"><thead><tr><th>Scale</th><th>Used</th><th>Edit</th></tr></thead><tbody>${row("Separate and Connected ways of knowing", "Mostly separate knowing,Separate and connected,Mostly connected knowing", "")}</tbody></table>`;
  const tables = view === "site-only" ? standard : `${custom}${standard}`;
  return `<!doctype html><html><body class="path-course course-2">${tables}${learnerTable}</body></html>`;
}

function outcomesPage(view, sesskey) {
  const editLink = (outcomeId, courseId = "2") => `<a href="edit.php?courseid=${courseId}&amp;id=${outcomeId}" class="action-icon"><i class="icon fa fa-gear"></i></a>`;
  const deleteLink = (outcomeId) => `<a href="index.php?id=2&amp;outcomeid=${outcomeId}&amp;action=delete&amp;sesskey=${sesskey}" class="action-icon"><i class="icon fa fa-trash"></i><span class="visually-hidden">Delete</span></a>`;
  const scaleLink = '<a href="/grade/edit/scale/edit.php?courseid=2&amp;id=41&amp;gpr_type=edit&amp;gpr_plugin=outcome">Mastery scale</a>';
  const courseRow = (name, shortName, uses, controls) => `<tr><td>${name}</td><td>${shortName}</td><td>${scaleLink}</td><td>${uses}</td><td>${controls}</td></tr>`;
  const siteRow = (name, shortName, courses, items, controls) => `<tr><td>${name}</td><td>${shortName}</td><td>Separate and Connected ways of knowing</td><td>${courses}</td><td>${items}</td><td>${controls}</td></tr>`;
  const courseControls = view === "foreign-course" ? editLink("11", "9") : `${editLink("11")}${deleteLink("11")}`;
  const courseTable = `<h3 class="main mt-3">Custom outcomes</h3><table class="generaltable"><thead><tr><th>Full name</th><th>Short name</th><th>Scale</th><th>Items</th><th>Edit</th></tr></thead><tbody>${courseRow("Clinical reasoning", "CR1", "3", courseControls)}${courseRow("Patient communication", "PC1", "0", `${editLink("12")}${deleteLink("12")}`)}</tbody></table>`;
  const siteTable = `<h3 class="main mt-3">Standard outcomes</h3><table class="generaltable"><thead><tr><th>Full name</th><th>Short name</th><th>Scale</th><th>Courses</th><th>Items</th><th>Edit</th></tr></thead><tbody>${siteRow("Written communication", "WC", "4", "7", "")}</tbody></table>`;
  const learnerRow = `<table class="generaltable"><thead><tr><th>Learner</th><th>Email</th><th>Outcome</th><th>Attempts</th><th>Items</th><th>Result</th></tr></thead><tbody><tr><td>${LEARNER_NAME}</td><td>ada@example.edu</td><td>Clinical reasoning</td><td>2</td><td>3</td><td>${LEARNER_GRADE}</td></tr></tbody></table>`;
  const tables = view === "none" ? '<div class="alert alert-info" role="alert">There are no outcomes.</div>'
    : view === "duplicate" ? `${courseTable}${courseTable}`
      : `${courseTable}${siteTable}`;
  return `<!doctype html><html><body class="path-course course-2">${tables}${learnerRow}</body></html>`;
}

function settingsPage(state, sesskey) {
  const menu = (name, options) => `<select name="${name}">${options.map(([value, label, selected]) => `<option value="${value}"${selected ? " selected" : ""}>${label}</option>`).join("")}</select>`;
  const controls = [
    menu("aggregationposition", [["-1", "Default (Last)", true], ["0", "First", false]]),
    state.missingMinMax ? "" : menu("minmaxtouse", [["-1", "Default (Initial minimum and maximum grades)", false], ["1", "Initial minimum and maximum grades", true]]),
    menu("displaytype", [["-1", `Default (${state.displayDefault})`, true], ["2", "Percentage", false]]),
    menu("decimalpoints", [["-1", "Default (2)", false], ["1", "1", true]]),
    menu("report_grader_studentsperpage", [["-1", "Default (20)", true], ["50", "50", false]]),
    '<input name="report_user_showrank" value="0">',
    '<input name="export_xls_export_feedback" value="0">',
    '<input name="import_csv_separator" value="comma">',
  ].join("");
  return `<!doctype html><html><body class="path-course course-2">
    <form method="post" action="/grade/edit/settings/index.php" id="course_settings_form">
      <input type="hidden" name="sesskey" value="${sesskey}"><input type="hidden" name="_qf__course_settings_form" value="1">
      <input type="hidden" name="mform_isexpanded_id_grade_item_settings" value="1">
      ${controls}
      <input type="hidden" name="id" value="${state.courseId}">
      <input type="submit" name="submitbutton" value="Save changes">
    </form>${learnerTable}</body></html>`;
}

function readBody(request) {
  return new Promise((resolve) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

test("Moodle gradebook executor keeps an anchor course separate from an exact selected-course gradebook target", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morrow-moodle-gradebook-"));
  const key = join(directory, "key.pem");
  const certificate = join(directory, "certificate.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", certificate], { stdio: "ignore" });
  const categoryState = (name) => ({ name, aggregateOnlyGraded: "1", max: "100", aggregation: "10", dropLow: "0", weight: "0.00000", weightOverride: "0", weightControls: true });
  const state = {
    rootCategory: categoryState(""),
    category: categoryState("Assessments"),
    item: {
      name: "Practice score", itemType: "manual", max: 100, min: 0, malformedDateToggle: false,
      gradeType: "1", display: "-1", decimals: "1", parent: "1", hasGrades: true, separator: ".",
      hiddenUntil: { enabled: false, year: "2026", month: "9", day: "6", hour: "8", minute: "20" },
      lockTime: { enabled: false, year: "2026", month: "9", day: "6", hour: "8", minute: "20" },
    },
    savedItemMaximumOverride: null,
    categorySessionQueue: [],
    categorySession: ANCHOR_SESSION,
    itemSession: ANCHOR_SESSION,
    savedCategoryNameOverride: "",
    externalAction: false,
    queryAction: false,
    wrongIdentity: false,
    setupView: "complete",
    scalesView: "complete",
    outcomesView: "complete",
    settings: { courseId: "2", displayDefault: "Real", missingMinMax: false, session: ANCHOR_SESSION },
  };
  const posts = [];
  let origin = "";
  const server = createServer({ key: readFileSync(key), cert: readFileSync(certificate) }, async (request, response) => {
    const url = new URL(request.url || "/", origin || "https://127.0.0.1");
    if (url.pathname === "/course/view.php") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<!doctype html><body class="path-course course-1"><script>var M = {}; M.cfg = ${JSON.stringify({ wwwroot: origin, sesskey: ANCHOR_SESSION, userId: 3, courseId: 1 })};</script></body>`);
      return;
    }
    if (request.method === "GET" && url.pathname === "/grade/edit/tree/index.php" && url.search === "?id=2") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(setupPage(origin, state.setupView));
      return;
    }
    if (request.method === "GET" && url.pathname === "/grade/edit/scale/index.php" && url.search === "?id=2") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(scalesPage(state.scalesView, ANCHOR_SESSION));
      return;
    }
    if (request.method === "GET" && url.pathname === "/grade/edit/outcome/index.php" && url.search === "?id=2") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(outcomesPage(state.outcomesView, ANCHOR_SESSION));
      return;
    }
    if (request.method === "GET" && url.pathname === "/grade/edit/settings/index.php" && url.search === "?id=2") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(settingsPage(state.settings, state.settings.session));
      return;
    }
    const categoryPath = "/grade/edit/tree/category.php";
    const itemPath = "/grade/edit/tree/item.php";
    if (request.method === "GET" && url.pathname === categoryPath && url.searchParams.get("courseid") === "2" && ["1", "100"].includes(url.searchParams.get("id") || "")
      && url.searchParams.getAll("courseid").length === 1 && url.searchParams.getAll("id").length === 1) {
      const categoryId = url.searchParams.get("id");
      const action = state.externalAction ? "https://outside.example/grade/edit/tree/category.php"
        : state.queryAction ? `${categoryPath}?courseid=2&id=100` : categoryPath;
      const sesskey = state.categorySessionQueue.shift() || state.categorySession;
      const category = categoryId === "1" ? state.rootCategory : state.category;
      const html = categoryForm(category, action, sesskey, categoryId).replace(`name="id" value="${categoryId}"`, `name="id" value="${state.wrongIdentity && categoryId === "100" ? "999" : categoryId}"`);
      response.writeHead(200, { "content-type": "text/html" });
      response.end(html);
      return;
    }
    if (request.method === "GET" && url.pathname === itemPath && url.search === "?courseid=2&id=200") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(itemForm(state.item, itemPath, state.itemSession));
      return;
    }
    if (request.method === "POST" && !url.search && [categoryPath, itemPath].includes(url.pathname)) {
      const values = new URLSearchParams(await readBody(request));
      posts.push({ path: url.pathname, query: url.search, values });
      assert.equal(values.get("sesskey"), ANCHOR_SESSION);
      assert.equal(values.get("submitbutton"), "Save changes");
      const last = (name, fallback) => (values.getAll(name).length ? values.getAll(name)[values.getAll(name).length - 1] : fallback);
      if (url.pathname === categoryPath) {
        const category = values.get("id") === "1" ? state.rootCategory : state.category;
        category.name = state.savedCategoryNameOverride || values.get("fullname") || "";
        category.aggregation = last("aggregation", category.aggregation);
        category.dropLow = last("droplow", category.dropLow);
        // Moodle's advcheckbox posts a hidden zero before the checked box, and
        // PHP keeps the last value it receives.
        category.weightOverride = last("grade_item_weightoverride", category.weightOverride);
        category.weight = last("grade_item_aggregationcoef2", category.weight);
      }
      else {
        const number = (name, fallback) => {
          const raw = values.get(name);
          return raw === null || !/^-?[0-9]+(?:[.,][0-9]+)?$/.test(raw) ? fallback : Number(raw.replace(",", "."));
        };
        state.item.name = values.get("itemname") || "";
        state.item.gradeType = last("gradetype", state.item.gradeType);
        state.item.max = state.savedItemMaximumOverride ?? number("grademax", state.item.max);
        state.item.min = number("grademin", state.item.min);
        state.item.display = last("display", state.item.display);
        state.item.decimals = last("decimals", state.item.decimals);
        state.item.parent = last("parentcategory", state.item.parent);
      }
      response.writeHead(303, { location: "/grade/edit/tree/index.php?id=2" });
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
    if (!address || typeof address === "string") throw new Error("gradebook test server did not bind");
    origin = `https://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
    context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    await page.goto(`${origin}/course/view.php?id=2`);
    const binding = { origin, siteUrl: `${origin}/`, principalId: "3", courseId: "2" };
    await page.evaluate(() => { delete globalThis.M.cfg.courseId; });
    const execute = (operation, argumentsValue) => page.evaluate(executeMoodleGradebookInPage, JSON.stringify({ mode: "execute", operation, arguments: argumentsValue, binding, expiresAt: Date.now() + 60_000 }));
    const loseNextCategoryPostResponse = () => page.evaluate(() => {
      const nativeFetch = globalThis.fetch;
      globalThis.fetch = async (...parameters) => {
        const response = await nativeFetch(...parameters);
        const request = new URL(parameters[0], globalThis.location.href);
        if (String(parameters[1]?.method || "GET").toUpperCase() === "POST" && request.pathname === "/grade/edit/tree/category.php") {
          globalThis.fetch = nativeFetch;
          throw new TypeError("post response lost after dispatch");
        }
        return response;
      };
    });

    state.categorySessionQueue.push(FOREIGN_SESSION);
    assert.deepEqual(await execute(operations.categoryRead, { course_id: 2, category_id: 100 }), { ok: false, sent: false, status: 200, error: "moodle_form_session_mismatch" });
    assert.equal(posts.length, 0);

    const setup = await execute(operations.setup, { course_id: 2 });
    assert.deepEqual(setup.data, {
      course_id: "2",
      categories: [{ id: "1", name: "Course root" }, { id: "100", name: "Assessments" }],
      grade_item_links: [{ id: "200", name: "Practice score" }, { id: "201", name: "External grade item" }],
      proof: { method: "native_page_read", route: "/grade/edit/tree/index.php", required_capability: "moodle/grade:manage", scope: "gradebook_configuration_only" },
    });
    assert.equal(JSON.stringify(setup).includes("Student name"), false);

    const rootCategory = await execute(operations.categoryRead, { course_id: 2, category_id: 1 });
    assert.equal(rootCategory.ok, true, JSON.stringify(rootCategory));
    assert.equal(rootCategory.data.fullname, "");
    const postsBeforeRootProofRefusals = posts.length;
    for (const view of ["root-row-missing", "root-row-duplicate", "root-row-mismatched"]) {
      state.setupView = view;
      assert.deepEqual(await execute(operations.categoryRead, { course_id: 2, category_id: 1 }), { ok: false, sent: false, status: 200, error: "moodle_gradebook_setup_incomplete" });
    }
    assert.equal(posts.length, postsBeforeRootProofRefusals);
    state.setupView = "complete";
    const changedRootCategory = await execute(operations.categoryWrite, { course_id: 2, category_id: 1, fullname: "Renamed course gradebook", expected_digest: rootCategory.snapshot_digest });
    assert.equal(changedRootCategory.ok, true, JSON.stringify(changedRootCategory));
    assert.equal(changedRootCategory.verification.status, "verified");
    assert.equal(posts.length, 1);
    assert.equal(posts[0].values.get("id"), "1");
    assert.equal(posts[0].values.get("fullname"), "Renamed course gradebook");
    assert.equal(posts[0].values.get("aggregateonlygraded"), "1");
    assert.equal(posts[0].values.get("grade_item_grademax"), "100");

    state.setupView = "shell";
    assert.deepEqual(await execute(operations.setup, { course_id: 2 }), { ok: false, sent: false, status: 200, error: "moodle_gradebook_setup_incomplete" });
    assert.equal((await execute(operations.categoryRead, { course_id: 2, category_id: 100 })).data.fullname, "Assessments");
    state.setupView = "partial";
    assert.deepEqual(await execute(operations.setup, { course_id: 2 }), { ok: false, sent: false, status: 200, error: "moodle_gradebook_setup_incomplete" });
    state.setupView = "empty";
    const emptySetup = await execute(operations.setup, { course_id: 2 });
    assert.deepEqual({ ...emptySetup.data, proof: undefined }, { course_id: "2", categories: [{ id: "1", name: "Course root" }], grade_item_links: [], proof: undefined });
    state.setupView = "wrong-course";
    assert.deepEqual(await execute(operations.setup, { course_id: 2 }), { ok: false, sent: false, status: 200, error: "moodle_gradebook_setup_incomplete" });
    state.setupView = "missing-control";
    assert.deepEqual(await execute(operations.setup, { course_id: 2 }), { ok: false, sent: false, status: 200, error: "moodle_gradebook_setup_incomplete" });
    state.setupView = "invalid-target";
    assert.deepEqual(await execute(operations.setup, { course_id: 2 }), { ok: false, sent: false, status: 200, error: "moodle_gradebook_setup_incomplete" });
    state.setupView = "duplicate";
    assert.deepEqual(await execute(operations.setup, { course_id: 2 }), { ok: false, sent: false, status: 200, error: "moodle_gradebook_setup_incomplete" });
    state.setupView = "swapped";
    assert.deepEqual(await execute(operations.setup, { course_id: 2 }), { ok: false, sent: false, status: 200, error: "moodle_gradebook_setup_incomplete" });
    state.setupView = "item-swapped";
    assert.deepEqual(await execute(operations.setup, { course_id: 2 }), { ok: false, sent: false, status: 200, error: "moodle_gradebook_setup_incomplete" });
    state.setupView = "complete";

    const category = await execute(operations.categoryRead, { course_id: 2, category_id: 100 });
    assert.equal(category.ok, true, JSON.stringify(category));
    assert.equal(category.data.fullname, "Assessments");
    assert.equal(JSON.stringify(category).includes(ANCHOR_SESSION), false);
    const changedCategory = await execute(operations.categoryWrite, { course_id: 2, category_id: 100, fullname: "Reviewed assessments", expected_digest: category.snapshot_digest });
    assert.equal(changedCategory.ok, true, JSON.stringify(changedCategory));
    assert.equal(changedCategory.verification.status, "verified");
    assert.equal(posts.length, 2);
    assert.equal(posts[1].query, "");
    assert.equal(posts[1].values.get("aggregateonlygraded"), "1");
    assert.equal(posts[1].values.get("grade_item_grademax"), "100");
    assert.deepEqual(await execute(operations.categoryWrite, { course_id: 2, category_id: 100, fullname: "Must not save", grademax: 200, expected_digest: changedCategory.snapshot_digest }), { ok: false, sent: false, error: "moodle_gradebook_arguments_invalid" });

    const item = await execute(operations.itemRead, { course_id: 2, grade_item_id: 200 });
    assert.equal(item.ok, true, JSON.stringify(item));
    assert.deepEqual(Object.keys(item.data).sort(), ["course_id", "grade_item_id", "item_name", "item_type", "proof", "protected_setting_names", "protected_settings", "protected_settings_digest"]);
    assert.deepEqual(item.data.proof, { method: "native_page_read", route: "/grade/edit/tree/item.php", required_capability: "moodle/grade:manage", scope: "gradebook_configuration_only" });

    // Every protected setting the native item form exposes is returned with its
    // value, and those exact pairs are the preimage of the protected digest.
    assert.deepEqual(item.data.protected_settings, [
      { name: "id", value: "200" }, { name: "courseid", value: "2" }, { name: "itemtype", value: "manual" },
      { name: "iteminfo", value: "configuration only" }, { name: "idnumber", value: "score-200" }, { name: "gradetype", value: "1" },
      { name: "scaleid", value: "0" }, { name: "rescalegrades", value: "" }, { name: "grademax", value: "100.00000" },
      { name: "grademin", value: "0.00000" }, { name: "gradepass", value: "50" }, { name: "multfactor", value: "1.00000" },
      { name: "plusfactor", value: "0.00000" }, { name: "display", value: "-1" }, { name: "decimals", value: "1" },
      { name: "hidden", value: "0" }, { name: "locked", value: "0" }, { name: "parentcategory", value: "1" },
      { name: "weightoverride", value: "0" }, { name: "aggregationcoef2", value: "0" },
      { name: "hiddenuntil[enabled]", value: "0" }, { name: "locktime[enabled]", value: "0" },
    ]);
    assert.deepEqual(item.data.protected_setting_names, [...new Set(item.data.protected_settings.map((entry) => entry.name))].sort());
    assert.equal(
      digestOf({ kind: "item", courseId: "2", targetId: "200", entries: item.data.protected_settings.map((entry) => [entry.name, entry.value]) }),
      item.data.protected_settings_digest,
    );
    for (const forbidden of [ANCHOR_SESSION, LEARNER_NAME, LEARNER_GRADE]) {
      assert.equal(JSON.stringify(item).includes(forbidden), false, forbidden);
    }

    const categorySettings = await execute(operations.categoryRead, { course_id: 2, category_id: 100 });
    assert.deepEqual(categorySettings.data.protected_settings.filter((entry) => ["aggregation", "keephigh", "droplow", "grade_item_display", "grade_item_decimals", "grade_item_hidden", "grade_item_locked", "grade_item_weightoverride", "grade_item_aggregationcoef2", "grade_item_grademax", "grade_item_itemname"].includes(entry.name)), [
      { name: "aggregation", value: "10" }, { name: "keephigh", value: "0" }, { name: "droplow", value: "0" },
      { name: "grade_item_itemname", value: "Assessments total" }, { name: "grade_item_grademax", value: "100" },
      { name: "grade_item_display", value: "-1" }, { name: "grade_item_decimals", value: "-1" },
      { name: "grade_item_hidden", value: "0" }, { name: "grade_item_locked", value: "0" },
      { name: "grade_item_weightoverride", value: "0" }, { name: "grade_item_aggregationcoef2", value: "0.00000" },
    ]);
    assert.equal(
      digestOf({ kind: "category", courseId: "2", targetId: "100", entries: categorySettings.data.protected_settings.map((entry) => [entry.name, entry.value]) }),
      categorySettings.data.protected_settings_digest,
    );

    // The remaining configuration pages of the same course, read while the open
    // tab stays anchored to course 1.
    const postsBeforeConfigurationReads = posts.length;
    const scales = await execute(operations.scales, { course_id: 2 });
    assert.equal(scales.ok, true, JSON.stringify(scales));
    assert.deepEqual(scales.data, {
      course_id: "2",
      scales: [
        { scale_id: "41", name: "Mastery scale", options: ["Not yet", "Developing", "Secure"], in_use: true },
        { scale_id: "42", name: "Draft rubric scale", options: ["Low", "High"], in_use: false },
      ],
      listed_scales: [{ name: "Separate and Connected ways of knowing", options: ["Mostly separate knowing", "Separate and connected", "Mostly connected knowing"] }],
      proof: { method: "native_page_read", route: "/grade/edit/scale/index.php", required_capability: "moodle/course:managescales", scope: "gradebook_configuration_only" },
    });
    assert.equal(scales.snapshot_digest, digestOf(scales.data));
    for (const forbidden of [ANCHOR_SESSION, LEARNER_NAME, LEARNER_GRADE]) {
      assert.equal(JSON.stringify(scales).includes(forbidden), false, forbidden);
    }
    for (const view of ["foreign-course", "delete-only", "text-control", "wide-row"]) {
      state.scalesView = view;
      assert.deepEqual(await execute(operations.scales, { course_id: 2 }), { ok: false, sent: false, status: 200, error: "moodle_gradebook_scales_incomplete" }, view);
    }
    state.scalesView = "site-only";
    const siteScales = await execute(operations.scales, { course_id: 2 });
    assert.deepEqual(siteScales.data.scales, []);
    assert.equal(siteScales.data.listed_scales.length, 1);
    state.scalesView = "complete";

    const outcomes = await execute(operations.outcomes, { course_id: 2 });
    assert.equal(outcomes.ok, true, JSON.stringify(outcomes));
    assert.deepEqual(outcomes.data, {
      course_id: "2",
      course_outcomes: [
        { outcome_id: "11", full_name: "Clinical reasoning", short_name: "CR1", scale_name: "Mastery scale", item_uses: 3 },
        { outcome_id: "12", full_name: "Patient communication", short_name: "PC1", scale_name: "Mastery scale", item_uses: 0 },
      ],
      site_outcomes: [{ full_name: "Written communication", short_name: "WC", scale_name: "Separate and Connected ways of knowing", course_uses: 4, item_uses: 7 }],
      proof: { method: "native_page_read", route: "/grade/edit/outcome/index.php", required_capability: "moodle/grade:manageoutcomes", scope: "gradebook_configuration_only" },
    });
    assert.equal(outcomes.snapshot_digest, digestOf(outcomes.data));
    for (const forbidden of [ANCHOR_SESSION, LEARNER_NAME, LEARNER_GRADE, "ada@example.edu"]) {
      assert.equal(JSON.stringify(outcomes).includes(forbidden), false, forbidden);
    }
    for (const view of ["foreign-course", "duplicate"]) {
      state.outcomesView = view;
      assert.deepEqual(await execute(operations.outcomes, { course_id: 2 }), { ok: false, sent: false, status: 200, error: "moodle_gradebook_outcomes_incomplete" }, view);
    }
    state.outcomesView = "none";
    assert.deepEqual((await execute(operations.outcomes, { course_id: 2 })).data.course_outcomes, []);
    assert.deepEqual((await execute(operations.outcomes, { course_id: 2 })).data.site_outcomes, []);
    state.outcomesView = "complete";

    const settings = await execute(operations.settings, { course_id: 2 });
    assert.equal(settings.ok, true, JSON.stringify(settings));
    assert.deepEqual(settings.data.settings, [
      { name: "aggregationposition", value: "-1" },
      { name: "minmaxtouse", value: "1" },
      { name: "displaytype", value: "-1" },
      { name: "decimalpoints", value: "1" },
      { name: "report_grader_studentsperpage", value: "-1" },
      { name: "report_user_showrank", value: "0" },
      { name: "export_xls_export_feedback", value: "0" },
      { name: "import_csv_separator", value: "comma" },
    ]);
    assert.deepEqual(settings.data.selected_option_labels, [
      { name: "aggregationposition", label: "Default (Last)" },
      { name: "minmaxtouse", label: "Initial minimum and maximum grades" },
      { name: "displaytype", label: "Default (Real)" },
      { name: "decimalpoints", label: "1" },
      { name: "report_grader_studentsperpage", label: "Default (20)" },
    ]);
    assert.deepEqual(settings.data.proof, { method: "native_page_read", route: "/grade/edit/settings/index.php", required_capability: "moodle/grade:manage", scope: "gradebook_configuration_only" });
    assert.equal(settings.snapshot_digest, digestOf(settings.data));
    for (const forbidden of [ANCHOR_SESSION, LEARNER_NAME, LEARNER_GRADE, "_qf__course_settings_form", "mform_isexpanded"]) {
      assert.equal(JSON.stringify(settings).includes(forbidden), false, forbidden);
    }
    state.settings.displayDefault = "Percentage";
    const changedDefault = await execute(operations.settings, { course_id: 2 });
    assert.notEqual(changedDefault.snapshot_digest, settings.snapshot_digest);
    assert.deepEqual(changedDefault.data.settings, settings.data.settings);
    assert.equal(changedDefault.data.selected_option_labels.find((entry) => entry.name === "displaytype").label, "Default (Percentage)");
    state.settings.displayDefault = "Real";
    state.settings.courseId = "3";
    assert.deepEqual(await execute(operations.settings, { course_id: 2 }), { ok: false, sent: false, status: 200, error: "moodle_gradebook_form_invalid" });
    state.settings.courseId = "2";
    state.settings.missingMinMax = true;
    assert.deepEqual(await execute(operations.settings, { course_id: 2 }), { ok: false, sent: false, status: 200, error: "moodle_gradebook_form_invalid" });
    state.settings.missingMinMax = false;
    state.settings.session = FOREIGN_SESSION;
    assert.deepEqual(await execute(operations.settings, { course_id: 2 }), { ok: false, sent: false, status: 200, error: "moodle_form_session_mismatch" });
    state.settings.session = ANCHOR_SESSION;
    for (const operation of [operations.scales, operations.outcomes, operations.settings]) {
      assert.deepEqual(await execute(operation, { course_id: 3 }), { ok: false, sent: false, error: "moodle_gradebook_arguments_invalid" }, operation.toolName);
      assert.deepEqual(await execute(operation, { course_id: 2, category_id: 100 }), { ok: false, sent: false, error: "moodle_gradebook_arguments_invalid" }, operation.toolName);
    }
    assert.equal(posts.length, postsBeforeConfigurationReads);
    state.item.hiddenUntil.minute = "21";
    state.item.lockTime.day = "7";
    const inactiveDatesChanged = await execute(operations.itemRead, { course_id: 2, grade_item_id: 200 });
    assert.equal(inactiveDatesChanged.snapshot_digest, item.snapshot_digest);
    assert.equal(inactiveDatesChanged.data.protected_settings_digest, item.data.protected_settings_digest);
    state.item.hiddenUntil.enabled = true;
    const enabledDates = await execute(operations.itemRead, { course_id: 2, grade_item_id: 200 });
    assert.notEqual(enabledDates.snapshot_digest, item.snapshot_digest);
    assert.notEqual(enabledDates.data.protected_settings_digest, item.data.protected_settings_digest);
    state.item.hiddenUntil.minute = "22";
    const enabledDateChanged = await execute(operations.itemRead, { course_id: 2, grade_item_id: 200 });
    assert.notEqual(enabledDateChanged.snapshot_digest, enabledDates.snapshot_digest);
    assert.notEqual(enabledDateChanged.data.protected_settings_digest, enabledDates.data.protected_settings_digest);
    const changedItem = await execute(operations.itemWrite, { course_id: 2, grade_item_id: 200, item_name: "Reviewed practice score", expected_digest: enabledDateChanged.snapshot_digest });
    assert.equal(changedItem.ok, true, JSON.stringify(changedItem));
    assert.equal(posts.length, 3);
    assert.equal(posts[2].values.get("grademax"), "100.00000");
    assert.equal(posts[2].values.get("locked"), "0");
    assert.equal(posts[2].values.get("hiddenuntil[enabled]"), "1");
    assert.equal(posts[2].values.get("hiddenuntil[minute]"), "22");
    assert.equal(posts[2].values.get("locktime[enabled]"), null);
    assert.equal(posts[2].values.get("locktime[day]"), "7");
    const postsBeforeMalformedDateToggle = posts.length;
    state.item.malformedDateToggle = true;
    assert.deepEqual(await execute(operations.itemRead, { course_id: 2, grade_item_id: 200 }), { ok: false, sent: false, status: 200, error: "moodle_gradebook_form_invalid" });
    assert.equal(posts.length, postsBeforeMalformedDateToggle);
    state.item.malformedDateToggle = false;

    const keyPrepared = await execute(operations.categoryRead, { course_id: 2, category_id: 100 });
    const postsBeforeKeyChange = posts.length;
    state.categorySessionQueue.push(ANCHOR_SESSION, FOREIGN_SESSION);
    assert.deepEqual(await execute(operations.categoryWrite, { course_id: 2, category_id: 100, fullname: "Must not save", expected_digest: keyPrepared.snapshot_digest }), { ok: false, sent: false, status: 200, error: "moodle_form_session_mismatch" });
    assert.equal(posts.length, postsBeforeKeyChange);

    const preflightPrepared = await execute(operations.categoryRead, { course_id: 2, category_id: 100 });
    await page.evaluate((foreignSession) => {
      const cfg = globalThis.M.cfg;
      const anchorSession = cfg.sesskey;
      let reads = 0;
      Object.defineProperty(cfg, "sesskey", { configurable: true, get: () => (++reads >= 7 ? foreignSession : anchorSession) });
    }, FOREIGN_SESSION);
    assert.deepEqual(await execute(operations.categoryWrite, { course_id: 2, category_id: 100, fullname: "Must not save", expected_digest: preflightPrepared.snapshot_digest }), { ok: false, sent: false, error: "moodle_form_session_mismatch" });
    assert.equal(posts.length, postsBeforeKeyChange);
    await page.evaluate((anchorSession) => { Object.defineProperty(globalThis.M.cfg, "sesskey", { configurable: true, writable: true, value: anchorSession }); }, ANCHOR_SESSION);

    const stable = await execute(operations.categoryRead, { course_id: 2, category_id: 100 });
    const postsBeforeStale = posts.length;
    assert.deepEqual(await execute(operations.categoryWrite, { course_id: 2, category_id: 100, fullname: "Must not save", expected_digest: "0".repeat(64) }), { ok: false, sent: false, status: 200, error: "moodle_expected_digest_mismatch" });
    assert.equal(posts.length, postsBeforeStale);
    state.category.max = "101";
    assert.deepEqual(await execute(operations.categoryWrite, { course_id: 2, category_id: 100, fullname: "Must not save", expected_digest: stable.snapshot_digest }), { ok: false, sent: false, status: 200, error: "moodle_expected_digest_mismatch" });
    assert.equal(posts.length, postsBeforeStale);

    state.item.itemType = "mod";
    assert.deepEqual(await execute(operations.itemRead, { course_id: 2, grade_item_id: 200 }), { ok: false, sent: false, status: 200, error: "moodle_gradebook_item_not_manual" });
    assert.equal(posts.length, postsBeforeStale);
    state.item.itemType = "manual";
    state.wrongIdentity = true;
    assert.deepEqual(await execute(operations.categoryRead, { course_id: 2, category_id: 100 }), { ok: false, sent: false, status: 200, error: "moodle_gradebook_form_invalid" });
    state.wrongIdentity = false;
    state.queryAction = true;
    assert.deepEqual(await execute(operations.categoryRead, { course_id: 2, category_id: 100 }), { ok: false, sent: false, status: 200, error: "moodle_gradebook_form_invalid" });
    state.queryAction = false;
    state.externalAction = true;
    assert.deepEqual(await execute(operations.categoryRead, { course_id: 2, category_id: 100 }), { ok: false, sent: false, status: 200, error: "moodle_gradebook_form_invalid" });
    assert.equal(posts.length, postsBeforeStale);
    state.externalAction = false;

    const unknownPrepared = await execute(operations.categoryRead, { course_id: 2, category_id: 100 });
    const postsBeforeLostResponse = posts.length;
    await loseNextCategoryPostResponse();
    assert.deepEqual(await execute(operations.categoryWrite, { course_id: 2, category_id: 100, fullname: "Applied but unconfirmed", expected_digest: unknownPrepared.snapshot_digest }), {
      ok: false,
      sent: true,
      outcomeUnknown: true,
      verification: { schema: "morrow.browser-verification.v1", status: "unconfirmed", reason: "moodle_gradebook_write_unconfirmed" },
      error: "moodle_gradebook_write_unconfirmed",
    });
    assert.equal(posts.length, postsBeforeLostResponse + 1);
    assert.equal(state.category.name, "Applied but unconfirmed");

    const driftPrepared = await execute(operations.categoryRead, { course_id: 2, category_id: 100 });
    const postsBeforeDrift = posts.length;
    state.savedCategoryNameOverride = "Name the site kept";
    assert.deepEqual(await execute(operations.categoryWrite, { course_id: 2, category_id: 100, fullname: "Requested category name", expected_digest: driftPrepared.snapshot_digest }), {
      ok: false,
      sent: true,
      outcomeUnknown: true,
      verification: { schema: "morrow.browser-verification.v1", status: "unconfirmed", reason: "moodle_gradebook_write_not_verified" },
      error: "moodle_gradebook_write_not_verified",
    });
    assert.equal(posts.length, postsBeforeDrift + 1);
    assert.equal(posts[posts.length - 1].values.get("fullname"), "Requested category name");
    assert.equal(state.category.name, "Name the site kept");
    state.savedCategoryNameOverride = "";

    // Bounded configuration writes beyond the rename. Each one names its own
    // native controls, so it carries its own protected digest over the same
    // form, and the rename target stays inside that protected set.
    const categoryBefore = await execute(operations.categoryRead, { course_id: 2, category_id: 100 });
    const postsBeforeCategorySettings = posts.length;
    const categoryChanged = await execute(operations.categorySettingsWrite, { course_id: 2, category_id: 100, aggregation: 0, drop_lowest: 2, weight: 12.5, expected_digest: categoryBefore.snapshot_digest });
    assert.equal(categoryChanged.ok, true, JSON.stringify(categoryChanged));
    assert.equal(categoryChanged.verification.status, "verified");
    assert.equal(posts.length, postsBeforeCategorySettings + 1);
    assert.deepEqual(categoryChanged.data.changed_settings, [
      { name: "aggregation", value: 0 },
      { name: "drop_lowest", value: 2 },
      { name: "weight", value: 12.5 },
      { name: "weight_override", value: 1 },
    ]);
    const categoryPost = posts[posts.length - 1];
    assert.equal(categoryPost.query, "");
    assert.equal(categoryPost.values.get("aggregation"), "0");
    assert.equal(categoryPost.values.get("droplow"), "2");
    assert.equal(categoryPost.values.get("grade_item_aggregationcoef2"), "12.5");
    assert.deepEqual(categoryPost.values.getAll("grade_item_weightoverride"), ["1"]);
    assert.equal(categoryPost.values.get("fullname"), "Name the site kept");
    assert.equal(categoryPost.values.get("grade_item_grademax"), "101");
    assert.equal(categoryChanged.data.fullname, "Name the site kept");
    assert.equal(categoryChanged.data.protected_setting_names.includes("fullname"), true);
    assert.deepEqual(categoryChanged.data.protected_setting_names.filter((name) => ["aggregation", "droplow", "grade_item_aggregationcoef2", "grade_item_weightoverride"].includes(name)), []);
    assert.notEqual(categoryChanged.data.protected_settings_digest, categoryBefore.data.protected_settings_digest);
    assert.equal(
      digestOf({ kind: "category", courseId: "2", targetId: "100", entries: categoryChanged.data.protected_settings.map((entry) => [entry.name, entry.value]) }),
      categoryChanged.data.protected_settings_digest,
    );
    for (const forbidden of [ANCHOR_SESSION, LEARNER_NAME, LEARNER_GRADE]) {
      assert.equal(JSON.stringify(categoryChanged).includes(forbidden), false, forbidden);
    }

    state.category.weightControls = false;
    const withoutWeight = await execute(operations.categoryRead, { course_id: 2, category_id: 100 });
    const postsBeforeWeightRefusal = posts.length;
    assert.deepEqual(await execute(operations.categorySettingsWrite, { course_id: 2, category_id: 100, weight: 5, expected_digest: withoutWeight.snapshot_digest }), { ok: false, sent: false, status: 200, error: "moodle_gradebook_native_setting_refused" });
    assert.equal(posts.length, postsBeforeWeightRefusal);
    state.category.weightControls = true;

    const stalePrepared = await execute(operations.categoryRead, { course_id: 2, category_id: 100 });
    const postsBeforeStaleSettings = posts.length;
    state.category.dropLow = "1";
    assert.deepEqual(await execute(operations.categorySettingsWrite, { course_id: 2, category_id: 100, aggregation: 2, expected_digest: stalePrepared.snapshot_digest }), { ok: false, sent: false, status: 200, error: "moodle_expected_digest_mismatch" });
    assert.deepEqual(await execute(operations.categorySettingsWrite, { course_id: 2, category_id: 100, aggregation: 2, expected_digest: "0".repeat(64) }), { ok: false, sent: false, status: 200, error: "moodle_expected_digest_mismatch" });
    const offered = await execute(operations.categoryRead, { course_id: 2, category_id: 100 });
    assert.deepEqual(await execute(operations.categorySettingsWrite, { course_id: 2, category_id: 100, aggregation: 99, expected_digest: offered.snapshot_digest }), { ok: false, sent: false, status: 200, error: "moodle_gradebook_native_setting_refused" });
    assert.equal(posts.length, postsBeforeStaleSettings);

    const lostPrepared = await execute(operations.categoryRead, { course_id: 2, category_id: 100 });
    const postsBeforeLostSettings = posts.length;
    await loseNextCategoryPostResponse();
    assert.deepEqual(await execute(operations.categorySettingsWrite, { course_id: 2, category_id: 100, drop_lowest: 3, expected_digest: lostPrepared.snapshot_digest }), {
      ok: false,
      sent: true,
      outcomeUnknown: true,
      verification: { schema: "morrow.browser-verification.v1", status: "unconfirmed", reason: "moodle_gradebook_write_unconfirmed" },
      error: "moodle_gradebook_write_unconfirmed",
    });
    assert.equal(posts.length, postsBeforeLostSettings + 1);
    assert.equal(state.category.dropLow, "3");

    const postsBeforeItemSettings = posts.length;
    state.item.itemType = "mod";
    assert.deepEqual(await execute(operations.itemSettingsWrite, { course_id: 2, grade_item_id: 200, decimals: -1, expected_digest: "0".repeat(64) }), { ok: false, sent: false, status: 200, error: "moodle_gradebook_item_not_manual" });
    state.item.itemType = "manual";

    // The native item form offers its rescale control only for an item that
    // already has grades, so its presence is what makes a range change need an
    // approval that names the effect, and a grade-type change refuse outright.
    const graded = await execute(operations.itemRead, { course_id: 2, grade_item_id: 200 });
    assert.deepEqual(await execute(operations.itemSettingsWrite, { course_id: 2, grade_item_id: 200, maximum_grade: 80, expected_digest: graded.snapshot_digest }), { ok: false, sent: false, status: 200, error: "moodle_gradebook_rescale_approval_required" });
    assert.deepEqual(await execute(operations.itemSettingsWrite, { course_id: 2, grade_item_id: 200, grade_type: 0, expected_digest: graded.snapshot_digest }), { ok: false, sent: false, status: 200, error: "moodle_gradebook_grade_type_refused" });
    assert.deepEqual(await execute(operations.itemSettingsWrite, { course_id: 2, grade_item_id: 200, grade_type: 2, expected_digest: graded.snapshot_digest }), { ok: false, sent: false, status: 200, error: "moodle_gradebook_grade_type_refused" });
    assert.equal(posts.length, postsBeforeItemSettings);

    const rescaled = await execute(operations.itemSettingsWrite, { course_id: 2, grade_item_id: 200, maximum_grade: 80, minimum_grade: 10, rescale_existing_grades: "rescale", expected_digest: graded.snapshot_digest });
    assert.equal(rescaled.ok, true, JSON.stringify(rescaled));
    assert.equal(rescaled.verification.status, "verified");
    assert.equal(posts.length, postsBeforeItemSettings + 1);
    assert.deepEqual(rescaled.data.changed_settings, [{ name: "maximum_grade", value: 80 }, { name: "minimum_grade", value: 10 }]);
    assert.equal(rescaled.data.rescale_effect_sent, "rescale");
    assert.equal(rescaled.data.item_name, "Reviewed practice score");
    assert.equal(posts[posts.length - 1].values.get("rescalegrades"), "yes");
    assert.equal(posts[posts.length - 1].values.get("grademax"), "80");
    assert.equal(posts[posts.length - 1].values.get("grademin"), "10");
    assert.equal(posts[posts.length - 1].values.get("itemname"), "Reviewed practice score");
    for (const forbidden of [ANCHOR_SESSION, LEARNER_NAME, LEARNER_GRADE]) {
      assert.equal(JSON.stringify(rescaled).includes(forbidden), false, forbidden);
    }

    // Moodle writes a saved float with the site language's decimal separator,
    // so the change sends back the separator the loaded control already shows.
    state.item.separator = ",";
    const commaRead = await execute(operations.itemRead, { course_id: 2, grade_item_id: 200 });
    const postsBeforeComma = posts.length;
    const commaChanged = await execute(operations.itemSettingsWrite, { course_id: 2, grade_item_id: 200, maximum_grade: 90.5, rescale_existing_grades: "keep", expected_digest: commaRead.snapshot_digest });
    assert.equal(commaChanged.ok, true, JSON.stringify(commaChanged));
    assert.equal(posts.length, postsBeforeComma + 1);
    assert.equal(posts[posts.length - 1].values.get("grademax"), "90,5");
    assert.equal(posts[posts.length - 1].values.get("rescalegrades"), "no");
    assert.deepEqual(commaChanged.data.changed_settings, [{ name: "maximum_grade", value: 90.5 }]);
    assert.equal(commaChanged.data.rescale_effect_sent, "keep");
    state.item.separator = ".";

    state.item.hasGrades = false;
    const ungraded = await execute(operations.itemRead, { course_id: 2, grade_item_id: 200 });
    const postsBeforeUngraded = posts.length;
    assert.deepEqual(await execute(operations.itemSettingsWrite, { course_id: 2, grade_item_id: 200, maximum_grade: 60, rescale_existing_grades: "keep", expected_digest: ungraded.snapshot_digest }), { ok: false, sent: false, status: 200, error: "moodle_gradebook_native_setting_refused" });
    const configured = await execute(operations.itemSettingsWrite, { course_id: 2, grade_item_id: 200, grade_type: 3, display_type: 2, decimals: -1, parent_category_id: 100, expected_digest: ungraded.snapshot_digest });
    assert.equal(configured.ok, true, JSON.stringify(configured));
    assert.equal(posts.length, postsBeforeUngraded + 1);
    assert.deepEqual(configured.data.changed_settings, [
      { name: "grade_type", value: 3 },
      { name: "display_type", value: 2 },
      { name: "decimals", value: -1 },
      { name: "parent_category_id", value: 100 },
    ]);
    assert.equal(Object.hasOwn(configured.data, "rescale_effect_sent"), false);
    assert.equal(posts[posts.length - 1].values.get("parentcategory"), "100");
    assert.equal(posts[posts.length - 1].values.get("grademax"), "90.50000");

    // Moodle removes the rescale control for a scale item, so the form cannot
    // say whether that item has grades and the grade type stays bounded away
    // from the scale type on both sides.
    state.item.gradeType = "2";
    const scaled = await execute(operations.itemRead, { course_id: 2, grade_item_id: 200 });
    const postsBeforeScale = posts.length;
    assert.deepEqual(await execute(operations.itemSettingsWrite, { course_id: 2, grade_item_id: 200, grade_type: 1, expected_digest: scaled.snapshot_digest }), { ok: false, sent: false, status: 200, error: "moodle_gradebook_grade_type_refused" });
    assert.equal(posts.length, postsBeforeScale);
    state.item.gradeType = "1";

    const itemDrift = await execute(operations.itemRead, { course_id: 2, grade_item_id: 200 });
    const postsBeforeItemDrift = posts.length;
    state.savedItemMaximumOverride = 70;
    assert.deepEqual(await execute(operations.itemSettingsWrite, { course_id: 2, grade_item_id: 200, maximum_grade: 65, expected_digest: itemDrift.snapshot_digest }), {
      ok: false,
      sent: true,
      outcomeUnknown: true,
      verification: { schema: "morrow.browser-verification.v1", status: "unconfirmed", reason: "moodle_gradebook_write_not_verified" },
      error: "moodle_gradebook_write_not_verified",
    });
    assert.equal(posts.length, postsBeforeItemDrift + 1);
    assert.equal(state.item.max, 70);
    state.savedItemMaximumOverride = null;

    const bounded = await execute(operations.itemRead, { course_id: 2, grade_item_id: 200 });
    const postsBeforeBounded = posts.length;
    assert.deepEqual(await execute(operations.itemSettingsWrite, { course_id: 2, grade_item_id: 200, maximum_grade: 5, expected_digest: bounded.snapshot_digest }), { ok: false, sent: false, status: 200, error: "moodle_gradebook_native_setting_refused" });
    for (const invalid of [
      { course_id: 2, grade_item_id: 200, expected_digest: bounded.snapshot_digest },
      { course_id: 2, grade_item_id: 200, maximum_grade: 80.123456, expected_digest: bounded.snapshot_digest },
      { course_id: 2, grade_item_id: 200, item_name: "Not this tool", decimals: 1, expected_digest: bounded.snapshot_digest },
      { course_id: 2, grade_item_id: 200, decimals: 1, rescale_existing_grades: "maybe", expected_digest: bounded.snapshot_digest },
      { course_id: 2, grade_item_id: 200, decimals: 1 },
    ]) {
      assert.deepEqual(await execute(operations.itemSettingsWrite, invalid), { ok: false, sent: false, error: "moodle_gradebook_arguments_invalid" }, JSON.stringify(invalid));
    }
    assert.deepEqual(await execute(operations.categorySettingsWrite, { course_id: 2, category_id: 100, fullname: "Not this tool", aggregation: 0, expected_digest: bounded.snapshot_digest }), { ok: false, sent: false, error: "moodle_gradebook_arguments_invalid" });
    assert.equal(posts.length, postsBeforeBounded);

    const postsBeforeOrdinaryEmpty = posts.length;
    state.category.name = "";
    assert.deepEqual(await execute(operations.categoryRead, { course_id: 2, category_id: 100 }), { ok: false, sent: false, status: 200, error: "moodle_gradebook_form_invalid" });
    assert.equal(posts.length, postsBeforeOrdinaryEmpty);
  } finally {
    await context?.close();
    await browser?.close();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Moodle gradebook catalog and worker expose only the ten guarded configuration operations", () => {
  const root = new URL("../..", import.meta.url);
  const catalog = JSON.parse(readFileSync(new URL("connector/extension/generated/moodle-browser-catalog.json", root), "utf8"));
  const worker = readFileSync(new URL("connector/extension/src/service-worker.js", root), "utf8");
  // The gradebook executor serves exactly the keys the worker routes to it.
  const routed = worker.slice(worker.indexOf("const MOODLE_GRADEBOOK_OPERATION_KEYS"));
  const guarded = [...routed.slice(0, routed.indexOf("]);")).matchAll(/"(moodle\.[a-z0-9_.]+)"/g)].map((match) => match[1]);
  assert.deepEqual(guarded.slice().sort(), [
    "moodle.form.grade.outcome.index.read.v1",
    "moodle.form.grade.scale.index.read.v1",
    "moodle.form.grade.settings.index.read.v1",
    "moodle.form.grade.tree.category.read.v1",
    "moodle.form.grade.tree.category.settings.write.v1",
    "moodle.form.grade.tree.category.write.v1",
    "moodle.form.grade.tree.index.read.v1",
    "moodle.form.grade.tree.item.read.v1",
    "moodle.form.grade.tree.item.settings.write.v1",
    "moodle.form.grade.tree.item.write.v1",
  ]);
  const entries = guarded.map((key) => catalog.operations.find((entry) => entry.key === key));
  assert.deepEqual(entries.filter(Boolean).length, guarded.length, "every routed gradebook key needs a catalog entry");
  assert.deepEqual(entries.filter((entry) => entry.readOnly === false).map((entry) => entry.reviewTool).sort(), [
    "moodle_get_grade_category", "moodle_get_grade_category", "moodle_get_grade_item", "moodle_get_grade_item",
  ]);
  for (const entry of entries.filter((candidate) => candidate.readOnly === true)) {
    assert.match(entry.description, /excludes[^.]*student grades/, entry.toolName);
  }
  for (const toolName of ["moodle_get_grade_scales", "moodle_get_grade_outcomes", "moodle_get_gradebook_settings"]) {
    const entry = entries.find((candidate) => candidate.toolName === toolName);
    assert.deepEqual(Object.keys(entry.inputSchema.properties), ["course_id"], toolName);
    assert.match(entry.description, /It requires the moodle\/[a-z:]+ capability at that exact course context[.,]/, toolName);
  }
  // Each settings write names its own bounded controls, and neither one carries
  // the rename field of the form it shares.
  const settingsFields = {
    moodle_update_grade_category_settings: {
      properties: ["course_id", "category_id", "aggregation", "drop_lowest", "weight", "expected_digest"],
      required: ["course_id", "category_id", "expected_digest"],
    },
    moodle_update_grade_item_settings: {
      properties: ["course_id", "grade_item_id", "grade_type", "maximum_grade", "minimum_grade", "display_type", "decimals", "parent_category_id", "rescale_existing_grades", "expected_digest"],
      required: ["course_id", "grade_item_id", "expected_digest"],
    },
  };
  for (const [toolName, shape] of Object.entries(settingsFields)) {
    const entry = entries.find((candidate) => candidate.toolName === toolName);
    assert.deepEqual(Object.keys(entry.inputSchema.properties), shape.properties, toolName);
    assert.deepEqual(entry.inputSchema.required, shape.required, toolName);
    assert.equal(entry.readOnly, false, toolName);
    assert.match(entry.description, /never reads or changes student grades|never reads a stored grade/, toolName);
  }
  assert.match(entries.find((entry) => entry.toolName === "moodle_update_grade_item_settings").description, /rescale or keep/);
  assert.match(entries.find((entry) => entry.toolName === "moodle_update_grade_category_settings").description, /applied but unconfirmed/);
  assert.match(worker, /import \{ executeMoodleGradebookInPage \} from "\.\/moodle-gradebook-executor\.js";/);
});
