import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { executeMoodleBigBlueButtonInPage } from "../../connector/extension/src/moodle-bbb-executor.js";

const ANCHOR_SESSION = "moodle-bbb-session-a";
const FOREIGN_SESSION = "moodle-bbb-session-b";
const COURSE_ID = "2";
const SECTION_ID = "7";
const SECTION_NUMBER = "3";
const OPEN_MODULE_ID = "11";
const OPEN_NAME = "Week 1 live session";
const LATER_MODULE_ID = "12";
const LATER_NAME = "Week 9 live session";
const BOUNDED_MODULE_ID = "13";
const BOUNDED_NAME = "Orientation live session";
const NEW_MODULE_ID = "21";
const NEW_NAME = "Week 4 review session";
const DRAFT_ITEM_ID = "884401";
const PRESENTATION_DRAFT_ID = "990220";
const GUEST_JOIN_URL = "https://moodle.example/guest-join-do-not-leak";
const GUEST_PASSWORD = "guest-password-do-not-leak";
const PARTICIPANT_USER_ID = "40871";
// The site's own current time, as Moodle renders it in a switched-off optional
// date selector.
const SITE_NOW = { year: 2026, month: 9, day: 7, hour: 10, minute: 30 };
const APPROVED_OPENING = { year: 2026, month: 9, day: 8, hour: 9, minute: 0 };
const APPROVED_CLOSING = { year: 2026, month: 9, day: 8, hour: 10, minute: 30 };
const DEFAULT_PARTICIPANTS = [{ selectiontype: "all", selectionid: "all", role: "viewer" }];
const USER_PARTICIPANTS = [...DEFAULT_PARTICIPANTS, { selectiontype: "user", selectionid: PARTICIPANT_USER_ID, role: "moderator" }];

const operations = Object.freeze({
  activity: { key: "moodle.form.course.modedit.bigbluebuttonbn.read.v1", toolName: "moodle_get_bigbluebuttonbn", provider: "moodle", readOnly: true },
  creationForm: { key: "moodle.form.course.modedit.bigbluebuttonbn.create.read.v1", toolName: "moodle_get_bigbluebuttonbn_creation_form", provider: "moodle", readOnly: true },
  create: { key: "moodle.form.course.modedit.bigbluebuttonbn.create.write.v1", toolName: "moodle_create_bigbluebuttonbn", provider: "moodle", readOnly: false },
  update: { key: "moodle.form.course.modedit.bigbluebuttonbn.write.v1", toolName: "moodle_update_bigbluebuttonbn", provider: "moodle", readOnly: false },
});

