import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { executeMoodleCourseSettingsInPage } from "../../connector/extension/src/moodle-course-settings-executor.js";

const ANCHOR_SESSION = "moodle-session-a";
const FOREIGN_SESSION = "moodle-session-b";
const TAG_SENTINEL = "_qf__force_multiselect_submission";
const LEARNER_NAME = "Ada Lovelace";
const LEARNER_GRADE = "87.5";

const operations = Object.freeze({
  read: { key: "moodle.form.course.edit.settings.read.v1", toolName: "moodle_get_course_settings", provider: "moodle", readOnly: true },
  update: { key: "moodle.form.course.edit.settings.write.v1", toolName: "moodle_update_course_settings", provider: "moodle", readOnly: false },
  format: { key: "moodle.form.course.edit.format.write.v1", toolName: "moodle_change_course_format", provider: "moodle", readOnly: false },
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

function range(from, to, step = 1) {
  const values = [];
  for (let value = from; value <= to; value += step) values.push(String(value));
  return values;
}

function options(entries, current) {
  return entries.map(([value, label]) => `<option value="${value}"${value === current ? " selected" : ""}>${label}</option>`).join("");
}

function select(name, values, current, extra = "") {
  const entries = values.map((value) => (Array.isArray(value) ? value : [value, value === "" ? "None" : `Option ${value}`]));
  return `<select name="${name}"${extra}>${options(entries, current)}</select>`;
}

// Moodle's date_time_selector renders five selects, and its minute control steps
// by five. An optional selector adds one checkbox that the browser submits only
// when it is switched on.
function dateGroup(field, value, optional = false) {
  const toggle = optional ? `<input type="checkbox" name="${field}[enabled]" value="1"${value.enabled ? " checked" : ""}>` : "";
  const parts = [
    ["year", range(2024, 2030)],
    ["month", range(1, 12)],
    ["day", range(1, 31)],
    ["hour", range(0, 23)],
    ["minute", range(0, 55, 5)],
  ];
  return `${toggle}${parts.map(([part, values]) => select(`${field}[${part}]`, values, value[part])).join("")}`;
}

function courseForm(state, action, sesskey, drafts) {
  const course = state.course;
  const name = state.frozenFullName
    ? `<input type="hidden" name="fullname" value="${course.fullname}"><span class="form-control-static">${course.fullname}</span>`
    : `<input type="text" name="fullname" value="${course.fullname}">`;
  const legacyFiles = state.legacyFilesOffered ? select("legacyfiles", [["0", "Disabled"], ["2", "Enabled"]], course.legacyfiles) : "";
  const formatOptions = Object.entries(course.formatOptions)
    .map(([field, value]) => select(field, state.formatOptionValues[field], value))
    .join("");
  const tagOptions = [...new Set([...state.tagsAvailable, ...course.tags])]
    .map((tag) => `<option value="${tag}"${course.tags.includes(tag) ? " selected" : ""}>${tag}</option>`).join("");
  return `<!doctype html><html><body class="path-course course-2">
    <form method="get" action="/search/index.php"><input type="text" name="q" value=""></form>
    <form method="post" action="${action}" id="id_editcourse">
      <input type="hidden" name="id" value="2">
      <input type="hidden" name="sesskey" value="${sesskey}">
      <input type="hidden" name="_qf__course_editcourse_form" value="1">
      <input type="hidden" name="returnto" value="0">
      <input type="hidden" name="returnurl" value="/course/view.php?id=2">
      <fieldset id="id_general">
        <input type="hidden" name="mform_isexpanded_id_general" value="1">
        ${name}
        <input type="text" name="shortname" value="${course.shortname}">
        ${select("category", [["3", "Nursing"], ["4", "Allied health"]], course.category)}
        ${select("visible", [["1", "Show"], ["0", "Hide"]], course.visible)}
        ${select("downloadcontent", [["0", "No"], ["1", "Yes"]], course.downloadcontent)}
        ${dateGroup("startdate", course.startdate)}
        ${dateGroup("enddate", course.enddate, true)}
        ${select("relativedatesmode", [["0", "No"], ["1", "Yes"]], course.relativedatesmode)}
        <input type="text" name="idnumber" value="${course.idnumber}">
      </fieldset>
      <fieldset id="id_descriptionhdr">
        <textarea name="summary_editor[text]">${course.summary}</textarea>
        <input type="hidden" name="summary_editor[format]" value="1">
        <input type="hidden" name="summary_editor[itemid]" value="${drafts.summary}">
        <div data-fieldtype="filemanager"><input type="hidden" name="overviewfiles_filemanager" value="${drafts.image}"></div>
      </fieldset>
      <fieldset id="id_courseformathdr">
        <input type="hidden" name="mform_isexpanded_id_courseformathdr" value="1">
        ${select("format", state.formatAvailable, course.format)}
        <input type="hidden" name="addcourseformatoptionshere">
        ${formatOptions}
      </fieldset>
      <fieldset id="id_appearancehdr">
        ${select("theme", [["", "Do not force"], ["boost", "Boost"]], course.theme)}
        ${select("lang", [["", "Do not force"], ["en", "English"]], course.lang)}
        ${select("calendartype", [["gregorian", "Gregorian"], ["hijri", "Hijri"]], course.calendartype)}
        ${select("newsitems", [["0", "0"], ["5", "5"], ["10", "10"]], course.newsitems)}
        ${select("showgrades", [["0", "No"], ["1", "Yes"]], course.showgrades)}
        ${select("showreports", [["0", "No"], ["1", "Yes"]], course.showreports)}
        ${select("showactivitydates", [["0", "No"], ["1", "Yes"]], course.showactivitydates)}
      </fieldset>
      <fieldset id="id_filehdr">
        ${legacyFiles}
        ${select("maxbytes", [["2097152", "2 MB"], ["5242880", "5 MB"]], course.maxbytes)}
        ${select("pdfexportfont", [["", "Site default"], ["freesans", "FreeSans"]], course.pdfexportfont)}
      </fieldset>
      <fieldset id="id_completionhdr">
        ${select("enablecompletion", [["0", "No"], ["1", "Yes"]], course.enablecompletion)}
        ${select("showcompletionconditions", [["0", "No"], ["1", "Yes"]], course.showcompletionconditions)}
      </fieldset>
      <fieldset id="id_groups">
        ${select("groupmode", [["0", "No groups"], ["1", "Separate groups"], ["2", "Visible groups"]], course.groupmode)}
        ${select("groupmodeforce", [["0", "No"], ["1", "Yes"]], course.groupmodeforce)}
        ${select("defaultgroupingid", [["0", "None"], ["7", "Clinical groups"]], course.defaultgroupingid)}
      </fieldset>
      <fieldset id="id_tagshdr">
        <input type="hidden" name="tags[]" value="${TAG_SENTINEL}">
        <select name="tags[]" multiple data-fieldtype="autocomplete">${tagOptions}</select>
      </fieldset>
      <fieldset id="id_aitoolshdr">
        ${select("enableaitools", [["0", "No"], ["1", "Yes"]], course.enableaitools)}
      </fieldset>
      <fieldset id="id_customfield_general">
        <input type="text" name="customfield_program" value="${course.customFields.program}">
        ${select("customfield_delivery", [["online", "Online"], ["campus", "On campus"]], course.customFields.delivery)}
        <div data-fieldtype="editor">
          <textarea name="customfield_notes_editor[text]">${course.customFields.notes}</textarea>
          <input type="hidden" name="customfield_notes_editor[format]" value="1">
          <input type="hidden" name="customfield_notes_editor[itemid]" value="${drafts.notes}">
        </div>
      </fieldset>
      <input type="submit" name="saveandreturn" value="Save and return">
      <input type="submit" name="saveanddisplay" value="Save and display">
      <input type="submit" name="cancel" value="Cancel">
    </form>
    <table class="generaltable"><tbody><tr><td>${LEARNER_NAME}</td><td>${LEARNER_GRADE}</td></tr></tbody></table>
  </body></html>`;
}

function readBody(request) {
  return new Promise((resolve) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

test("Moodle course settings executor changes one bounded group per POST and reports a format change with its complete course state", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morrow-moodle-course-settings-"));
  const key = join(directory, "key.pem");
  const certificate = join(directory, "certificate.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", certificate], { stdio: "ignore" });

  const state = {
    course: {
      fullname: "Nursing Fundamentals",
      shortname: "NURS-101",
      idnumber: "",
      category: "3",
      visible: "1",
      downloadcontent: "0",
      startdate: { year: "2026", month: "9", day: "7", hour: "0", minute: "0" },
      enddate: { enabled: false, year: "2027", month: "9", day: "7", hour: "0", minute: "0" },
      relativedatesmode: "0",
      summary: "<p>Care of the adult patient.</p>",
      format: "topics",
      formatOptions: { hiddensections: "1", coursedisplay: "0" },
      theme: "",
      lang: "",
      calendartype: "gregorian",
      newsitems: "5",
      showgrades: "1",
      showreports: "0",
      showactivitydates: "1",
      legacyfiles: "0",
      maxbytes: "2097152",
      pdfexportfont: "",
      enablecompletion: "1",
      showcompletionconditions: "1",
      groupmode: "0",
      groupmodeforce: "0",
      defaultgroupingid: "0",
      enableaitools: "1",
      tags: ["Nursing"],
      customFields: { program: "Practical Nursing", delivery: "online", notes: "<p>Reviewed each term.</p>" },
    },
    formatAvailable: [["topics", "Custom sections"], ["weeks", "Weekly sections"], ["singleactivity", "Single activity format"]],
    formatOptionValues: {
      hiddensections: [["0", "Shown in collapsed form"], ["1", "Made completely invisible"]],
      coursedisplay: [["0", "Show all sections on one page"], ["1", "Show one section per page"]],
      automaticenddate: [["0", "No"], ["1", "Yes"]],
    },
    tagsAvailable: ["Nursing", "Semester 1", "Clinical"],
    legacyFilesOffered: false,
    frozenFullName: false,
    imageFiles: "empty",
    summaryFiles: "empty",
    session: ANCHOR_SESSION,
    sessionQueue: [],
    layoutMoved: false,
    stateAvailable: true,
  };
  const posts = [];
  const requests = [];
  const draftStates = new Map();
  let draftCounter = 900;
  let origin = "";

  const courseStatePayload = () => JSON.stringify({
    course: { id: 2, fullname: state.course.fullname, format: state.course.format, sesskey: ANCHOR_SESSION },
    section: [
      { id: 10, number: 0, title: "General" },
      { id: 11, number: 1, title: state.layoutMoved ? "Week 1" : "Topic 1" },
      { id: 12, number: 2, title: state.layoutMoved ? "Week 2" : "Topic 2" },
    ],
    cm: [
      { id: 21, sectionid: 11, name: "Orientation page", visible: 1 },
      { id: 22, sectionid: state.layoutMoved ? 12 : 11, name: "Skills lab", visible: 1 },
    ],
  });

  const server = createServer({ key: readFileSync(key), cert: readFileSync(certificate) }, async (request, response) => {
    const url = new URL(request.url || "/", origin || "https://127.0.0.1");
    requests.push(`${request.method} ${url.pathname}${url.search}`);
    if (url.pathname === "/course/view.php") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<!doctype html><body class="path-course course-2"><script>var M = {}; M.cfg = ${JSON.stringify({ wwwroot: origin, sesskey: ANCHOR_SESSION, userId: 3, courseId: 2 })};</script></body>`);
      return;
    }
    if (request.method === "GET" && url.pathname === "/course/edit.php" && url.search === "?id=2") {
      // A native draft item id is new on every load of the same form.
      const drafts = { summary: String(++draftCounter), image: String(++draftCounter), notes: String(++draftCounter) };
      draftStates.set(drafts.summary, state.summaryFiles);
      draftStates.set(drafts.image, state.imageFiles);
      draftStates.set(drafts.notes, "empty");
      const sesskey = state.sessionQueue.shift() || state.session;
      response.writeHead(200, { "content-type": "text/html" });
      response.end(courseForm(state, "/course/edit.php?id=2", sesskey, drafts));
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
        ? JSON.stringify({ filecount: 1, list: [{ filename: "course-image.jpg", filepath: "/", size: 4096 }], tree: { children: [] } })
        : JSON.stringify({ filecount: 0, list: [], tree: { children: [] } }));
      return;
    }
    if (request.method === "POST" && url.pathname === "/lib/ajax/service.php") {
      const call = JSON.parse(await readBody(request))[0];
      assert.equal(call?.methodname, "core_courseformat_get_state");
      assert.equal(url.searchParams.get("info"), "core_courseformat_get_state");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(state.stateAvailable
        ? JSON.stringify([{ data: courseStatePayload() }])
        : JSON.stringify([{ exception: { errorcode: "nopermissions" } }]));
      return;
    }
    if (request.method === "POST" && url.pathname === "/course/edit.php") {
      const values = new URLSearchParams(await readBody(request));
      posts.push({ query: url.search, values });
      assert.equal(values.get("sesskey"), ANCHOR_SESSION);
      assert.equal(values.get("saveanddisplay"), "Save and display");
      assert.equal(values.get("saveandreturn"), null);
      const course = state.course;
      const text = (name, fallback) => (values.get(name) === null ? fallback : values.get(name));
      course.fullname = text("fullname", course.fullname);
      course.shortname = text("shortname", course.shortname);
      course.idnumber = text("idnumber", course.idnumber);
      course.summary = text("summary_editor[text]", course.summary);
      for (const field of ["category", "visible", "downloadcontent", "relativedatesmode", "theme", "lang", "calendartype",
        "newsitems", "showgrades", "showreports", "showactivitydates", "legacyfiles", "maxbytes", "pdfexportfont",
        "enablecompletion", "showcompletionconditions", "groupmode", "groupmodeforce", "defaultgroupingid", "enableaitools"]) {
        course[field] = text(field, course[field]);
      }
      for (const part of ["year", "month", "day", "hour", "minute"]) {
        course.startdate[part] = text(`startdate[${part}]`, course.startdate[part]);
        course.enddate[part] = text(`enddate[${part}]`, course.enddate[part]);
      }
      course.enddate.enabled = values.get("enddate[enabled]") === "1";
      course.tags = values.getAll("tags[]").filter((tag) => tag !== TAG_SENTINEL);
      for (const [name, value] of values.entries()) {
        if (name.startsWith("customfield_")) course.customFields[name.slice("customfield_".length)] = value;
      }
      const format = text("format", course.format);
      if (format !== course.format) {
        course.format = format;
        // A format change replaces the previous format's options with the new
        // format's defaults, and moves every section and activity with it.
        course.formatOptions = format === "weeks"
          ? { hiddensections: "0", coursedisplay: "0", automaticenddate: "1" }
          : { hiddensections: "1", coursedisplay: "0" };
        state.layoutMoved = format === "weeks";
      } else {
        for (const field of Object.keys(course.formatOptions)) course.formatOptions[field] = text(field, course.formatOptions[field]);
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
    if (!address || typeof address === "string") throw new Error("course settings test server did not bind");
    origin = `https://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
    context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    await page.goto(`${origin}/course/view.php?id=2`);
    const binding = { origin, siteUrl: `${origin}/`, principalId: "3", courseId: "2" };
    const execute = (operation, argumentsValue) => page.evaluate(
      executeMoodleCourseSettingsInPage,
      JSON.stringify({ mode: "execute", operation, arguments: argumentsValue, binding, expiresAt: Date.now() + 60_000 }),
    );
    const settingOf = (result, argument) => result.data.settings.find((entry) => entry.argument === argument);
    const loseNextPostResponse = () => page.evaluate(() => {
      const nativeFetch = globalThis.fetch;
      globalThis.fetch = async (...parameters) => {
        const response = await nativeFetch(...parameters);
        const request = new URL(parameters[0], globalThis.location.href);
        if (String(parameters[1]?.method || "GET").toUpperCase() === "POST" && request.pathname === "/course/edit.php") {
          globalThis.fetch = nativeFetch;
          throw new TypeError("post response lost after dispatch");
        }
        return response;
      };
    });

    // A form that does not carry the signed-in session key is refused before anything is sent.
    state.sessionQueue.push(FOREIGN_SESSION);
    assert.deepEqual(await execute(operations.read, { course_id: 2 }), { ok: false, sent: false, status: 200, error: "moodle_form_session_mismatch" });
    assert.equal(posts.length, 0);

    const read = await execute(operations.read, { course_id: 2 });
    assert.equal(read.ok, true, JSON.stringify(read));
    assert.equal(read.data.course_id, "2");
    assert.deepEqual(read.data.proof, {
      method: "native_form_read", route: "/course/edit.php", required_capability: "moodle/course:update", scope: "course_settings_only",
    });
    assert.deepEqual(settingOf(read, "full_name"), { group: "general", argument: "full_name", field: "fullname", value: "Nursing Fundamentals" });
    assert.deepEqual(settingOf(read, "start_date").value, { year: 2026, month: 9, day: 7, hour: 0, minute: 0 });
    assert.equal(settingOf(read, "end_date").value, null);
    assert.deepEqual(settingOf(read, "group_mode").available, [
      { value: "0", label: "No groups" }, { value: "1", label: "Separate groups" }, { value: "2", label: "Visible groups" },
    ]);
    // Legacy course files are not offered by this form, so the read does not claim them.
    assert.equal(settingOf(read, "legacy_files"), undefined);
    assert.deepEqual(read.data.settings.map((entry) => entry.argument), [
      "full_name", "short_name", "id_number", "start_date", "end_date", "download_content", "relative_dates_mode",
      "theme", "language", "calendar_type", "announcements", "show_grades", "show_activity_reports", "show_activity_dates",
      "maximum_upload_size", "pdf_export_font", "completion_tracking", "show_completion_conditions",
      "group_mode", "force_group_mode", "default_grouping", "ai_tools",
    ]);
    assert.equal(read.data.format.value, "topics");
    assert.deepEqual(read.data.format_options.map((entry) => entry.field), ["hiddensections", "coursedisplay"]);
    assert.deepEqual(read.data.tags, { selected: ["Nursing"], available: ["Nursing", "Semester 1", "Clinical"] });
    // A long-text custom field carries its own draft area. The text is a custom field;
    // the draft item id is a file area, and it never reaches a result.
    assert.deepEqual(read.data.custom_fields.map((entry) => ({ name: entry.name, value: entry.value })), [
      { name: "program", value: "Practical Nursing" },
      { name: "delivery", value: "online" },
      { name: "notes_editor[text]", value: "<p>Reviewed each term.</p>" },
      { name: "notes_editor[format]", value: "1" },
    ]);
    // A setting this route reports but never changes carries the label the native control shows.
    assert.deepEqual(read.data.read_only_settings, {
      visible: { value: "1", label: "Show" }, category: { value: "3", label: "Nursing" },
    });
    assert.deepEqual(read.data.file_areas, [
      { field: "overviewfiles_filemanager", state: "empty" },
      { field: "summary_editor[itemid]", state: "empty" },
      { field: "customfield_notes_editor[itemid]", state: "empty" },
    ]);
    // The session key, the draft item ids and the learner-shaped page noise never leave the browser.
    const readText = JSON.stringify(read);
    assert.equal(readText.includes(ANCHOR_SESSION), false);
    assert.equal(readText.includes(LEARNER_NAME), false);
    assert.equal(readText.includes(LEARNER_GRADE), false);
    for (const field of ["summary_editor[itemid]", "overviewfiles_filemanager", "customfield_notes_editor[itemid]"]) {
      const entry = read.data.protected_settings.find((candidate) => candidate.name === field);
      assert.deepEqual(entry, { name: field, value: "file_area:empty" }, field);
    }
    assert.equal(read.data.protected_settings.some((entry) => entry.name === "sesskey"), false);
    assert.equal(read.data.protected_settings.some((entry) => entry.name === "_qf__course_editcourse_form"), false);
    assert.deepEqual(read.data.protected_setting_names, [...new Set(read.data.protected_settings.map((entry) => entry.name))].sort());
    assert.equal(read.data.protected_settings_digest, digestOf({
      courseId: "2", entries: read.data.protected_settings.map((entry) => [entry.name, entry.value]),
    }));

    // The same form, loaded again with new draft item ids, is the same digest.
    const second = await execute(operations.read, { course_id: 2 });
    assert.equal(second.snapshot_digest, read.snapshot_digest);
    assert.equal(second.data.protected_settings_digest, read.data.protected_settings_digest);

    // One reviewed change group, one POST, every other control carried through.
    const changed = await execute(operations.update, {
      course_id: 2,
      full_name: "Nursing Fundamentals I",
      id_number: "NURS-101-2026",
      end_date: { year: 2027, month: 6, day: 30, hour: 17, minute: 0 },
      expected_digest: read.snapshot_digest,
    });
    assert.equal(changed.ok, true, JSON.stringify(changed));
    assert.equal(changed.verification.status, "verified");
    assert.equal(posts.length, 1);
    assert.equal(posts[0].query, "?id=2");
    assert.equal(posts[0].values.get("fullname"), "Nursing Fundamentals I");
    assert.equal(posts[0].values.get("idnumber"), "NURS-101-2026");
    assert.equal(posts[0].values.get("enddate[enabled]"), "1");
    assert.equal(posts[0].values.get("enddate[day]"), "30");
    assert.equal(posts[0].values.get("shortname"), "NURS-101");
    assert.equal(posts[0].values.get("format"), "topics");
    assert.equal(posts[0].values.get("summary_editor[text]"), "<p>Care of the adult patient.</p>");
    assert.deepEqual(posts[0].values.getAll("tags[]"), [TAG_SENTINEL, "Nursing"]);
    assert.deepEqual(changed.data.changed_settings, [
      { argument: "full_name", field: "fullname", value: "Nursing Fundamentals I" },
      { argument: "id_number", field: "idnumber", value: "NURS-101-2026" },
      { argument: "end_date", field: "enddate", value: { year: 2027, month: 6, day: 30, hour: 17, minute: 0 } },
    ]);

    // Every setting this change did not name comes back exactly as it was.
    const afterChange = await execute(operations.read, { course_id: 2 });
    const unchangedArguments = read.data.settings
      .filter((entry) => !["full_name", "id_number", "end_date"].includes(entry.argument))
      .map((entry) => entry.argument);
    for (const argument of unchangedArguments) {
      assert.deepEqual(settingOf(afterChange, argument), settingOf(read, argument), argument);
    }
    assert.deepEqual(afterChange.data.format, read.data.format);
    assert.deepEqual(afterChange.data.format_options, read.data.format_options);
    assert.deepEqual(afterChange.data.tags, read.data.tags);
    assert.deepEqual(afterChange.data.custom_fields, read.data.custom_fields);
    assert.deepEqual(afterChange.data.read_only_settings, read.data.read_only_settings);

    // The reviewed digest binds one exact form state, so a replay refuses before sending anything.
    assert.deepEqual(await execute(operations.update, { course_id: 2, full_name: "Must not save", expected_digest: read.snapshot_digest }), {
      ok: false, sent: false, status: 200, error: "moodle_expected_digest_mismatch",
    });
    assert.equal(posts.length, 1);

    // A value the loaded control does not offer, and a control the form has frozen, are refused before sending.
    assert.deepEqual(await execute(operations.update, { course_id: 2, group_mode: 9, expected_digest: afterChange.snapshot_digest }), {
      ok: false, sent: false, status: 200, error: "moodle_course_setting_refused",
    });
    assert.deepEqual(await execute(operations.update, { course_id: 2, legacy_files: 2, expected_digest: afterChange.snapshot_digest }), {
      ok: false, sent: false, status: 200, error: "moodle_course_setting_refused",
    });
    state.frozenFullName = true;
    const frozen = await execute(operations.read, { course_id: 2 });
    assert.deepEqual(await execute(operations.update, { course_id: 2, full_name: "Must not save", expected_digest: frozen.snapshot_digest }), {
      ok: false, sent: false, status: 200, error: "moodle_course_setting_refused",
    });
    state.frozenFullName = false;
    assert.equal(posts.length, 1);

    // A tag the native control does not offer is refused; Morrow does not create one.
    assert.deepEqual(await execute(operations.update, { course_id: 2, tags: ["Pharmacology"], expected_digest: afterChange.snapshot_digest }), {
      ok: false, sent: false, status: 200, error: "moodle_course_tag_refused",
    });
    // A course custom field and a format option are only whatever this form renders.
    assert.deepEqual(await execute(operations.update, { course_id: 2, custom_fields: [{ name: "cohort", value: "2026" }], expected_digest: afterChange.snapshot_digest }), {
      ok: false, sent: false, status: 200, error: "moodle_course_custom_field_refused",
    });
    assert.deepEqual(await execute(operations.update, { course_id: 2, format_options: [{ name: "numsections", value: 12 }], expected_digest: afterChange.snapshot_digest }), {
      ok: false, sent: false, status: 200, error: "moodle_course_setting_refused",
    });
    assert.equal(posts.length, 1);

    // Tags, course custom fields and the options of the current format each change in one POST.
    const tagged = await execute(operations.update, {
      course_id: 2, tags: ["Nursing", "Clinical"], custom_fields: [{ name: "program", value: "Registered Nursing" }, { name: "delivery", value: "campus" }],
      expected_digest: afterChange.snapshot_digest,
    });
    assert.equal(tagged.ok, true, JSON.stringify(tagged));
    assert.equal(posts.length, 2);
    assert.deepEqual(posts[1].values.getAll("tags[]"), [TAG_SENTINEL, "Nursing", "Clinical"]);
    assert.equal(posts[1].values.get("customfield_program"), "Registered Nursing");
    assert.deepEqual(tagged.data.tags.selected, ["Nursing", "Clinical"]);
    assert.deepEqual(tagged.data.custom_fields.map((entry) => entry.value), ["Registered Nursing", "campus", "<p>Reviewed each term.</p>", "1"]);

    const optioned = await execute(operations.update, {
      course_id: 2, format_options: [{ name: "hiddensections", value: 0 }], expected_digest: tagged.snapshot_digest,
    });
    assert.equal(optioned.ok, true, JSON.stringify(optioned));
    assert.equal(posts.length, 3);
    assert.equal(posts[2].values.get("hiddensections"), "0");
    assert.equal(posts[2].values.get("format"), "topics");
    assert.deepEqual(optioned.data.changed_settings, [{ argument: "format_options", field: "hiddensections", value: "0" }]);

    // The course settings write cannot reach the format, the visibility, the summary or the category.
    for (const invalid of [{ format: "weeks" }, { visible: 0 }, { summary: "Rewritten" }, { category_id: 4 }, {}]) {
      assert.deepEqual(await execute(operations.update, { course_id: 2, ...invalid, expected_digest: optioned.snapshot_digest }), {
        ok: false, sent: false, error: "moodle_course_settings_arguments_invalid",
      }, JSON.stringify(invalid));
    }
    assert.equal(posts.length, 3);

    // A native file area that is not empty, or that cannot be proved empty, stops the change
    // before anything is sent, because one POST of this form would replace that area.
    state.imageFiles = "nonempty";
    const withImage = await execute(operations.read, { course_id: 2 });
    assert.deepEqual(withImage.data.file_areas.find((area) => area.field === "overviewfiles_filemanager"), {
      field: "overviewfiles_filemanager", state: "nonempty",
    });
    assert.deepEqual(await execute(operations.update, { course_id: 2, short_name: "NURS-101A", expected_digest: withImage.snapshot_digest }), {
      ok: false, sent: false, status: 200, error: "moodle_course_image_files_present",
    });
    assert.deepEqual(await execute(operations.format, {
      course_id: 2, format: "weeks", acknowledge_layout_change: true, expected_digest: withImage.snapshot_digest,
    }), { ok: false, sent: false, status: 200, error: "moodle_course_image_files_present" });
    state.imageFiles = "unavailable";
    const unverified = await execute(operations.read, { course_id: 2 });
    assert.deepEqual(unverified.data.file_areas.find((area) => area.field === "overviewfiles_filemanager"), {
      field: "overviewfiles_filemanager", state: "unverified",
    });
    assert.deepEqual(await execute(operations.update, { course_id: 2, short_name: "NURS-101A", expected_digest: unverified.snapshot_digest }), {
      ok: false, sent: false, status: 200, error: "moodle_course_files_unverified",
    });
    state.imageFiles = "empty";
    assert.equal(posts.length, 3);

    // The format change states its own wider effect, refuses a format the form does not offer,
    // and refuses the format the course already uses.
    const beforeFormat = await execute(operations.read, { course_id: 2 });
    assert.deepEqual(await execute(operations.format, { course_id: 2, format: "weeks", expected_digest: beforeFormat.snapshot_digest }), {
      ok: false, sent: false, error: "moodle_course_settings_arguments_invalid",
    });
    assert.deepEqual(await execute(operations.format, { course_id: 2, format: "weeks", acknowledge_layout_change: false, expected_digest: beforeFormat.snapshot_digest }), {
      ok: false, sent: false, error: "moodle_course_format_approval_required",
    });
    assert.deepEqual(await execute(operations.format, { course_id: 2, format: "tiles", acknowledge_layout_change: true, expected_digest: beforeFormat.snapshot_digest }), {
      ok: false, sent: false, status: 200, error: "moodle_course_format_refused",
    });
    assert.deepEqual(await execute(operations.format, { course_id: 2, format: "topics", acknowledge_layout_change: true, expected_digest: beforeFormat.snapshot_digest }), {
      ok: false, sent: false, status: 200, error: "moodle_course_format_unchanged",
    });
    assert.equal(posts.length, 3);

    // A complete course state cannot be read, so the change never starts.
    state.stateAvailable = false;
    assert.deepEqual(await execute(operations.format, { course_id: 2, format: "weeks", acknowledge_layout_change: true, expected_digest: beforeFormat.snapshot_digest }), {
      ok: false, sent: false, status: 200, error: "moodle_course_state_unavailable",
    });
    state.stateAvailable = true;
    assert.equal(posts.length, 3);

    const reformatted = await execute(operations.format, {
      course_id: 2, format: "weeks", acknowledge_layout_change: true, expected_digest: beforeFormat.snapshot_digest,
    });
    assert.equal(reformatted.ok, true, JSON.stringify(reformatted));
    assert.equal(reformatted.verification.status, "verified");
    assert.equal(posts.length, 4);
    assert.equal(posts[3].values.get("format"), "weeks");
    assert.equal(posts[3].values.get("fullname"), "Nursing Fundamentals I");
    assert.equal(reformatted.data.format_before, "topics");
    assert.equal(reformatted.data.format_after, "weeks");
    assert.equal(reformatted.data.course_state_changed, true);
    assert.deepEqual(reformatted.data.course_state_before.sections.map((section) => section.title), ["General", "Topic 1", "Topic 2"]);
    assert.deepEqual(reformatted.data.course_state_after.sections.map((section) => section.title), ["General", "Week 1", "Week 2"]);
    assert.deepEqual(reformatted.data.course_state_before.activities.map((activity) => activity.sectionid), [11, 11]);
    assert.deepEqual(reformatted.data.course_state_after.activities.map((activity) => activity.sectionid), [11, 12]);
    // The state reader returns the session key; it never reaches a result.
    assert.equal(JSON.stringify(reformatted).includes(ANCHOR_SESSION), false);
    // The new format brought its own options, and the course identity is unchanged.
    assert.deepEqual(reformatted.data.format_options.map((entry) => entry.field), ["hiddensections", "coursedisplay", "automaticenddate"]);
    assert.equal(settingOf(reformatted, "full_name").value, "Nursing Fundamentals I");
    assert.equal(settingOf(reformatted, "short_name").value, "NURS-101");
    assert.deepEqual(reformatted.data.read_only_settings, {
      visible: { value: "1", label: "Show" }, category: { value: "3", label: "Nursing" },
    });

    // A lost response after dispatch is applied-or-unknown, and is never retried.
    const beforeLoss = await execute(operations.read, { course_id: 2 });
    await loseNextPostResponse();
    const lost = await execute(operations.update, { course_id: 2, short_name: "NURS-102", expected_digest: beforeLoss.snapshot_digest });
    assert.deepEqual(lost, {
      ok: false, sent: true, outcomeUnknown: true,
      verification: { schema: "morrow.browser-verification.v1", status: "unconfirmed", reason: "moodle_course_settings_write_unconfirmed" },
      error: "moodle_course_settings_write_unconfirmed",
    });
    assert.equal(posts.length, 5);
    assert.equal(state.course.shortname, "NURS-102");

    // The bound course is the only target, and the executor refuses anything else.
    assert.deepEqual(await execute(operations.read, { course_id: 3 }), { ok: false, sent: false, error: "moodle_course_settings_arguments_invalid" });
    assert.deepEqual(await execute({ ...operations.read, readOnly: false }, { course_id: 2 }), { ok: false, sent: false, error: "moodle_operation_refused" });

    // Nothing in this executor loads the course view page, which Moodle treats as effectful.
    assert.deepEqual(requests.filter((entry) => entry.startsWith("GET /course/view.php")), ["GET /course/view.php?id=2"]);
  } finally {
    if (context) await context.close();
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the Moodle course settings route is wired and published exactly once", () => {
  const root = new URL("../..", import.meta.url);
  const catalog = JSON.parse(readFileSync(new URL("connector/extension/generated/moodle-browser-catalog.json", root), "utf8"));
  const worker = readFileSync(new URL("connector/extension/src/service-worker.js", root), "utf8");
  const policy = readFileSync(new URL("connector/extension/src/edit-policy.js", root), "utf8");

  const keys = ["moodle.form.course.edit.settings.read.v1", "moodle.form.course.edit.settings.write.v1", "moodle.form.course.edit.format.write.v1"];
  const entries = keys.map((key) => catalog.operations.find((operation) => operation.key === key));
  assert.equal(entries.filter(Boolean).length, keys.length, "every routed course settings key needs a catalog entry");
  assert.match(worker, /import \{ executeMoodleCourseSettingsInPage \} from "\.\/moodle-course-settings-executor\.js";/);
  for (const key of keys) assert.ok(worker.includes(`"${key}"`), `${key} needs a service-worker route`);

  const read = entries[0];
  assert.equal(read.readOnly, true);
  assert.deepEqual(Object.keys(read.inputSchema.properties), ["course_id"]);
  assert.match(read.description, /moodle\/course:update capability at that exact course context/);
  assert.match(read.description, /moodle_show_course and moodle_hide_course/);

  const update = entries[1];
  assert.equal(update.readOnly, false);
  assert.equal(update.reviewTool, "moodle_get_course_settings");
  assert.deepEqual(update.inputSchema.required, ["course_id", "expected_digest"]);
  assert.deepEqual(Object.keys(update.inputSchema.properties), [
    "course_id", "full_name", "short_name", "id_number", "start_date", "end_date", "download_content", "relative_dates_mode",
    "theme", "language", "calendar_type", "announcements", "show_grades", "show_activity_reports", "show_activity_dates",
    "legacy_files", "maximum_upload_size", "pdf_export_font", "completion_tracking", "show_completion_conditions",
    "group_mode", "force_group_mode", "default_grouping", "ai_tools", "format_options", "tags", "custom_fields", "expected_digest",
  ]);
  assert.match(update.description, /sends one POST/);
  assert.match(update.description, /is not empty or cannot be proved empty/);
  assert.match(update.description, /applied but unconfirmed/);

  const format = entries[2];
  assert.equal(format.readOnly, false);
  assert.equal(format.reviewTool, "moodle_get_course_settings");
  assert.deepEqual(format.inputSchema.required, ["course_id", "format", "acknowledge_layout_change", "expected_digest"]);
  assert.deepEqual(format.inputSchema.properties.acknowledge_layout_change.enum, [true]);
  assert.match(format.description, /complete course state before the change/);
  assert.match(format.description, /Morrow cannot put the previous layout back/);

  // The format change is grouped and described as a whole-course action before it is granted.
  assert.match(policy, /const MOODLE_COURSE_FORMAT_TOOL = "moodle_change_course_format";/);
  assert.match(policy, /where every section and every activity in the course appears/);
});
