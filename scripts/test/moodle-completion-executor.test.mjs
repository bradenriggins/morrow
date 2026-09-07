import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { categoriesForBinding, changedFields, createEditPermission } from "../../connector/extension/src/edit-policy.js";
import { matchesBridgeEditPermission } from "../../packages/bridge-protocol/dist/index.js";
import { executeMoodleCompletionInPage } from "../../connector/extension/src/moodle-completion-executor.js";

const ANCHOR_SESSION = "moodle-session-a";
const FOREIGN_SESSION = "moodle-session-b";
const COURSE_SENTINEL = "_qf__force_multiselect_submission";
const LEARNER_NAME = "Ada Lovelace";
const LEARNER_EMAIL = "ada@example.edu";

const operations = Object.freeze({
  activityRead: { key: "moodle.form.course.modedit.completion.read.v1", toolName: "moodle_get_activity_completion", provider: "moodle", readOnly: true },
  activityWrite: { key: "moodle.form.course.modedit.completion.write.v1", toolName: "moodle_update_activity_completion", provider: "moodle", readOnly: false },
  courseRead: { key: "moodle.form.course.completion.read.v1", toolName: "moodle_get_course_completion", provider: "moodle", readOnly: true },
  courseWrite: { key: "moodle.form.course.completion.write.v1", toolName: "moodle_update_course_completion", provider: "moodle", readOnly: false },
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

function range(from, to) {
  const values = [];
  for (let value = from; value <= to; value += 1) values.push(String(value));
  return values;
}

function select(name, entries, current) {
  const options = entries
    .map(([value, text]) => `<option value="${value}"${value === current ? " selected" : ""}>${text}</option>`)
    .join("");
  return `<select name="${name}">${options}</select>`;
}

function numberSelect(name, from, to, current) {
  return select(name, range(from, to).map((value) => [value, value]), current);
}

function checkbox(name, text, checked) {
  const controlId = `id_${name.replace(/[^A-Za-z0-9]+/g, "_")}`;
  return `<input type="checkbox" name="${name}" id="${controlId}" value="1"${checked ? " checked" : ""}>`
    + `<label for="${controlId}">${text}</label>`;
}

// Moodle's advanced checkbox submits a hidden off value before the box itself.
function advCheckbox(name, text, checked) {
  const controlId = `id_${name.replace(/[^A-Za-z0-9]+/g, "_")}`;
  return `<input type="hidden" name="${name}" value="0">`
    + `<input type="checkbox" name="${name}" id="${controlId}" value="1"${checked ? " checked" : ""}>`
    + `<label for="${controlId}">${text}</label>`;
}

function radio(name, value, text, current) {
  const controlId = `id_${name}_${value}`;
  return `<input type="radio" name="${name}" id="${controlId}" value="${value}"${value === current ? " checked" : ""}>`
    + `<label for="${controlId}">${text}</label>`;
}

// Moodle's date_time_selector renders five selects; an optional selector adds
// one checkbox that the browser submits only when it is switched on.
function dateTimeGroup(field, value) {
  return `<input type="checkbox" name="${field}[enabled]" value="1"${value.enabled ? " checked" : ""}>`
    + numberSelect(`${field}[year]`, 2024, 2030, value.year)
    + numberSelect(`${field}[month]`, 1, 12, value.month)
    + numberSelect(`${field}[day]`, 1, 31, value.day)
    + numberSelect(`${field}[hour]`, 0, 23, value.hour)
    + numberSelect(`${field}[minute]`, 0, 59, value.minute);
}

// Moodle's date_selector renders three selects and no time.
function dateGroup(field, value) {
  return numberSelect(`${field}[day]`, 1, 31, value.day)
    + numberSelect(`${field}[month]`, 1, 12, value.month)
    + numberSelect(`${field}[year]`, 2024, 2030, value.year);
}

/**
 * The native activity settings form of one Forum, with the Activity completion
 * section Moodle builds from core_completion\form\form_trait.
 */
function activityForm(state, action, sesskey, draft) {
  const activity = state.activity;
  const completionSection = state.completionEnabled
    ? `<fieldset id="id_activitycompletionheader">
        <input type="hidden" name="mform_isexpanded_id_activitycompletionheader" value="1">
        ${state.completionLocked ? '<input type="submit" name="unlockcompletion" value="Unlock completion settings">' : ""}
        <input type="hidden" name="completionunlocked" value="${state.completionLocked ? "0" : "1"}">
        ${radio("completion", "0", "None", activity.completion)}
        ${radio("completion", "1", "Students can manually mark the activity as done", activity.completion)}
        ${radio("completion", "2", "Show activity as complete when conditions are met", activity.completion)}
        ${checkbox("completionview", "View the activity", activity.completionview)}
        ${checkbox("completionusegrade", "Receive a grade", activity.completionusegrade)}
        ${select("completiongradeitemnumber", [["0", "Forum"], ["1", "Rating"]], activity.completiongradeitemnumber)}
        ${radio("completionpassgrade", "0", "Any grade", activity.completionpassgrade)}
        ${radio("completionpassgrade", "1", "Passing grade", activity.completionpassgrade)}
        ${checkbox("completiondiscussionsenabled", "Start discussions", activity.completiondiscussionsenabled)}
        <input type="text" name="completiondiscussions" value="${activity.completiondiscussions}">
        ${checkbox("completionrepliesenabled", "Post replies", activity.completionrepliesenabled)}
        <input type="text" name="completionreplies" value="${activity.completionreplies}">
        ${dateTimeGroup("completionexpected", activity.completionexpected)}
      </fieldset>`
    : "";
  return `<!doctype html><html><body class="path-course course-2">
    <form method="get" action="/search/index.php"><input type="text" name="q" value=""></form>
    <form method="post" action="${action}" id="id_mod_form">
      <input type="hidden" name="update" value="6">
      <input type="hidden" name="coursemodule" value="6">
      <input type="hidden" name="course" value="2">
      <input type="hidden" name="module" value="9">
      <input type="hidden" name="modulename" value="forum">
      <input type="hidden" name="instance" value="4">
      <input type="hidden" name="section" value="1">
      <input type="hidden" name="return" value="0">
      <input type="hidden" name="sesskey" value="${sesskey}">
      <input type="hidden" name="_qf__mod_forum_mod_form" value="1">
      <fieldset id="id_general">
        <input type="text" name="name" value="${activity.name}">
        <textarea name="introeditor[text]">${activity.intro}</textarea>
        <input type="hidden" name="introeditor[format]" value="1">
        <input type="hidden" name="introeditor[itemid]" value="${draft}">
        ${select("type", [["general", "Standard forum"], ["qanda", "Question and answer"]], activity.type)}
      </fieldset>
      <fieldset id="id_modstandardgrade">
        ${select("grade[modgrade_type]", [["none", "None"], ["point", "Point"]], activity.gradeType)}
        <input type="text" name="gradepass" value="${activity.gradepass}">
      </fieldset>
      ${completionSection}
      <input type="checkbox" name="coursecontentnotification" value="1">
      <input type="submit" name="submitbutton2" value="Save and return to course">
      <input type="submit" name="submitbutton" value="Save and display">
      <input type="submit" name="cancel" value="Cancel">
    </form>
    <table class="generaltable"><tbody><tr><td>${LEARNER_NAME}</td><td>${LEARNER_EMAIL}</td></tr></tbody></table>
  </body></html>`;
}

/** The native course completion settings form of public/course/completion_form.php. */
function courseCompletionForm(state, action, sesskey, dateDefault) {
  const course = state.course;
  const aggregation = [["1", "All"], ["2", "Any"]];
  const locked = state.courseLocked;
  return `<!doctype html><html><body class="path-course course-2">
    <form method="get" action="/search/index.php"><input type="text" name="q" value=""></form>
    <form method="post" action="${action}" id="id_course_completion_form">
      <input type="hidden" name="sesskey" value="${sesskey}">
      <input type="hidden" name="_qf__course_completion_form" value="1">
      ${locked ? '<input type="submit" name="settingsunlock" value="Unlock criteria and delete completion data">' : ""}
      ${select("overall_aggregation", aggregation, course.overall_aggregation)}
      <input type="hidden" name="checkbox_controller1" value="1">
      ${advCheckbox("criteria_activity[6]", "Forum - Week 1 discussion", course.criteria_activity[6])}
      ${advCheckbox("criteria_activity[7]", "Quiz - Week 1 quiz", course.criteria_activity[7])}
      ${select("activity_aggregation", aggregation, course.activity_aggregation)}
      <input type="hidden" name="criteria_course[]" value="${COURSE_SENTINEL}">
      <select name="criteria_course[]" multiple><option value="9">Anatomy and physiology</option></select>
      ${select("course_aggregation", aggregation, course.course_aggregation)}
      ${checkbox("criteria_date", "Enable", course.criteria_date)}
      ${dateGroup("criteria_date_value", course.criteria_date ? course.criteria_date_value : dateDefault)}
      ${checkbox("criteria_duration", "Enable", course.criteria_duration)}
      ${select("criteria_duration_days", [["86400", "1 day"], ["604800", "7 days"]], course.criteria_duration_days)}
      ${checkbox("criteria_unenrol", "Enable", course.criteria_unenrol)}
      ${checkbox("criteria_grade", "Enable", course.criteria_grade)}
      <input type="text" name="criteria_grade_value" value="${course.criteria_grade_value}">
      ${checkbox("criteria_self", "Enable", course.criteria_self)}
      ${checkbox("criteria_role[3]", "Teacher", course.criteria_role[3])}
      ${select("role_aggregation", aggregation, course.role_aggregation)}
      <input type="hidden" name="id" value="2">
      <input type="submit" name="submitbutton" value="Save changes">
      <input type="submit" name="cancel" value="Cancel">
    </form>
    <table class="generaltable"><tbody><tr><td>${LEARNER_NAME}</td><td>${LEARNER_EMAIL}</td></tr></tbody></table>
  </body></html>`;
}

function participantsTable(total) {
  return `<div data-region="core_table/dynamic" data-table-component="core_user" data-table-handler="participants"
    data-table-uniqueid="user-index-participants-2" data-table-total-rows="${total}">
    <table><tbody><tr><td><input class="usercheckbox" name="user5"></td><td>${LEARNER_NAME}</td></tr></tbody></table>
  </div>`;
}

function readBody(request) {
  return new Promise((resolve) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

test("Moodle completion executor changes one condition set per POST, states the participants it reaches, and never opens a view page", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morrow-moodle-completion-"));
  const key = join(directory, "key.pem");
  const certificate = join(directory, "certificate.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", certificate], { stdio: "ignore" });

  const state = {
    activity: {
      name: "Week 1 discussion",
      intro: "<p>Introduce yourself.</p>",
      type: "general",
      gradeType: "point",
      gradepass: "0.00",
      completion: "2",
      completionview: true,
      completionusegrade: false,
      completiongradeitemnumber: "0",
      completionpassgrade: "0",
      completiondiscussionsenabled: false,
      completiondiscussions: "0",
      completionrepliesenabled: false,
      completionreplies: "0",
      completionexpected: { enabled: false, year: "2026", month: "9", day: "7", hour: "0", minute: "0" },
    },
    course: {
      overall_aggregation: "1",
      activity_aggregation: "1",
      course_aggregation: "1",
      role_aggregation: "1",
      criteria_activity: { 6: false, 7: true },
      criteria_date: false,
      criteria_date_value: { year: "2026", month: "9", day: "8" },
      criteria_duration: false,
      criteria_duration_days: "86400",
      criteria_unenrol: false,
      criteria_grade: false,
      criteria_grade_value: "0.00000",
      criteria_self: false,
      criteria_role: { 3: false },
    },
    completionEnabled: true,
    completionLocked: false,
    courseLocked: false,
    participants: 24,
    participantsAvailable: true,
    introFiles: "empty",
    session: ANCHOR_SESSION,
    sessionQueue: [],
  };
  const posts = [];
  const requests = [];
  const draftStates = new Map();
  let draftCounter = 900;
  // Moodle re-defaults an unused course completion date on every load, so the
  // fixture moves it exactly as Moodle would.
  let dateDefaultDay = 10;
  let origin = "";

  const server = createServer({ key: readFileSync(key), cert: readFileSync(certificate) }, async (request, response) => {
    const url = new URL(request.url || "/", origin || "https://127.0.0.1");
    requests.push(`${request.method} ${url.pathname}${url.search}`);
    if (url.pathname === "/course/view.php") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<!doctype html><body class="path-course course-2"><script>var M = {}; M.cfg = ${JSON.stringify({ wwwroot: origin, sesskey: ANCHOR_SESSION, userId: 3, courseId: 2 })};</script></body>`);
      return;
    }
    if (request.method === "GET" && url.pathname === "/course/modedit.php" && url.search === "?update=6&return=0") {
      // A native draft item id is new on every load of the same form.
      const draft = String(++draftCounter);
      draftStates.set(draft, state.introFiles);
      const sesskey = state.sessionQueue.shift() || state.session;
      response.writeHead(200, { "content-type": "text/html" });
      response.end(activityForm(state, "/course/modedit.php?update=6&amp;return=0", sesskey, draft));
      return;
    }
    if (request.method === "GET" && url.pathname === "/course/completion.php" && url.search === "?id=2") {
      const sesskey = state.sessionQueue.shift() || state.session;
      dateDefaultDay = dateDefaultDay === 28 ? 10 : dateDefaultDay + 1;
      response.writeHead(200, { "content-type": "text/html" });
      response.end(courseCompletionForm(state, "completion.php?id=2", sesskey, { year: "2026", month: "10", day: String(dateDefaultDay) }));
      return;
    }
    if (request.method === "POST" && url.pathname === "/repository/draftfiles_ajax.php" && url.search === "?action=list") {
      const values = new URLSearchParams(await readBody(request));
      const itemState = draftStates.get(values.get("itemid") || "");
      if (itemState === "unavailable") {
        response.writeHead(500).end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(itemState === "nonempty"
        ? JSON.stringify({ filecount: 1, list: [{ filename: "brief.pdf", filepath: "/", size: 2048 }], tree: { children: [] } })
        : JSON.stringify({ filecount: 0, list: [], tree: { children: [] } }));
      return;
    }
    if (request.method === "POST" && url.pathname === "/lib/ajax/service.php") {
      const call = JSON.parse(await readBody(request))[0];
      assert.equal(call?.methodname, "core_table_get_dynamic_table_content");
      assert.equal(url.searchParams.get("info"), "core_table_get_dynamic_table_content");
      assert.equal(call.args.uniqueid, "user-index-participants-2");
      assert.equal(call.args.pagesize, 1);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(state.participantsAvailable
        ? JSON.stringify([{ index: 0, data: JSON.stringify({ html: participantsTable(state.participants) }) }])
        : JSON.stringify([{ index: 0, exception: { errorcode: "nopermissions" } }]));
      return;
    }
    if (request.method === "POST" && url.pathname === "/course/modedit.php") {
      const values = new URLSearchParams(await readBody(request));
      posts.push({ path: url.pathname, query: url.search, values });
      assert.equal(values.get("sesskey"), ANCHOR_SESSION);
      assert.equal(values.get("submitbutton2"), "Save and return to course");
      assert.equal(values.get("submitbutton"), null);
      // The native content change notification mails every enrolled learner.
      assert.equal(values.get("coursecontentnotification"), null);
      const activity = state.activity;
      const text = (name, fallback) => (values.get(name) === null ? fallback : values.get(name));
      activity.name = text("name", activity.name);
      activity.intro = text("introeditor[text]", activity.intro);
      activity.type = text("type", activity.type);
      activity.gradeType = text("grade[modgrade_type]", activity.gradeType);
      activity.gradepass = text("gradepass", activity.gradepass);
      activity.completion = text("completion", activity.completion);
      activity.completionview = values.get("completionview") === "1";
      activity.completionusegrade = values.get("completionusegrade") === "1";
      activity.completiongradeitemnumber = text("completiongradeitemnumber", activity.completiongradeitemnumber);
      activity.completionpassgrade = text("completionpassgrade", activity.completionpassgrade);
      activity.completiondiscussionsenabled = values.get("completiondiscussionsenabled") === "1";
      activity.completiondiscussions = text("completiondiscussions", activity.completiondiscussions);
      activity.completionrepliesenabled = values.get("completionrepliesenabled") === "1";
      activity.completionreplies = text("completionreplies", activity.completionreplies);
      activity.completionexpected.enabled = values.get("completionexpected[enabled]") === "1";
      for (const part of ["year", "month", "day", "hour", "minute"]) {
        activity.completionexpected[part] = text(`completionexpected[${part}]`, activity.completionexpected[part]);
      }
      // Moodle clears the pass-grade condition when the grade condition is off.
      if (!activity.completionusegrade) activity.completionpassgrade = "0";
      response.writeHead(303, { location: "/course/view.php?id=2#module-6" });
      response.end();
      return;
    }
    if (request.method === "POST" && url.pathname === "/course/completion.php") {
      const values = new URLSearchParams(await readBody(request));
      posts.push({ path: url.pathname, query: url.search, values });
      assert.equal(values.get("sesskey"), ANCHOR_SESSION);
      assert.equal(values.get("submitbutton"), "Save changes");
      assert.equal(values.get("settingsunlock"), null);
      const course = state.course;
      // An advanced checkbox submits its off value first, so the last value wins.
      const last = (name) => values.getAll(name).at(-1) ?? null;
      const text = (name, fallback) => (last(name) === null ? fallback : last(name));
      course.overall_aggregation = text("overall_aggregation", course.overall_aggregation);
      course.activity_aggregation = text("activity_aggregation", course.activity_aggregation);
      course.course_aggregation = text("course_aggregation", course.course_aggregation);
      course.role_aggregation = text("role_aggregation", course.role_aggregation);
      for (const moduleId of [6, 7]) course.criteria_activity[moduleId] = last(`criteria_activity[${moduleId}]`) === "1";
      course.criteria_date = last("criteria_date") === "1";
      for (const part of ["year", "month", "day"]) {
        course.criteria_date_value[part] = text(`criteria_date_value[${part}]`, course.criteria_date_value[part]);
      }
      course.criteria_duration = last("criteria_duration") === "1";
      course.criteria_duration_days = text("criteria_duration_days", course.criteria_duration_days);
      course.criteria_unenrol = last("criteria_unenrol") === "1";
      course.criteria_grade = last("criteria_grade") === "1";
      course.criteria_grade_value = text("criteria_grade_value", course.criteria_grade_value);
      course.criteria_self = last("criteria_self") === "1";
      course.criteria_role[3] = last("criteria_role[3]") === "1";
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
    if (!address || typeof address === "string") throw new Error("completion test server did not bind");
    origin = `https://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
    context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    await page.goto(`${origin}/course/view.php?id=2`);
    const binding = { origin, siteUrl: `${origin}/`, principalId: "3", courseId: "2" };
    const execute = (operation, argumentsValue) => page.evaluate(
      executeMoodleCompletionInPage,
      JSON.stringify({ mode: "execute", operation, arguments: argumentsValue, binding, expiresAt: Date.now() + 60_000 }),
    );
    const executeExpired = (operation, argumentsValue) => page.evaluate(
      executeMoodleCompletionInPage,
      JSON.stringify({ mode: "execute", operation, arguments: argumentsValue, binding, expiresAt: Date.now() - 1 }),
    );
    const conditionOf = (result, field) => result.data.conditions.find((entry) => entry.field === field);
    const loseNextPostResponse = (path) => page.evaluate((target) => {
      const nativeFetch = globalThis.fetch;
      globalThis.fetch = async (...parameters) => {
        const response = await nativeFetch(...parameters);
        const request = new URL(parameters[0], globalThis.location.href);
        if (String(parameters[1]?.method || "GET").toUpperCase() === "POST" && request.pathname === target) {
          globalThis.fetch = nativeFetch;
          throw new TypeError("post response lost after dispatch");
        }
        return response;
      };
    }, path);

    // An approval window that has closed sends and reads nothing at all.
    assert.deepEqual(await executeExpired(operations.activityRead, { course_id: 2, module_id: 6 }), {
      ok: false, sent: false, error: "moodle_execution_expired",
    });
    assert.deepEqual(requests.filter((entry) => /modedit\.php|completion\.php|service\.php/.test(entry)), []);

    // A form that does not carry the signed-in session key is refused before anything is sent.
    state.sessionQueue.push(FOREIGN_SESSION);
    assert.deepEqual(await execute(operations.activityRead, { course_id: 2, module_id: 6 }), {
      ok: false, sent: false, status: 200, error: "moodle_form_session_mismatch",
    });
    assert.equal(posts.length, 0);

    const read = await execute(operations.activityRead, { course_id: 2, module_id: 6 });
    assert.equal(read.ok, true, JSON.stringify(read));
    assert.equal(read.data.module_id, "6");
    assert.equal(read.data.module_type, "forum");
    assert.equal(read.data.activity_name, "Week 1 discussion");
    assert.equal(read.data.completion_available, true);
    assert.equal(read.data.settings_locked, false);
    assert.deepEqual(read.data.proof, {
      method: "native_form_read",
      route: "/course/modedit.php",
      required_capability: "moodle/course:manageactivities",
      participant_count_capability: "moodle/course:viewparticipants",
      scope: "activity_completion_only",
    });
    // The approval states the number of enrolled participants a change reaches.
    assert.deepEqual(read.data.enrolled_participants, { count: 24, source: "participants_table" });
    assert.deepEqual(read.data.completion_tracking, {
      field: "completion",
      value: "2",
      available: [
        { value: "0", label: "None" },
        { value: "1", label: "Students can manually mark the activity as done" },
        { value: "2", label: "Show activity as complete when conditions are met" },
      ],
    });
    assert.deepEqual(read.data.conditions.map((entry) => entry.field), [
      "completionview", "completionusegrade", "completiongradeitemnumber", "completionpassgrade",
      "completiondiscussionsenabled", "completiondiscussions", "completionrepliesenabled", "completionreplies",
    ]);
    assert.deepEqual(conditionOf(read, "completionview"), { field: "completionview", kind: "checkbox", value: true, label: "View the activity" });
    assert.deepEqual(conditionOf(read, "completiondiscussions"), { field: "completiondiscussions", kind: "text", value: "0" });
    // A condition Moodle disables while its own checkbox is off is reported with that checkbox.
    assert.deepEqual(conditionOf(read, "completionpassgrade"), {
      field: "completionpassgrade",
      kind: "radio",
      value: "0",
      available: [{ value: "0", label: "Any grade" }, { value: "1", label: "Passing grade" }],
      governed_by: "completionusegrade",
      active: false,
    });
    assert.deepEqual(read.data.completion_expected, { field: "completionexpected", value: null });
    assert.deepEqual(read.data.file_areas, [{ field: "introeditor[itemid]", state: "empty" }]);
    assert.deepEqual(read.data.read_only_conditions, []);
    // The session key, the draft item id and the learner-shaped page noise never leave the browser.
    const readText = JSON.stringify(read);
    assert.equal(readText.includes(ANCHOR_SESSION), false);
    assert.equal(readText.includes(LEARNER_NAME), false);
    assert.equal(readText.includes(LEARNER_EMAIL), false);
    assert.equal(read.data.protected_settings.some((entry) => entry.name === "sesskey"), false);
    assert.deepEqual(read.data.protected_settings.find((entry) => entry.name === "introeditor[itemid]"), {
      name: "introeditor[itemid]", value: "file_area:empty",
    });
    assert.deepEqual(read.data.protected_setting_names, [...new Set(read.data.protected_settings.map((entry) => entry.name))].sort());
    assert.equal(read.data.protected_settings_digest, digestOf({
      courseId: "2", moduleId: "6", entries: read.data.protected_settings.map((entry) => [entry.name, entry.value]),
    }));

    // The same form, loaded again with a new draft item id, is the same digest.
    const second = await execute(operations.activityRead, { course_id: 2, module_id: 6 });
    assert.equal(second.snapshot_digest, read.snapshot_digest);

    // A change that cannot state the participants it reaches never starts.
    state.participantsAvailable = false;
    const withoutCount = await execute(operations.activityRead, { course_id: 2, module_id: 6 });
    assert.equal(withoutCount.data.enrolled_participants, null);
    assert.deepEqual(await execute(operations.activityWrite, {
      course_id: 2, module_id: 6, conditions: [{ name: "completionrepliesenabled", value: true }],
      acknowledge_participant_count: 24, expected_digest: withoutCount.snapshot_digest,
    }), { ok: false, sent: false, status: 200, error: "moodle_completion_participant_count_unavailable" });
    state.participantsAvailable = true;
    assert.equal(posts.length, 0);

    // A number that is no longer the approved number never starts either.
    state.participants = 25;
    assert.deepEqual(await execute(operations.activityWrite, {
      course_id: 2, module_id: 6, conditions: [{ name: "completionrepliesenabled", value: true }],
      acknowledge_participant_count: 24, expected_digest: read.snapshot_digest,
    }), { ok: false, sent: false, status: 200, error: "moodle_completion_participant_count_mismatch" });
    state.participants = 24;
    assert.equal(posts.length, 0);

    // One reviewed condition change, one POST, every other control carried through.
    const changed = await execute(operations.activityWrite, {
      course_id: 2,
      module_id: 6,
      conditions: [{ name: "completiondiscussionsenabled", value: true }, { name: "completiondiscussions", value: 2 }],
      acknowledge_participant_count: 24,
      expected_digest: read.snapshot_digest,
    });
    assert.equal(changed.ok, true, JSON.stringify(changed));
    assert.equal(changed.verification.status, "verified");
    assert.equal(posts.length, 1);
    assert.equal(posts[0].query, "?update=6&return=0");
    assert.equal(posts[0].values.get("completiondiscussionsenabled"), "1");
    assert.equal(posts[0].values.get("completiondiscussions"), "2");
    assert.equal(posts[0].values.get("completion"), "2");
    assert.equal(posts[0].values.get("completionview"), "1");
    assert.equal(posts[0].values.get("name"), "Week 1 discussion");
    assert.equal(posts[0].values.get("introeditor[text]"), "<p>Introduce yourself.</p>");
    assert.equal(posts[0].values.get("gradepass"), "0.00");
    assert.deepEqual(changed.data.changed_conditions, [
      { argument: "conditions", field: "completiondiscussionsenabled", value: true },
      { argument: "conditions", field: "completiondiscussions", value: "2" },
    ]);
    assert.equal(changed.data.replaces_condition_set, false);
    assert.equal(conditionOf(changed, "completiondiscussionsenabled").value, true);
    assert.equal(conditionOf(changed, "completiondiscussions").value, "2");
    assert.equal(state.activity.name, "Week 1 discussion");

    // The reviewed digest binds one exact form state, so a replay refuses before sending anything.
    assert.deepEqual(await execute(operations.activityWrite, {
      course_id: 2, module_id: 6, conditions: [{ name: "completionrepliesenabled", value: true }],
      acknowledge_participant_count: 24, expected_digest: read.snapshot_digest,
    }), { ok: false, sent: false, status: 200, error: "moodle_expected_digest_mismatch" });
    assert.equal(posts.length, 1);

    const afterChange = await execute(operations.activityRead, { course_id: 2, module_id: 6 });
    // A value the loaded control does not offer, and a condition the form does not carry, are refused.
    for (const invalid of [
      { completion_tracking: 9 },
      { conditions: [{ name: "completionsubmit", value: true }] },
      { conditions: [{ name: "completionview", value: "yes" }] },
      { conditions: [{ name: "completionpassgrade", value: 1 }] },
    ]) {
      assert.deepEqual(await execute(operations.activityWrite, {
        course_id: 2, module_id: 6, ...invalid, acknowledge_participant_count: 24, expected_digest: afterChange.snapshot_digest,
      }), { ok: false, sent: false, status: 200, error: "moodle_activity_completion_condition_refused" }, JSON.stringify(invalid));
    }
    // Moodle applies a condition only under automatic completion, and refuses automatic
    // completion with no condition switched on.
    assert.deepEqual(await execute(operations.activityWrite, {
      course_id: 2, module_id: 6, completion_tracking: 1, conditions: [{ name: "completionview", value: false }],
      acknowledge_participant_count: 24, expected_digest: afterChange.snapshot_digest,
    }), { ok: false, sent: false, status: 200, error: "moodle_activity_completion_conditions_require_automatic" });
    assert.deepEqual(await execute(operations.activityWrite, {
      course_id: 2, module_id: 6,
      conditions: [{ name: "completionview", value: false }, { name: "completiondiscussionsenabled", value: false }, { name: "completiondiscussions", value: 0 }],
      acknowledge_participant_count: 24, expected_digest: afterChange.snapshot_digest,
    }), { ok: false, sent: false, status: 200, error: "moodle_activity_completion_no_condition" });
    assert.deepEqual(await execute(operations.activityWrite, {
      course_id: 2, module_id: 6, completion_tracking: 0, completion_expected: { year: 2026, month: 10, day: 1, hour: 9, minute: 0 },
      acknowledge_participant_count: 24, expected_digest: afterChange.snapshot_digest,
    }), { ok: false, sent: false, status: 200, error: "moodle_activity_completion_date_requires_tracking" });
    assert.equal(posts.length, 1);

    // A condition and the checkbox that governs it change together in one POST, and the
    // readback carries the exact saved condition set.
    const graded = await execute(operations.activityWrite, {
      course_id: 2, module_id: 6,
      conditions: [{ name: "completionusegrade", value: true }, { name: "completionpassgrade", value: 1 }],
      acknowledge_participant_count: 24, expected_digest: afterChange.snapshot_digest,
    });
    assert.equal(graded.ok, true, JSON.stringify(graded));
    assert.equal(posts.length, 2);
    assert.equal(posts[1].values.get("completionusegrade"), "1");
    assert.equal(posts[1].values.get("completionpassgrade"), "1");
    assert.deepEqual(conditionOf(graded, "completionpassgrade"), {
      field: "completionpassgrade",
      kind: "radio",
      value: "1",
      available: [{ value: "0", label: "Any grade" }, { value: "1", label: "Passing grade" }],
      governed_by: "completionusegrade",
      active: true,
    });

    // The expected completion date is switched on and off through its own native toggle.
    const dated = await execute(operations.activityWrite, {
      course_id: 2, module_id: 6, completion_expected: { year: 2026, month: 10, day: 1, hour: 9, minute: 30 },
      acknowledge_participant_count: 24, expected_digest: graded.snapshot_digest,
    });
    assert.equal(dated.ok, true, JSON.stringify(dated));
    assert.equal(posts.length, 3);
    assert.equal(posts[2].values.get("completionexpected[enabled]"), "1");
    assert.equal(posts[2].values.get("completionexpected[minute]"), "30");
    assert.deepEqual(dated.data.completion_expected.value, { year: 2026, month: 10, day: 1, hour: 9, minute: 30 });
    const undated = await execute(operations.activityWrite, {
      course_id: 2, module_id: 6, completion_expected: null,
      acknowledge_participant_count: 24, expected_digest: dated.snapshot_digest,
    });
    assert.equal(undated.ok, true, JSON.stringify(undated));
    assert.equal(posts.length, 4);
    assert.equal(posts[3].values.get("completionexpected[enabled]"), null);
    assert.equal(undated.data.completion_expected.value, null);

    // Moodle locks the completion settings once learner completion data exists, and unlocking
    // them recalculates that data, so Morrow reports the lock and refuses the change.
    state.completionLocked = true;
    const locked = await execute(operations.activityRead, { course_id: 2, module_id: 6 });
    assert.equal(locked.data.settings_locked, true);
    assert.deepEqual(await execute(operations.activityWrite, {
      course_id: 2, module_id: 6, conditions: [{ name: "completionrepliesenabled", value: true }],
      acknowledge_participant_count: 24, expected_digest: locked.snapshot_digest,
    }), { ok: false, sent: false, status: 200, error: "moodle_activity_completion_locked" });
    state.completionLocked = false;

    // A course that does not track completion has no completion section on this form.
    state.completionEnabled = false;
    const unavailable = await execute(operations.activityRead, { course_id: 2, module_id: 6 });
    assert.equal(unavailable.data.completion_available, false);
    assert.deepEqual(unavailable.data.conditions, []);
    assert.equal(unavailable.data.completion_tracking, undefined);
    assert.deepEqual(await execute(operations.activityWrite, {
      course_id: 2, module_id: 6, conditions: [{ name: "completionview", value: true }],
      acknowledge_participant_count: 24, expected_digest: unavailable.snapshot_digest,
    }), { ok: false, sent: false, status: 200, error: "moodle_activity_completion_unavailable" });
    state.completionEnabled = true;
    assert.equal(posts.length, 4);

    // A native file area that is not empty stops the change before anything is sent, because
    // one POST of this form would replace that area.
    state.introFiles = "nonempty";
    const withFile = await execute(operations.activityRead, { course_id: 2, module_id: 6 });
    assert.deepEqual(withFile.data.file_areas, [{ field: "introeditor[itemid]", state: "nonempty" }]);
    assert.deepEqual(await execute(operations.activityWrite, {
      course_id: 2, module_id: 6, conditions: [{ name: "completionrepliesenabled", value: true }],
      acknowledge_participant_count: 24, expected_digest: withFile.snapshot_digest,
    }), { ok: false, sent: false, status: 200, error: "moodle_activity_completion_files_present" });
    state.introFiles = "unavailable";
    const unverified = await execute(operations.activityRead, { course_id: 2, module_id: 6 });
    assert.deepEqual(await execute(operations.activityWrite, {
      course_id: 2, module_id: 6, conditions: [{ name: "completionrepliesenabled", value: true }],
      acknowledge_participant_count: 24, expected_digest: unverified.snapshot_digest,
    }), { ok: false, sent: false, status: 200, error: "moodle_activity_completion_files_unverified" });
    state.introFiles = "empty";
    assert.equal(posts.length, 4);

    // The course completion form carries every course completion condition.
    const courseRead = await execute(operations.courseRead, { course_id: 2 });
    assert.equal(courseRead.ok, true, JSON.stringify(courseRead));
    assert.equal(courseRead.data.course_id, "2");
    assert.equal(courseRead.data.module_id, undefined);
    assert.equal(courseRead.data.completion_available, true);
    assert.equal(courseRead.data.settings_locked, false);
    assert.deepEqual(courseRead.data.proof, {
      method: "native_form_read",
      route: "/course/completion.php",
      required_capability: "moodle/course:update",
      participant_count_capability: "moodle/course:viewparticipants",
      scope: "course_completion_only",
    });
    assert.deepEqual(courseRead.data.enrolled_participants, { count: 24, source: "participants_table" });
    assert.deepEqual(courseRead.data.conditions.map((entry) => entry.field), [
      "overall_aggregation", "criteria_activity[6]", "criteria_activity[7]", "activity_aggregation",
      "course_aggregation", "criteria_date", "criteria_duration", "criteria_duration_days",
      "criteria_unenrol", "criteria_grade", "criteria_grade_value", "criteria_self", "criteria_role[3]", "role_aggregation",
    ]);
    assert.deepEqual(conditionOf(courseRead, "criteria_activity[7]"), {
      field: "criteria_activity[7]", kind: "checkbox", value: true, label: "Quiz - Week 1 quiz",
    });
    assert.deepEqual(conditionOf(courseRead, "criteria_grade_value"), {
      field: "criteria_grade_value", kind: "text", value: "0.00000", governed_by: "criteria_grade", active: false,
    });
    // A prerequisite course names another course, so it is reported and never changed.
    assert.deepEqual(courseRead.data.read_only_conditions, [{ field: "criteria_course[]", values: [COURSE_SENTINEL] }]);
    assert.deepEqual(courseRead.data.completion_date.field, "criteria_date_value");
    assert.equal(JSON.stringify(courseRead).includes(LEARNER_NAME), false);

    // Moodle re-defaults an unused course completion date on every load, and that moving
    // default is not part of the digest a change is bound to.
    const courseSecond = await execute(operations.courseRead, { course_id: 2 });
    assert.equal(courseSecond.snapshot_digest, courseRead.snapshot_digest);

    // One POST of this form replaces the complete saved condition set, so the body carries
    // every condition, not only the ones this change names.
    const courseChanged = await execute(operations.courseWrite, {
      course_id: 2,
      conditions: [{ name: "criteria_activity[6]", value: true }, { name: "overall_aggregation", value: 2 }],
      acknowledge_participant_count: 24,
      expected_digest: courseRead.snapshot_digest,
    });
    assert.equal(courseChanged.ok, true, JSON.stringify(courseChanged));
    assert.equal(courseChanged.verification.status, "verified");
    assert.equal(courseChanged.data.replaces_condition_set, true);
    assert.equal(posts.length, 5);
    assert.equal(posts[4].path, "/course/completion.php");
    assert.deepEqual(posts[4].values.getAll("criteria_activity[6]"), ["0", "1"]);
    assert.deepEqual(posts[4].values.getAll("criteria_activity[7]"), ["0", "1"]);
    assert.equal(posts[4].values.get("overall_aggregation"), "2");
    assert.equal(posts[4].values.get("role_aggregation"), "1");
    assert.deepEqual(posts[4].values.getAll("criteria_course[]"), [COURSE_SENTINEL]);
    assert.deepEqual(courseChanged.data.changed_conditions, [
      { argument: "conditions", field: "criteria_activity[6]", value: true },
      { argument: "conditions", field: "overall_aggregation", value: "2" },
    ]);
    assert.equal(conditionOf(courseChanged, "criteria_activity[6]").value, true);
    assert.equal(conditionOf(courseChanged, "criteria_activity[7]").value, true);
    assert.equal(conditionOf(courseChanged, "overall_aggregation").value, "2");

    // A date whose own condition stays off is refused; switching the condition on carries it.
    assert.deepEqual(await execute(operations.courseWrite, {
      course_id: 2, completion_date: { year: 2026, month: 11, day: 20 },
      acknowledge_participant_count: 24, expected_digest: courseChanged.snapshot_digest,
    }), { ok: false, sent: false, status: 200, error: "moodle_course_completion_condition_refused" });
    const courseDated = await execute(operations.courseWrite, {
      course_id: 2, conditions: [{ name: "criteria_date", value: true }], completion_date: { year: 2026, month: 11, day: 20 },
      acknowledge_participant_count: 24, expected_digest: courseChanged.snapshot_digest,
    });
    assert.equal(courseDated.ok, true, JSON.stringify(courseDated));
    assert.equal(posts.length, 6);
    assert.equal(posts[5].values.get("criteria_date"), "1");
    assert.equal(posts[5].values.get("criteria_date_value[day]"), "20");
    assert.deepEqual(courseDated.data.completion_date.value, { year: 2026, month: 11, day: 20 });
    assert.equal(conditionOf(courseDated, "criteria_date").value, true);

    // Moodle locks the course completion settings once course completion data exists, and
    // unlocking them deletes it, so Morrow reports the lock and refuses the change.
    state.courseLocked = true;
    const courseLocked = await execute(operations.courseRead, { course_id: 2 });
    assert.equal(courseLocked.data.settings_locked, true);
    assert.deepEqual(await execute(operations.courseWrite, {
      course_id: 2, conditions: [{ name: "criteria_self", value: true }],
      acknowledge_participant_count: 24, expected_digest: courseLocked.snapshot_digest,
    }), { ok: false, sent: false, status: 200, error: "moodle_course_completion_locked" });
    state.courseLocked = false;
    assert.equal(posts.length, 6);

    // A lost response after dispatch is applied-or-unknown, and is never retried.
    const beforeLoss = await execute(operations.courseRead, { course_id: 2 });
    await loseNextPostResponse("/course/completion.php");
    const lost = await execute(operations.courseWrite, {
      course_id: 2, conditions: [{ name: "criteria_self", value: true }],
      acknowledge_participant_count: 24, expected_digest: beforeLoss.snapshot_digest,
    });
    assert.deepEqual(lost, {
      ok: false, sent: true, outcomeUnknown: true,
      verification: { schema: "morrow.browser-verification.v1", status: "unconfirmed", reason: "moodle_course_completion_write_unconfirmed" },
      error: "moodle_course_completion_write_unconfirmed",
    });
    assert.equal(posts.length, 7);
    assert.equal(state.course.criteria_self, true);

    // The bound course is the only target, and the executor refuses anything else.
    assert.deepEqual(await execute(operations.activityRead, { course_id: 3, module_id: 6 }), { ok: false, sent: false, error: "moodle_completion_arguments_invalid" });
    assert.deepEqual(await execute(operations.courseRead, { course_id: 2, module_id: 6 }), { ok: false, sent: false, error: "moodle_completion_arguments_invalid" });
    // Every change must state the participants it reaches and the form state it was reviewed against.
    for (const invalid of [
      { conditions: [{ name: "criteria_self", value: true }], expected_digest: beforeLoss.snapshot_digest },
      { conditions: [{ name: "criteria_self", value: true }], acknowledge_participant_count: 24 },
      { acknowledge_participant_count: 24, expected_digest: beforeLoss.snapshot_digest },
    ]) {
      assert.deepEqual(await execute(operations.courseWrite, { course_id: 2, ...invalid }), {
        ok: false, sent: false, error: "moodle_completion_arguments_invalid",
      }, JSON.stringify(invalid));
    }
    assert.deepEqual(await execute({ ...operations.activityRead, readOnly: false }, { course_id: 2, module_id: 6 }), { ok: false, sent: false, error: "moodle_operation_refused" });
    assert.equal(posts.length, 7);

    // Nothing in this executor opens an activity view page or the course page, which Moodle
    // can treat as a learner-visible view that records completion.
    assert.deepEqual(requests.filter((entry) => entry.includes("/mod/")), []);
    assert.deepEqual(requests.filter((entry) => entry.startsWith("GET /course/view.php")), ["GET /course/view.php?id=2"]);
  } finally {
    if (context) await context.close();
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the Moodle completion routes are wired and published exactly once", () => {
  const root = new URL("../..", import.meta.url);
  const catalog = JSON.parse(readFileSync(new URL("connector/extension/generated/moodle-browser-catalog.json", root), "utf8"));
  const worker = readFileSync(new URL("connector/extension/src/service-worker.js", root), "utf8");

  const keys = [
    "moodle.form.course.modedit.completion.read.v1",
    "moodle.form.course.modedit.completion.write.v1",
    "moodle.form.course.completion.read.v1",
    "moodle.form.course.completion.write.v1",
  ];
  const entries = keys.map((key) => catalog.operations.find((operation) => operation.key === key));
  assert.equal(entries.filter(Boolean).length, keys.length, "every routed completion key needs a catalog entry");
  assert.match(worker, /import \{ executeMoodleCompletionInPage \} from "\.\/moodle-completion-executor\.js";/);
  assert.match(worker, /func: executeMoodleCompletionInPage/);
  for (const key of keys) assert.ok(worker.includes(`"${key}"`), `${key} needs a service-worker route`);

  const [activityRead, activityWrite, courseRead, courseWrite] = entries;
  assert.equal(activityRead.readOnly, true);
  assert.deepEqual(Object.keys(activityRead.inputSchema.properties), ["course_id", "module_id"]);
  assert.match(activityRead.description, /moodle\/course:manageactivities capability at that exact activity/);
  assert.match(activityRead.description, /never opens the activity view page/);

  assert.equal(activityWrite.readOnly, false);
  assert.equal(activityWrite.reviewTool, "moodle_get_activity_completion");
  assert.deepEqual(activityWrite.inputSchema.required, ["course_id", "module_id", "acknowledge_participant_count", "expected_digest"]);
  assert.deepEqual(Object.keys(activityWrite.inputSchema.properties), [
    "course_id", "module_id", "completion_tracking", "conditions", "completion_expected", "acknowledge_participant_count", "expected_digest",
  ]);
  assert.match(activityWrite.description, /sends one POST/);
  assert.match(activityWrite.description, /acknowledge_participant_count states how many enrolled participants/);
  assert.match(activityWrite.description, /locked the completion settings/);
  assert.match(activityWrite.description, /applied but unconfirmed/);

  assert.equal(courseRead.readOnly, true);
  assert.deepEqual(Object.keys(courseRead.inputSchema.properties), ["course_id"]);
  assert.equal(courseWrite.readOnly, false);
  assert.equal(courseWrite.reviewTool, "moodle_get_course_completion");
  assert.deepEqual(courseWrite.inputSchema.required, ["course_id", "acknowledge_participant_count", "expected_digest"]);
  assert.match(courseWrite.description, /deletes every saved course completion criterion/);
  assert.match(courseWrite.description, /does not change the prerequisite courses/);
});

test("a completion change states its retroactive effect before it is granted, and a granted change carries its participant count", async () => {
  const root = new URL("../..", import.meta.url);
  const operationsList = JSON.parse(readFileSync(new URL("connector/extension/generated/moodle-browser-catalog.json", root), "utf8")).operations;
  const options = categoriesForBinding({ provider: "moodle" }, operationsList);
  const binding = {
    sourceBindingId: "moodle:course-2",
    provider: "moodle",
    origin: "https://moodle.example.edu",
    siteUrl: "https://moodle.example.edu",
    principalFingerprint: "a".repeat(64),
    courseId: "2",
    sessionGeneration: 1,
  };
  const catalogDigest = "b".repeat(64);

  for (const toolName of ["moodle_update_activity_completion", "moodle_update_course_completion"]) {
    const entry = options.find((option) => option.id === `action:moodle:${toolName}`);
    assert.ok(entry, toolName);
    assert.equal(entry.availability, "edit", toolName);
    assert.match(entry.description, /Moodle applies the new conditions to work learners have already done\.$/, toolName);
    assert.ok(entry.description.length <= 1_000, toolName);
  }

  // The connector derives the grant and packages/bridge-protocol checks the command against it, so
  // the acknowledged participant count has to be a granted field on both sides or a granted change
  // is rejected at the gateway.
  const permission = await createEditPermission({
    binding, catalogDigest, revision: 1, operations: operationsList,
    enabledCategories: ["action:moodle:moodle_update_activity_completion"],
  });
  assert.deepEqual(permission.rules, [{
    operationKey: "moodle.form.course.modedit.completion.write.v1",
    toolName: "moodle_update_activity_completion",
    allowedChangedFields: ["acknowledge_participant_count", "completion_expected", "completion_tracking", "conditions"],
  }]);
  const args = {
    course_id: 2, module_id: 6, conditions: [{ name: "completionview", value: true }],
    acknowledge_participant_count: 24, expected_digest: "d".repeat(64),
  };
  assert.deepEqual(changedFields(args), ["acknowledge_participant_count", "conditions"]);
  assert.equal(matchesBridgeEditPermission(
    { sourceBindingId: binding.sourceBindingId, provider: "moodle", courseId: binding.courseId, runtimeVerified: true, editPermission: permission },
    { provider: "moodle", catalogDigest, operationKey: "moodle.form.course.modedit.completion.write.v1", toolName: "moodle_update_activity_completion", arguments: args },
  ), true);
});