function readBody(request) {
  return new Promise((resolve) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

test("the Moodle BigBlueButton route is cataloged and wired, and reaches no meeting or recording route", () => {
  const root = new URL("../..", import.meta.url);
  const catalog = JSON.parse(readFileSync(new URL("connector/extension/generated/moodle-browser-catalog.json", root), "utf8"));
  const entries = catalog.operations.filter((entry) => String(entry.key).includes(".modedit.bigbluebuttonbn."));
  assert.deepEqual(entries.map((entry) => entry.key).sort(), [
    "moodle.form.course.modedit.bigbluebuttonbn.create.read.v1",
    "moodle.form.course.modedit.bigbluebuttonbn.create.write.v1",
    "moodle.form.course.modedit.bigbluebuttonbn.read.v1",
    "moodle.form.course.modedit.bigbluebuttonbn.write.v1",
  ]);
  const byTool = new Map(entries.map((entry) => [entry.toolName, entry]));
  assert.deepEqual([...byTool.keys()].sort(), ["moodle_create_bigbluebuttonbn", "moodle_get_bigbluebuttonbn", "moodle_get_bigbluebuttonbn_creation_form", "moodle_update_bigbluebuttonbn"]);
  assert.equal(byTool.get("moodle_get_bigbluebuttonbn").readOnly, true);
  assert.equal(byTool.get("moodle_get_bigbluebuttonbn_creation_form").readOnly, true);
  assert.equal(byTool.get("moodle_create_bigbluebuttonbn").readOnly, false);
  assert.equal(byTool.get("moodle_update_bigbluebuttonbn").readOnly, false);
  assert.equal(byTool.get("moodle_create_bigbluebuttonbn").reviewTool, "moodle_get_bigbluebuttonbn_creation_form");
  for (const entry of entries) {
    assert.equal(entry.provider, "moodle", entry.toolName);
    assert.equal(entry.destructive, undefined, entry.toolName);
    // Every result has to say that Morrow performs no BigBlueButton server action.
    assert.match(entry.description, /Morrow performs no BigBlueButton server action/, entry.toolName);
    assert.match(entry.description, /never joins, starts or ends a meeting/, entry.toolName);
    assert.match(entry.description, /never asks for a recording/, entry.toolName);
    assert.match(entry.description, /live_session_state is always not_read/, entry.toolName);
    // Recording and participant controls stay unavailable.
    assert.match(entry.description, /Recording controls and participant controls are read and reported, never changed/, entry.toolName);
  }
  const create = byTool.get("moodle_create_bigbluebuttonbn");
  assert.match(create.description, /Browser-fixture proof only; no signed-in Moodle site has run it\./);
  assert.match(create.description, /fails closed on the room being open/);
  assert.deepEqual(Object.keys(create.inputSchema.properties).sort(), ["closing_time", "course_id", "expected_digest", "name", "opening_time", "section_id", "wait_for_moderator"]);
  assert.deepEqual(create.inputSchema.required.sort(), ["course_id", "expected_digest", "name", "opening_time", "section_id"]);
  assert.equal(create.inputSchema.additionalProperties, false);
  assert.equal(create.inputSchema.properties.name.maxLength, 64);
  const update = byTool.get("moodle_update_bigbluebuttonbn");
  assert.equal(update.reviewTool, "moodle_get_bigbluebuttonbn");
  assert.deepEqual(update.inputSchema.required.sort(), ["course_id", "expected_digest", "module_id"]);
  assert.deepEqual(Object.keys(update.inputSchema.properties).sort(), ["closing_time", "course_id", "expected_digest", "module_id", "name", "opening_time", "wait_for_moderator"]);
  assert.deepEqual(update.inputSchema.dependencies, { closing_time: ["opening_time"] });

  const worker = readFileSync(new URL("connector/extension/src/service-worker.js", root), "utf8");
  assert.match(worker, /import \{ executeMoodleBigBlueButtonInPage \} from "\.\/moodle-bbb-executor\.js";/);
  assert.match(worker, /func: executeMoodleBigBlueButtonInPage/);
  for (const entry of entries) assert.match(worker, new RegExp(`"${entry.key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`), entry.key);

  // No join, recording, meeting-information or view route can be built here.
  const executor = readFileSync(new URL("connector/extension/src/moodle-bbb-executor.js", root), "utf8");
  const source = executor.split("export async function")[1] || "";
  for (const route of [
    "/mod/bigbluebuttonbn/bbb_view.php",
    "/mod/bigbluebuttonbn/view.php",
    "/mod/bigbluebuttonbn/recording",
    "meeting_info",
    "get_recordings",
  ]) {
    assert.equal(source.includes(route), false, `the executor body must not name ${route}`);
  }
  assert.equal(/"\/mod\//.test(source), false, "the executor body must build no /mod/ route");
  assert.match(source, /redirect: "manual"/);
});

test("the Moodle BigBlueButton route reads and creates one hidden scheduled room, and refuses an open room before it sends", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morrow-moodle-bbb-"));
  const key = join(directory, "key.pem");
  const certificate = join(directory, "certificate.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", certificate], { stdio: "ignore" });

  const state = {
    instances: {
      // A room whose window is already open at the site's own current time.
      [OPEN_MODULE_ID]: { name: OPEN_NAME, sectionid: Number(SECTION_ID), visible: true, wait: true, opening: { year: 2026, month: 9, day: 1, hour: 9, minute: 0 }, closing: null, guestallowed: true },
      // A room whose window has not started yet.
      [LATER_MODULE_ID]: { name: LATER_NAME, sectionid: Number(SECTION_ID), visible: false, wait: false, opening: { year: 2026, month: 12, day: 1, hour: 9, minute: 0 }, closing: null, guestallowed: false },
      // A room with both ends set, which leaves no site clock on its own form.
      [BOUNDED_MODULE_ID]: { name: BOUNDED_NAME, sectionid: Number(SECTION_ID), visible: true, wait: false, opening: { year: 2026, month: 9, day: 1, hour: 9, minute: 0 }, closing: { year: 2026, month: 9, day: 30, hour: 9, minute: 0 }, guestallowed: false },
    },
    otherActivities: [{ id: 4, module: "page", sectionid: Number(SECTION_ID), name: "Overview", visible: true }],
    sections: [{ id: Number(SECTION_ID), number: Number(SECTION_NUMBER), title: "Live sessions" }],
    creationSessionQueue: [],
    creationView: "core",
    creationParticipants: DEFAULT_PARTICIPANTS,
    creationGuestAllowed: false,
    activityView: "core",
    postOutcome: "saved",
    savedNameOverride: "",
    savedUpdateNameOverride: "",
  };
  const requests = [];
  const posts = [];
  let origin = "";
  let browser;
  let context;

  const activities = () => [
    ...state.otherActivities,
    ...Object.entries(state.instances).map(([moduleId, instance]) => ({
      id: Number(moduleId), module: "bigbluebuttonbn", sectionid: instance.sectionid, name: instance.name, visible: instance.visible,
    })),
  ];
  const control = (name, value, type = "hidden") => `<input type="${type}" name="${name}" value="${value}">`;
  const box = (name, checked) => `<input type="checkbox" name="${name}" value="1"${checked ? " checked" : ""}>`;
  const advBox = (name, checked) => `${control(name, "0")}<input type="checkbox" name="${name}" value="1"${checked ? " checked" : ""}>`;
  const option = (value, selected) => `<option value="${value}"${selected ? " selected" : ""}>${value}</option>`;
  const dateSelector = (name, date, view) => {
    const shown = date || SITE_NOW;
    const parts = view === "unreadable-clock" && !date
      ? ["day", "month", "year", "hour", "minute"].map((part) => `<select name="${name}[${part}]">${option("--", true)}</select>`).join("")
      : ["day", "month", "year", "hour", "minute"].map((part) => `<select name="${name}[${part}]">${option(shown[part], true)}</select>`).join("");
    return `<input type="checkbox" name="${name}[enabled]" value="1"${date ? " checked" : ""}>${parts}`;
  };
  const roomForm = (view, sesskey, identity, instance, participants, guestAllowed) => {
    const moduleName = view === "wrong-module" ? "page" : "bigbluebuttonbn";
    const action = view === "query-action" ? "/course/modedit.php?add=bigbluebuttonbn&course=2"
      : view === "external-action" ? "https://outside.example/course/modedit.php" : "/course/modedit.php";
    const fileArea = view === "extra-file-area"
      ? '<div data-fieldtype="filemanager"><input type="hidden" name="attachments" value="99"></div>'
      : "";
    const extraDraft = view === "extra-draft" ? control("attachments[itemid]", "990011") : "";
    const presentation = view === "no-presentation-control"
      ? '<div data-fieldtype="filemanager"></div>'
      : `<div data-fieldtype="filemanager">${control("presentation", PRESENTATION_DRAFT_ID)}</div>`;
    const waitControl = view === "frozen-wait" ? control("wait", instance?.wait ? "1" : "0") : box("wait", Boolean(instance?.wait));
    const visibleSelected = instance ? (instance.visible ? "1" : "0") : "1";
    const visible = view === "frozen-visible"
      ? control("visible", visibleSelected)
      : `<select name="visible">${option("1", visibleSelected === "1")}${option("0", visibleSelected === "0")}</select>`;
    const openingDate = view === "creation-schedule-set" ? APPROVED_OPENING : instance ? instance.opening : null;
    const closingDate = instance ? instance.closing : null;
    const guestLinks = instance
      ? `<input type="text" name="guestjoinurl" value="${GUEST_JOIN_URL}"><input type="text" name="guestpassword" value="${GUEST_PASSWORD}">`
      : "";
    return `<!doctype html><html><body class="path-course course-2"><form method="post" action="${action}" id="mform1">
      ${Object.entries(identity).map(([name, value]) => control(name, value)).join("")}
      ${control("module", "23")}${control("modulename", moduleName)}${control("instance", instance ? "3" : "0")}
      ${control("sr", "0")}${control("beforemod", "0")}${control("sesskey", sesskey)}${control("_qf__mod_bigbluebuttonbn_mod_form", "1")}
      <select name="type">${option("0", true)}${option("1", false)}${option("2", false)}</select>
      <input type="text" name="name" value="${instance ? instance.name : ""}">
      <textarea name="introeditor[text]"></textarea>${control("introeditor[format]", "1")}${control("introeditor[itemid]", DRAFT_ITEM_ID)}
      ${advBox("showdescription", false)}
      <textarea name="welcome"></textarea>
      <input type="text" name="voicebridge" value="0">
      ${waitControl}
      <input type="text" name="userlimit" value="0">
      ${box("record", true)}${box("recordallfromstart", false)}${box("recordhidebutton", false)}
      ${box("muteonstart", false)}
      ${box("disablecam", false)}${box("disablemic", false)}${box("disableprivatechat", true)}
      ${box("disablepublicchat", false)}${box("disablenote", false)}${box("hideuserlist", false)}
      ${presentation}${advBox("showpresentation", false)}
      ${control("participants", JSON.stringify(participants).replace(/"/g, "&quot;"))}
      ${advBox("guestallowed", guestAllowed)}${advBox("mustapproveuser", true)}${guestLinks}
      ${dateSelector("openingtime", openingDate, view)}
      ${dateSelector("closingtime", closingDate, view)}
      <select name="grade[modgrade_type]">${option("none", true)}</select>
      <select name="gradecat">${option("12", true)}</select>
      <input type="text" name="gradepass" value="">
      ${advBox("completionattendanceenabled", false)}
      ${visible}
      <input type="text" name="cmidnumber" value="">
      ${fileArea}${extraDraft}
      <input type="checkbox" name="coursecontentnotification" value="1">
      <input type="submit" name="submitbutton2" value="Save and return to course">
      <input type="submit" name="submitbutton" value="Save and display">
      <input type="submit" name="cancel" value="Cancel">
    </form></body></html>`;
  };
  const creationForm = () => roomForm(state.creationView, state.creationSessionQueue.shift() || ANCHOR_SESSION, {
    course: COURSE_ID, coursemodule: "0", section: SECTION_NUMBER, add: "bigbluebuttonbn", update: "0", return: "0",
  }, null, state.creationParticipants, state.creationGuestAllowed);
  const activityForm = (moduleId) => {
    const instance = { ...state.instances[moduleId] };
    if (state.savedNameOverride) instance.name = state.savedNameOverride;
    return roomForm(state.activityView, ANCHOR_SESSION, {
      course: COURSE_ID, coursemodule: moduleId, section: SECTION_NUMBER, add: "", update: moduleId, return: "0",
    }, instance, DEFAULT_PARTICIPANTS, instance.guestallowed);
  };
  const dateFromPost = (values, name) => {
    if (values.get(`${name}[enabled]`) !== "1") return null;
    return Object.fromEntries(["year", "month", "day", "hour", "minute"].map((part) => [part, Number(values.get(`${name}[${part}]`))]));
  };

  const server = createServer({ key: readFileSync(key), cert: readFileSync(certificate) }, async (request, response) => {
    const url = new URL(request.url || "/", origin || "https://127.0.0.1");
    requests.push({ method: request.method, pathname: url.pathname, search: url.search });
    if (request.method === "GET" && url.pathname === "/course/view.php") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<!doctype html><body class="path-course course-1"><script>var M = {}; M.cfg = ${JSON.stringify({ wwwroot: origin, sesskey: ANCHOR_SESSION, userId: 3, courseId: 1 })};</script></body>`);
      return;
    }
    if (request.method === "POST" && url.pathname === "/lib/ajax/service.php") {
      const call = JSON.parse(await readBody(request))[0];
      assert.equal(url.search, `?sesskey=${ANCHOR_SESSION}&info=${call.methodname}`);
      assert.equal(call.methodname, "core_courseformat_get_state");
      assert.deepEqual(call.args, { courseid: 2 });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify([{ index: 0, data: JSON.stringify({
        course: { id: 2, fullname: "BigBlueButton evidence course" },
        section: state.sections,
        cm: activities(),
      }) }]));
      return;
    }
    if (request.method === "GET" && url.pathname === "/course/modedit.php") {
      if (url.search === `?add=bigbluebuttonbn&course=${COURSE_ID}&sectionid=${SECTION_ID}&return=0`) {
        response.writeHead(200, { "content-type": "text/html" });
        response.end(creationForm());
        return;
      }
      const update = url.searchParams.get("update") || "";
      if (url.search === `?update=${update}&return=0` && state.instances[update]) {
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
      const update = values.get("update") || "";
      if (state.postOutcome === "validation") {
        response.writeHead(200, { "content-type": "text/html" });
        response.end(state.instances[update] ? activityForm(update) : creationForm());
        return;
      }
      if (state.instances[update] && values.get("add") === "") {
        state.instances[update] = {
          ...state.instances[update],
          name: state.savedUpdateNameOverride || values.get("name") || "",
          wait: values.getAll("wait").includes("1"),
          opening: dateFromPost(values, "openingtime"),
          closing: dateFromPost(values, "closingtime"),
          guestallowed: values.getAll("guestallowed").includes("1"),
        };
        response.writeHead(303, { location: `/course/view.php?id=${COURSE_ID}` });
        response.end();
        return;
      }
      state.instances[String(Number(NEW_MODULE_ID) + Object.keys(state.instances).length - 3)] = {
        name: values.get("name") || "",
        sectionid: Number(SECTION_ID),
        visible: values.get("visible") === "1",
        wait: values.getAll("wait").includes("1"),
        opening: dateFromPost(values, "openingtime"),
        closing: dateFromPost(values, "closingtime"),
        guestallowed: values.getAll("guestallowed").includes("1"),
      };
      response.writeHead(303, { location: `/course/view.php?id=${COURSE_ID}` });
      response.end();
      return;
    }
    response.writeHead(404).end();
  });

  try {
    await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", (error) => error ? reject(error) : resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("bigbluebutton test server did not bind");
    origin = `https://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
    context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    await page.goto(`${origin}/course/view.php?id=1`);
    const binding = { origin, siteUrl: `${origin}/`, principalId: "3", courseId: COURSE_ID };
    const results = [];
    const execute = async (operation, argumentsValue, expiresAt = Date.now() + 60_000) => {
      const result = await page.evaluate(executeMoodleBigBlueButtonInPage, JSON.stringify({ mode: "execute", operation, arguments: argumentsValue, binding, expiresAt }));
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
    const SOURCE_PATHS = ["/lib/ajax/service.php", "/course/modedit.php"];
    const sourceRequests = () => requests.filter((entry) => SOURCE_PATHS.includes(entry.pathname)).length;
    const courseViewRequests = () => requests.filter((entry) => entry.pathname === "/course/view.php").length;
    const viewsAfterNavigation = courseViewRequests();
    const createArguments = (overrides = {}) => ({
      course_id: 2, section_id: 7, name: NEW_NAME, opening_time: APPROVED_OPENING, closing_time: APPROVED_CLOSING, expected_digest: "a".repeat(64), ...overrides,
    });
    const updateArguments = (overrides = {}) => ({
      course_id: 2, module_id: Number(LATER_MODULE_ID), name: "Week 10 live session", expected_digest: "a".repeat(64), ...overrides,
    });

    // 1. Arguments are refused before any native request.
    const beforeArguments = sourceRequests();
    for (const [operation, args] of [
      [operations.creationForm, { course_id: 3, section_id: 7 }],
      [operations.creationForm, { course_id: 2 }],
      [operations.activity, { course_id: 2, module_id: 11, extra: 1 }],
      // A create needs a name, a schedule and a reviewed digest.
      [operations.create, { course_id: 2, section_id: 7, name: NEW_NAME, opening_time: APPROVED_OPENING }],
      [operations.create, createArguments({ opening_time: undefined })],
      [operations.create, createArguments({ name: " padded " })],
      [operations.create, createArguments({ opening_time: { year: 2026, month: 2, day: 30, hour: 9, minute: 0 } })],
      [operations.create, createArguments({ opening_time: { year: 2026, month: 9, day: 8, hour: 9 } })],
      // Moodle's own rule: a closing time may not be at or before the opening time.
      [operations.create, createArguments({ closing_time: APPROVED_OPENING })],
      [operations.create, createArguments({ wait_for_moderator: "yes" })],
      // No credential and no participant mapping is ever an accepted argument.
      [operations.create, createArguments({ guestpassword: GUEST_PASSWORD })],
      [operations.create, createArguments({ participants: "[]" })],
      [operations.create, createArguments({ record: true })],
      // An update must name one writable field. Closing time is only meaningful
      // when it arrives with the new opening time it must follow.
      [operations.update, { course_id: 2, module_id: Number(LATER_MODULE_ID), expected_digest: "a".repeat(64) }],
      [operations.update, updateArguments({ name: " padded " })],
      [operations.update, updateArguments({ name: undefined, closing_time: APPROVED_CLOSING })],
      [operations.update, updateArguments({ opening_time: APPROVED_OPENING, closing_time: APPROVED_OPENING })],
      [operations.update, updateArguments({ guestpassword: GUEST_PASSWORD })],
    ]) {
      const args_ = { ...args };
      for (const [name, value] of Object.entries(args_)) if (value === undefined) delete args_[name];
      assert.deepEqual(await execute(operation, args_), { ok: false, sent: false, error: "moodle_bigbluebuttonbn_arguments_invalid" }, JSON.stringify(args_));
    }
    assert.deepEqual(await execute({ ...operations.creationForm, readOnly: false }, { course_id: 2, section_id: 7 }), { ok: false, sent: false, error: "moodle_operation_refused" });
    assert.deepEqual(await execute(operations.activity, { course_id: 2, module_id: 11 }, Date.now() - 1), { ok: false, sent: false, error: "moodle_execution_expired" });
    assert.equal(sourceRequests(), beforeArguments);

    // 2. A section outside the approved course state is refused before the form read.
    const beforeSection = requests.filter((entry) => entry.pathname === "/course/modedit.php").length;
    assert.deepEqual(await execute(operations.creationForm, { course_id: 2, section_id: 999 }), { ok: false, sent: false, status: 200, error: "moodle_bigbluebuttonbn_section_target_invalid" });
    assert.equal(requests.filter((entry) => entry.pathname === "/course/modedit.php").length, beforeSection);

    // 3. Every form that is not the core BigBlueButton form is refused, and none of them sends a POST.
    state.creationSessionQueue.push(FOREIGN_SESSION);
    assert.deepEqual(await execute(operations.creationForm, { course_id: 2, section_id: 7 }), { ok: false, sent: false, status: 200, error: "moodle_form_session_mismatch" });
    for (const [view, error] of [
      ["wrong-module", "moodle_bigbluebuttonbn_form_invalid"],
      ["extra-file-area", "moodle_bigbluebuttonbn_file_area_unexpected"],
      ["no-presentation-control", "moodle_bigbluebuttonbn_file_area_unexpected"],
      ["extra-draft", "moodle_bigbluebuttonbn_file_area_unexpected"],
      ["frozen-visible", "moodle_bigbluebuttonbn_form_invalid"],
      ["query-action", "moodle_bigbluebuttonbn_form_invalid"],
      ["external-action", "moodle_bigbluebuttonbn_form_invalid"],
      // A creation form that already carries a schedule is not the native add form.
      ["creation-schedule-set", "moodle_bigbluebuttonbn_form_invalid"],
    ]) {
      state.creationView = view;
      assert.deepEqual(await execute(operations.creationForm, { course_id: 2, section_id: 7 }), { ok: false, sent: false, status: 200, error }, view);
    }
    state.creationView = "core";
    assert.equal(posts.length, 0);

    // 4. The reviewed creation form states the whole boundary, including the site clock.
    const form = await execute(operations.creationForm, { course_id: 2, section_id: 7 });
    assert.equal(form.ok, true, JSON.stringify(form));
    assert.deepEqual(form.targets, [
      { field: "course_id", label: "Course", name: "BigBlueButton evidence course" },
      { field: "section_id", label: "Section", name: "Live sessions" },
    ]);
    assert.deepEqual(form.data, {
      schema: "morrow.moodle-bigbluebuttonbn-activity.v1",
      provider: "moodle",
      course_id: 2,
      section_id: 7,
      section_number: 3,
      module: "bigbluebuttonbn",
      instance_type: 0,
      instance_type_name: "0",
      available_instance_types: [0, 1, 2],
      room: { wait_for_moderator: false, mute_on_start: false, user_limit: 0 },
      recording: { enabled: true, all_from_start: false, hide_button: false },
      lock: { disable_camera: false, disable_microphone: false, disable_private_chat: true, disable_public_chat: false, disable_note: false, hide_user_list: false },
      guest_access: { allowed: false, must_approve_user: true, join_url_present: false, password_present: false },
      schedule: { opening_time: null, closing_time: null },
      site_time: SITE_NOW,
      presentation_area_present: true,
      participant_rules: { count: 1, names_a_user: false },
      introduction_empty: true,
      schedule_writable: true,
      wait_for_moderator_writable: true,
      visible: false,
      // Every control the form actually sends. An unticked plain checkbox sends
      // nothing at all, so a room, recording or lock setting that is off is not
      // named here: there is nothing to carry back.
      protected_setting_names: [
        "add", "beforemod", "cmidnumber", "completionattendanceenabled", "course", "coursemodule", "disableprivatechat",
        "grade[modgrade_type]", "gradecat", "gradepass", "guestallowed", "instance", "introeditor[format]",
        "introeditor[text]", "module", "modulename", "mustapproveuser", "participants", "presentation", "record",
        "return", "section", "showdescription", "showpresentation", "sr", "type", "update", "userlimit", "visible",
        "voicebridge", "welcome",
      ],
      proof: {
        method: "native_form_read",
        route: "/course/modedit.php",
        required_capability: "moodle/course:manageactivities",
        required_module_capability: "mod/bigbluebuttonbn:addinstance",
        scope: "one_bigbluebuttonbn_activity",
        module: "bigbluebuttonbn",
        bigbluebutton_server_request: "none_from_morrow",
        moodle_contacts_bigbluebutton_to_render_form: true,
        meeting_joined: false,
        meeting_started: false,
        meeting_ended: false,
        recording_requested: false,
        live_session_state: "not_read",
      },
    });
    assert.match(form.snapshot_digest, /^[a-f0-9]{64}$/);
    assert.equal(Object.hasOwn(form.data, "name"), false, "a creation form has no current activity name");
    assert.equal(Object.hasOwn(form.data, "room_open_now"), false, "a room that does not exist yet has no open state");
    // The site clock changes every minute, so it is not part of the reviewed digest.
    assert.equal((await execute(operations.creationForm, { course_id: 2, section_id: 7 })).snapshot_digest, form.snapshot_digest);

    // 5. A stale digest never reaches a POST.
    assert.deepEqual(await execute(operations.create, createArguments()), { ok: false, sent: false, status: 200, error: "moodle_expected_digest_mismatch" });
    assert.equal(posts.length, 0);

    // 6. A room that Moodle's own rule would already treat as open refuses before the send.
    for (const opening of [SITE_NOW, { year: 2026, month: 9, day: 7, hour: 9, minute: 0 }, { year: 2020, month: 1, day: 1, hour: 0, minute: 0 }]) {
      assert.deepEqual(await execute(operations.create, createArguments({ opening_time: opening, closing_time: { year: 2027, month: 1, day: 1, hour: 0, minute: 0 }, expected_digest: form.snapshot_digest })), {
        ok: false, sent: false, status: 200, error: "moodle_bigbluebuttonbn_room_open_now",
      }, JSON.stringify(opening));
    }
    assert.equal(posts.length, 0, "an open room never reaches a POST");

    // 7. A form with no readable site clock fails closed rather than guessing.
    state.creationView = "unreadable-clock";
    const noClock = await execute(operations.creationForm, { course_id: 2, section_id: 7 });
    assert.equal(noClock.ok, true, JSON.stringify(noClock));
    assert.equal(noClock.data.site_time, null);
    assert.deepEqual(await execute(operations.create, createArguments({ expected_digest: noClock.snapshot_digest })), {
      ok: false, sent: false, status: 200, error: "moodle_bigbluebuttonbn_site_time_unavailable",
    });
    state.creationView = "core";

    // 8. Guest access already on, and a participant rule that names one person, both refuse before the send.
    state.creationGuestAllowed = true;
    const guestForm = await execute(operations.creationForm, { course_id: 2, section_id: 7 });
    assert.equal(guestForm.data.guest_access.allowed, true);
    assert.deepEqual(await execute(operations.create, createArguments({ expected_digest: guestForm.snapshot_digest })), {
      ok: false, sent: false, status: 200, error: "moodle_bigbluebuttonbn_guest_access_refused",
    });
    state.creationGuestAllowed = false;
    state.creationParticipants = USER_PARTICIPANTS;
    const userRuleForm = await execute(operations.creationForm, { course_id: 2, section_id: 7 });
    assert.deepEqual(userRuleForm.data.participant_rules, { count: 2, names_a_user: true });
    assert.notEqual(userRuleForm.snapshot_digest, form.snapshot_digest, "the participant mapping is part of the reviewed digest");
    assert.deepEqual(await execute(operations.create, createArguments({ expected_digest: userRuleForm.snapshot_digest })), {
      ok: false, sent: false, status: 200, error: "moodle_bigbluebuttonbn_participant_rule_names_user",
    });
    state.creationParticipants = DEFAULT_PARTICIPANTS;
    assert.equal(posts.length, 0);

    // 9. A frozen room setting the approval names is refused, with nothing sent.
    state.creationView = "frozen-wait";
    const frozen = await execute(operations.creationForm, { course_id: 2, section_id: 7 });
    assert.equal(frozen.data.wait_for_moderator_writable, false);
    assert.deepEqual(await execute(operations.create, createArguments({ wait_for_moderator: true, expected_digest: frozen.snapshot_digest })), {
      ok: false, sent: false, status: 200, error: "moodle_bigbluebuttonbn_setting_not_writable",
    });
    state.creationView = "core";
    assert.equal(posts.length, 0);

    // 10. The native form answers a refused save with itself, which saved nothing.
    state.postOutcome = "validation";
    assert.deepEqual(await execute(operations.create, createArguments({ expected_digest: form.snapshot_digest })), {
      ok: false, sent: true, status: 200, outcomeUnknown: false,
      verification: { schema: "morrow.browser-verification.v1", status: "mismatch", reason: "moodle_form_validation_failed" },
      error: "moodle_form_validation_failed",
    });
    assert.equal(posts.length, 1);
    assert.equal(Object.keys(state.instances).length, 3);
    state.postOutcome = "saved";

    // 11. One approved creation: one POST, hidden, scheduled, with every other control carried back.
    const created = await execute(operations.create, createArguments({ wait_for_moderator: true, expected_digest: form.snapshot_digest }));
    assert.equal(created.ok, true, JSON.stringify(created));
    assert.deepEqual(created.verification, { schema: "morrow.browser-verification.v1", status: "verified" });
    assert.equal(posts.length, 2);
    const sent = posts[1].values;
    assert.equal(sent.get("name"), NEW_NAME);
    assert.equal(sent.getAll("name").length, 1);
    assert.equal(sent.get("visible"), "0");
    assert.equal(sent.get("add"), "bigbluebuttonbn");
    assert.equal(sent.get("modulename"), "bigbluebuttonbn");
    assert.equal(sent.get("course"), COURSE_ID);
    assert.equal(sent.get("section"), SECTION_NUMBER);
    assert.equal(sent.get("openingtime[enabled]"), "1");
    assert.deepEqual(dateFromPost(sent, "openingtime"), APPROVED_OPENING);
    assert.deepEqual(dateFromPost(sent, "closingtime"), APPROVED_CLOSING);
    assert.deepEqual(sent.getAll("wait"), ["1"]);
    assert.equal(sent.get("record"), "1", "a recording setting goes back exactly as the form gave it");
    assert.equal(sent.get("recordallfromstart"), null, "an unticked recording control is not sent");
    assert.equal(sent.get("participants"), JSON.stringify(DEFAULT_PARTICIPANTS), "the participant mapping goes back exactly as the form gave it");
    assert.equal(sent.get("presentation"), PRESENTATION_DRAFT_ID, "the pre-uploaded presentation area goes back untouched");
    assert.equal(sent.get("submitbutton2"), "Save and return to course");
    assert.equal(sent.get("submitbutton"), null, "only the reviewed submit control is sent");
    assert.equal(sent.get("coursecontentnotification"), null, "a save never notifies learners");
    assert.equal(sent.get("sesskey"), ANCHOR_SESSION);
    assert.equal(created.data.module_id, Number(NEW_MODULE_ID));
    assert.equal(created.data.visible, false);
    assert.equal(created.data.created, true);
    assert.deepEqual(created.data.schedule, { opening_time: APPROVED_OPENING, closing_time: APPROVED_CLOSING });
    assert.equal(created.data.room.wait_for_moderator, true);
    // Both schedule ends are set on the new room, so its own form carries no site
    // clock and its open state is unknown rather than guessed.
    assert.equal(created.data.site_time, null);
    assert.equal(created.data.room_open_now, null);
    assert.deepEqual(created.data.proof, form.data.proof);

    // 12. A create with no closing time leaves that control switched off.
    const openEnded = await execute(operations.creationForm, { course_id: 2, section_id: 7 });
    const withoutClosing = await execute(operations.create, {
      course_id: 2, section_id: 7, name: "Open-ended review session", opening_time: APPROVED_OPENING, wait_for_moderator: false, expected_digest: openEnded.snapshot_digest,
    });
    assert.equal(withoutClosing.ok, true, JSON.stringify(withoutClosing));
    const openEndedPost = posts[posts.length - 1].values;
    assert.equal(openEndedPost.get("closingtime[enabled]"), null, "an unset closing time is sent as no enable control");
    assert.deepEqual(openEndedPost.getAll("wait"), [], "wait for moderator off is sent as no control at all");
    assert.deepEqual(withoutClosing.data.schedule, { opening_time: APPROVED_OPENING, closing_time: null });
    assert.equal(withoutClosing.data.room.wait_for_moderator, false);
    assert.equal(withoutClosing.data.room_open_now, false, "the new open-ended room is scheduled to open later");

    // 13. A saved room reads back with its own open state, and its guest credentials stay in Chrome.
    const openRoom = await execute(operations.activity, { course_id: 2, module_id: Number(OPEN_MODULE_ID) });
    assert.equal(openRoom.ok, true, JSON.stringify(openRoom));
    assert.deepEqual(openRoom.targets, [
      { field: "course_id", label: "Course", name: "BigBlueButton evidence course" },
      { field: "module_id", label: "BigBlueButton room", name: OPEN_NAME },
    ]);
    assert.equal(openRoom.data.name, OPEN_NAME);
    assert.equal(openRoom.data.room_open_now, true);
    assert.equal(openRoom.data.visible, true);
    assert.deepEqual(openRoom.data.guest_access, { allowed: true, must_approve_user: true, join_url_present: true, password_present: true });
    assert.equal(openRoom.data.proof.live_session_state, "not_read");
    assert.equal(openRoom.data.proof.bigbluebutton_server_request, "none_from_morrow");
    const laterRoom = await execute(operations.activity, { course_id: 2, module_id: Number(LATER_MODULE_ID) });
    assert.equal(laterRoom.data.room_open_now, false);
    // Both ends set leaves no site clock on the page, so the answer is unknown, not a guess.
    const boundedRoom = await execute(operations.activity, { course_id: 2, module_id: Number(BOUNDED_MODULE_ID) });
    assert.equal(boundedRoom.data.site_time, null);
    assert.equal(boundedRoom.data.room_open_now, null);
    assert.deepEqual(await execute(operations.activity, { course_id: 2, module_id: 4 }), { ok: false, sent: false, status: 200, error: "moodle_bigbluebuttonbn_module_target_invalid" });

    // 14. An update changes only the reviewed fields of a room whose native
    // schedule proves it is closed. The native form preserves every other
    // control, including the recording, presentation and participant controls.
    const updateForm = await execute(operations.activity, { course_id: 2, module_id: Number(LATER_MODULE_ID) });
    const updateBefore = posts.length;
    const updated = await execute(operations.update, {
      course_id: 2,
      module_id: Number(LATER_MODULE_ID),
      name: "Week 10 live session",
      opening_time: APPROVED_OPENING,
      closing_time: APPROVED_CLOSING,
      wait_for_moderator: true,
      expected_digest: updateForm.snapshot_digest,
    });
    assert.equal(updated.ok, true, JSON.stringify(updated));
    assert.equal(updated.data.updated, true);
    assert.equal(updated.data.name, "Week 10 live session");
    assert.deepEqual(updated.data.schedule, { opening_time: APPROVED_OPENING, closing_time: APPROVED_CLOSING });
    assert.equal(updated.data.room.wait_for_moderator, true);
    assert.deepEqual(updated.verification, { schema: "morrow.browser-verification.v1", status: "verified" });
    assert.equal(posts.length, updateBefore + 1);
    const updatePost = posts.at(-1).values;
    assert.equal(updatePost.get("update"), LATER_MODULE_ID);
    assert.equal(updatePost.get("add"), "");
    assert.equal(updatePost.get("name"), "Week 10 live session");
    assert.deepEqual(dateFromPost(updatePost, "openingtime"), APPROVED_OPENING);
    assert.deepEqual(dateFromPost(updatePost, "closingtime"), APPROVED_CLOSING);
    assert.deepEqual(updatePost.getAll("wait"), ["1"]);
    assert.equal(updatePost.get("record"), "1");
    assert.equal(updatePost.get("participants"), JSON.stringify(DEFAULT_PARTICIPANTS));
    assert.equal(updatePost.get("presentation"), PRESENTATION_DRAFT_ID);

    // An open room, or one whose bounded schedule omits Moodle's site clock,
    // is never changed. A frozen setting also stops before dispatch.
    const openDigest = (await execute(operations.activity, { course_id: 2, module_id: Number(OPEN_MODULE_ID) })).snapshot_digest;
    const boundedDigest = (await execute(operations.activity, { course_id: 2, module_id: Number(BOUNDED_MODULE_ID) })).snapshot_digest;
    const blockedBefore = posts.length;
    assert.deepEqual(await execute(operations.update, updateArguments({ module_id: Number(OPEN_MODULE_ID), expected_digest: openDigest })), {
      ok: false, sent: false, status: 200, error: "moodle_bigbluebuttonbn_room_open_now",
    });
    assert.deepEqual(await execute(operations.update, updateArguments({ module_id: Number(BOUNDED_MODULE_ID), expected_digest: boundedDigest })), {
      ok: false, sent: false, status: 200, error: "moodle_bigbluebuttonbn_room_open_now",
    });
    state.instances[LATER_MODULE_ID].opening = { year: 2026, month: 12, day: 1, hour: 9, minute: 0 };
    state.instances[LATER_MODULE_ID].closing = null;
    state.activityView = "frozen-wait";
    const frozenUpdate = await execute(operations.activity, { course_id: 2, module_id: Number(LATER_MODULE_ID) });
    assert.deepEqual(await execute(operations.update, updateArguments({ name: undefined, wait_for_moderator: false, expected_digest: frozenUpdate.snapshot_digest })), {
      ok: false, sent: false, status: 200, error: "moodle_bigbluebuttonbn_setting_not_writable",
    });
    state.activityView = "core";
    assert.equal(posts.length, blockedBefore);

    // A saved value outside the reviewed update is not verified, and a lost
    // response remains applied-or-unknown without a second POST.
    const mismatchForm = await execute(operations.activity, { course_id: 2, module_id: Number(LATER_MODULE_ID) });
    state.savedUpdateNameOverride = "Moodle rewrote the room";
    assert.deepEqual(await execute(operations.update, updateArguments({ expected_digest: mismatchForm.snapshot_digest })), {
      ok: false, sent: true, outcomeUnknown: true,
      verification: { schema: "morrow.browser-verification.v1", status: "unconfirmed", reason: "moodle_bigbluebuttonbn_update_not_verified" },
      error: "moodle_bigbluebuttonbn_update_not_verified",
    });
    state.savedUpdateNameOverride = "";
    const lostUpdateForm = await execute(operations.activity, { course_id: 2, module_id: Number(LATER_MODULE_ID) });
    const lostUpdateBefore = posts.length;
    await loseNextResponse("/course/modedit.php", "POST");
    assert.deepEqual(await execute(operations.update, updateArguments({ name: "Lost update response", expected_digest: lostUpdateForm.snapshot_digest })), {
      ok: false, sent: true, outcomeUnknown: true,
      verification: { schema: "morrow.browser-verification.v1", status: "unconfirmed", reason: "moodle_bigbluebuttonbn_update_unconfirmed" },
      error: "moodle_bigbluebuttonbn_update_unconfirmed",
    });
    assert.equal(posts.length, lostUpdateBefore + 1);

    // 15. A lost response after the dispatch is applied-or-unknown, and never retried.
    const lostForm = await execute(operations.creationForm, { course_id: 2, section_id: 7 });
    const lostBefore = posts.length;
    await loseNextResponse("/course/modedit.php", "POST");
    assert.deepEqual(await execute(operations.create, createArguments({ name: "Lost response session", expected_digest: lostForm.snapshot_digest })), {
      ok: false, sent: true, outcomeUnknown: true,
      verification: { schema: "morrow.browser-verification.v1", status: "unconfirmed", reason: "moodle_bigbluebuttonbn_create_unconfirmed" },
      error: "moodle_bigbluebuttonbn_create_unconfirmed",
    });
    assert.equal(posts.length, lostBefore + 1);
    assert.equal(Object.values(state.instances).filter((instance) => instance.name === "Lost response session").length, 1, "the site kept the change the browser could not confirm");

    // 15. A saved name that is not the approved name is applied-or-unknown.
    const driftForm = await execute(operations.creationForm, { course_id: 2, section_id: 7 });
    const driftBefore = posts.length;
    state.savedNameOverride = "Name the site kept";
    assert.deepEqual(await execute(operations.create, createArguments({ name: "Requested session name", expected_digest: driftForm.snapshot_digest })), {
      ok: false, sent: true, outcomeUnknown: true,
      verification: { schema: "morrow.browser-verification.v1", status: "unconfirmed", reason: "moodle_bigbluebuttonbn_create_not_verified" },
      error: "moodle_bigbluebuttonbn_create_not_verified",
    });
    assert.equal(posts.length, driftBefore + 1);
    state.savedNameOverride = "";

    // 16. Route and secret boundaries across the whole run.
    assert.equal(requests.some((entry) => entry.pathname.startsWith("/mod/")), false, "no mod route was opened, so no bbb_view.php join and no recording request was sent");
    assert.equal(requests.some((entry) => entry.pathname.includes("bbb_view")), false);
    assert.equal(courseViewRequests(), viewsAfterNavigation, "the save redirect was never followed");
    assert.equal(requests.some((entry) => entry.method !== "GET" && !SOURCE_PATHS.includes(entry.pathname)), false);
    const serialized = JSON.stringify(results);
    assert.equal(serialized.includes(GUEST_JOIN_URL), false, "a result leaked the guest join link");
    assert.equal(serialized.includes(GUEST_PASSWORD), false, "a result leaked the guest password");
    assert.equal(serialized.includes(PARTICIPANT_USER_ID), false, "a result leaked a participant user ID");
    assert.equal(serialized.includes(ANCHOR_SESSION), false, "a result leaked the session key");
    assert.equal(serialized.includes(FOREIGN_SESSION), false, "a result leaked a session key");
    assert.equal(serialized.includes(DRAFT_ITEM_ID), false, "a result leaked a draft item ID");
    assert.equal(serialized.includes(PRESENTATION_DRAFT_ID), false, "a result leaked the presentation draft item ID");
    for (const post of posts) {
      assert.equal(post.values.get("sesskey"), ANCHOR_SESSION, "every save carries the native session key from the form Morrow reloaded");
    }
  } finally {
    await context?.close();
    await browser?.close();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});
