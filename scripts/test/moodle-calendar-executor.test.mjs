import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { executeMoodleCalendarInPage } from "../../connector/extension/src/moodle-calendar-executor.js";
import { categoriesForBinding } from "../../connector/extension/src/edit-policy.js";

const root = new URL("../..", import.meta.url);
const operations = Object.freeze({
  list: { key: "moodle.ajax.core_calendar.course_events.read.v1", toolName: "moodle_list_course_events", provider: "moodle", readOnly: true },
  dates: { key: "moodle.ajax.core_calendar.course_dates.read.v1", toolName: "moodle_get_course_dates", provider: "moodle", readOnly: true },
  event: { key: "moodle.ajax.core_calendar.event.read.v1", toolName: "moodle_get_event", provider: "moodle", readOnly: true },
  create: { key: "moodle.ajax.core_calendar.event_create.write.v1", toolName: "moodle_create_course_event", provider: "moodle", readOnly: false },
  update: { key: "moodle.ajax.core_calendar.event_update.write.v1", toolName: "moodle_update_event", provider: "moodle", readOnly: false },
  remove: { key: "moodle.ajax.core_calendar.event_delete.write.v1", toolName: "moodle_delete_event", provider: "moodle", readOnly: false },
});
const SESSKEY = "moodle-private-session";
const COURSE_CONTEXT_ID = 431;
const TIME_ZONE = "America/New_York";

test("the calendar operations are cataloged, routed, and gated by their own approval class", () => {
  const catalog = JSON.parse(readFileSync(new URL("connector/extension/generated/moodle-browser-catalog.json", root), "utf8"));
  const byTool = new Map(catalog.operations.map((entry) => [entry.toolName, entry]));

  for (const operation of Object.values(operations)) {
    const entry = byTool.get(operation.toolName);
    assert.ok(entry, `${operation.toolName} is missing from the Moodle catalog`);
    assert.equal(entry.key, operation.key);
    assert.equal(entry.provider, "moodle");
    assert.equal(entry.readOnly, operation.readOnly);
    assert.match(entry.description, /Browser-fixture proof only; no signed-in Moodle site has run it\./);
    // Every one of them states the time zone promise, because every one of them
    // carries a wall-clock date.
    assert.match(entry.description, /time zone/);
    assert.match(entry.description, /never converts/);
    assert.match(entry.documentation, /^https:\/\/github\.com\/moodle\/moodle\/blob\/v5\.2\.2\/public\//);
    if (!operation.readOnly) {
      assert.equal(Object.hasOwn(entry.inputSchema.properties, "expected_digest"), true, operation.toolName);
      assert.match(entry.description, /moodle\/calendar:manageentries/);
      assert.match(entry.description, /activity/);
    }
  }
  assert.equal(byTool.get("moodle_create_course_event").reviewTool, "moodle_list_course_events");
  assert.equal(byTool.get("moodle_update_event").reviewTool, "moodle_get_event");
  assert.equal(byTool.get("moodle_delete_event").reviewTool, "moodle_get_event");

  // The deletion is the one operation here that cannot be undone, and it names
  // what it removes before it is approved.
  const removal = byTool.get("moodle_delete_event");
  assert.equal(removal.destructive, true);
  assert.equal(removal.irreversible, true);
  assert.match(removal.description, /Morrow cannot undo it/);
  assert.match(removal.description, /removes no activity/);
  for (const toolName of ["moodle_create_course_event", "moodle_update_event"]) {
    assert.equal(byTool.get(toolName).destructive, undefined);
    assert.equal(byTool.get(toolName).irreversible, undefined);
  }

  const worker = readFileSync(new URL("connector/extension/src/service-worker.js", root), "utf8");
  assert.match(worker, /import \{ executeMoodleCalendarInPage \} from "\.\/moodle-calendar-executor\.js";/);
  assert.match(worker, /MOODLE_CALENDAR_OPERATION_KEYS = new Set\(\[/);
  assert.match(worker, /func: executeMoodleCalendarInPage/);
  for (const operation of Object.values(operations)) {
    assert.ok(worker.includes(`"${operation.key}"`), `service-worker.js does not route ${operation.key}`);
  }

  // A deletion is never a standing Edit grant; each one is reviewed on its own.
  const actions = categoriesForBinding({ provider: "moodle" }, catalog.operations);
  const action = (toolName) => actions.find((entry) => entry.id === `action:moodle:${toolName}`);
  assert.equal(action("moodle_delete_event").availability, "review");
  assert.equal(action("moodle_delete_event").tier, "destructive");
  assert.match(action("moodle_delete_event").reviewReason, /Morrow cannot undo it/);
  assert.equal(action("moodle_delete_event").rules, undefined);
  for (const toolName of ["moodle_create_course_event", "moodle_update_event"]) {
    assert.equal(action(toolName).availability, "edit", toolName);
    assert.equal(action(toolName).tier, "standard", toolName);
    assert.equal(action(toolName).group, "Moodle · Calendar", toolName);
  }
});

test("course calendar events are read, written, and removed in the configured civil time zone", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morrow-moodle-calendar-"));
  const key = join(directory, "key.pem");
  const certificate = join(directory, "certificate.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", certificate], { stdio: "ignore" });
  const requests = [];
  const writes = [];
  const fragments = [];
  let origin = "";
  let browser;
  let model;

  // US Eastern in 2026: the clocks go forward at 02:00 on 8 March and back at
  // 02:00 on 1 November. The fixture stores the instant Moodle would store, so
  // a reader that derived a wall clock from that instant would be an hour out.
  const dstOffsetSeconds = (civil) => {
    const wall = Date.UTC(civil.year, civil.month - 1, civil.day, civil.hour, civil.minute);
    return wall >= Date.UTC(2026, 2, 8, 2) && wall < Date.UTC(2026, 10, 1, 2) ? -4 * 3_600 : -5 * 3_600;
  };
  const epochFor = (civil) => Date.UTC(civil.year, civil.month - 1, civil.day, civil.hour, civil.minute) / 1_000 - dstOffsetSeconds(civil);
  const displayTime = (civil) => `${civil.day}/${civil.month}/${civil.year}, ${civil.hour}:${String(civil.minute).padStart(2, "0")}`;
  const range = (from, to) => Array.from({ length: to - from + 1 }, (_, index) => from + index);
  const escaped = (value) => String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const select = (name, values, selected) => `<select name="${name}">${values
    .map((value) => `<option value="${value}"${String(value) === String(selected) ? " selected" : ""}>${value}</option>`).join("")}</select>`;

  const courseNames = { 2: "Foundations of Care", 3: "Anatomy and Physiology" };
  const initialModel = () => ({
    nextId: 600,
    nextDraft: 9_000,
    formMinute: 5,
    rejectNextSubmit: false,
    events: [
      { id: 501, name: "Field trip briefing", eventtype: "course", courseid: 2, civil: { year: 2026, month: 11, day: 3, hour: 9, minute: 0 }, duration: 3_600, description: "Meet at the north entrance.", location: "Room 2.14" },
      { id: 502, name: "Portfolio review is due", eventtype: "due", courseid: 2, civil: { year: 2026, month: 11, day: 12, hour: 23, minute: 59 }, duration: 0, description: "", location: "", modulename: "assign", activityname: "Portfolio review", cmid: 71, component: "mod_assign", canedit: false, candelete: false },
      { id: 503, name: "Weekly seminar", eventtype: "course", courseid: 2, civil: { year: 2026, month: 11, day: 5, hour: 14, minute: 0 }, duration: 0, description: "", location: "", repeatid: 77 },
      { id: 504, name: "Dentist", eventtype: "user", courseid: 0, civil: { year: 2026, month: 11, day: 6, hour: 8, minute: 30 }, duration: 0, description: "", location: "" },
      { id: 505, name: "Anatomy lab", eventtype: "course", courseid: 3, civil: { year: 2026, month: 11, day: 7, hour: 10, minute: 0 }, duration: 0, description: "", location: "" },
      { id: 506, name: "Placement week", eventtype: "course", courseid: 2, civil: { year: 2026, month: 11, day: 16, hour: 8, minute: 0 }, duration: 48 * 3_600, description: "", location: "", spans: 3 },
      { id: 507, name: "Skills check opens", eventtype: "open", courseid: 2, civil: { year: 2026, month: 10, day: 20, hour: 9, minute: 0 }, duration: 0, description: "", location: "", modulename: "quiz", activityname: "Skills check", cmid: 84, component: "mod_quiz", canedit: false, candelete: false },
      { id: 508, name: "Skills check closes", eventtype: "close", courseid: 2, civil: { year: 2026, month: 12, day: 4, hour: 17, minute: 0 }, duration: 0, description: "", location: "", modulename: "quiz", activityname: "Skills check", cmid: 84, component: "mod_quiz", canedit: false, candelete: false },
      { id: 509, name: "Reading week", eventtype: "course", courseid: 2, civil: { year: 2026, month: 11, day: 30, hour: 0, minute: 0 }, duration: 48 * 3_600, description: "", location: "", spans: 3 },
    ],
  });
  const exportEvent = (event) => ({
    id: event.id,
    name: event.name,
    eventtype: event.eventtype,
    timestart: epochFor(event.civil),
    timesort: epochFor(event.civil),
    timeduration: event.duration,
    visible: event.visible === undefined ? 1 : event.visible,
    repeatid: event.repeatid || 0,
    modulename: event.modulename || "",
    activityname: event.activityname || "",
    ...(event.modulename ? { instance: event.cmid } : {}),
    component: event.component || null,
    // Moodle renders its own time as display text with a link on it. Morrow
    // carries the text and never opens the link.
    formattedtime: `<a href="${origin}/calendar/view.php?view=day&amp;time=${epochFor(event.civil)}">${displayTime(event.civil)}</a>`,
    canedit: event.canedit !== false,
    candelete: event.candelete !== false,
    ...(event.courseid ? { course: { id: event.courseid, fullname: courseNames[event.courseid] || "Other course" } } : {}),
  });
  const eventsOn = (year, month, day) => model.events.filter((event) => {
    const start = Date.UTC(event.civil.year, event.civil.month - 1, event.civil.day);
    const cell = Date.UTC(year, month - 1, day);
    return cell >= start && cell < start + (event.spans || 1) * 86_400_000;
  }).map(exportEvent);
  const monthView = (year, month) => {
    const count = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const days = range(1, count).map((day) => ({
      mday: day, mon: month, year, wday: 0, timestamp: Date.UTC(year, month - 1, day) / 1_000, events: eventsOn(year, month, day),
    }));
    const weeks = [];
    for (let index = 0; index < days.length; index += 7) weeks.push({ prepadding: [], postpadding: [], days: days.slice(index, index + 7) });
    return { weeks, year, month, courseid: 2 };
  };
  const eventForm = (event) => {
    const draft = String(model.nextDraft += 1);
    // Moodle fills a new form's date from the clock, and both forms' "until"
    // date from the clock. Neither can be compared between two loads.
    model.formMinute = (model.formMinute + 1) % 60;
    const clock = { year: 2026, month: 10, day: 20, hour: 13, minute: model.formMinute };
    const civil = event ? event.civil : clock;
    const minutes = event && event.duration % 60 === 0 ? event.duration / 60 : 0;
    return `<div class="modal-body"><form method="post" action="#" id="id_calendar_event_form">
      <input type="hidden" name="id" value="${event ? event.id : 0}">
      <input type="hidden" name="userid" value="3">
      <input type="hidden" name="modulename" value="">
      <input type="hidden" name="instance" value="0">
      <input type="hidden" name="visible" value="1">
      <input type="hidden" name="sesskey" value="${SESSKEY}">
      <input type="hidden" name="_qf__core_calendar_local_event_forms_${event ? "update" : "create"}" value="1">
      <input type="text" name="name" value="${escaped(event ? event.name : "")}">
      ${select("timestart[day]", range(1, 31), civil.day)}
      ${select("timestart[month]", range(1, 12), civil.month)}
      ${select("timestart[year]", range(2020, 2030), civil.year)}
      ${select("timestart[hour]", range(0, 23), civil.hour)}
      ${select("timestart[minute]", range(0, 59), civil.minute)}
      <textarea name="description[text]">${escaped(event ? event.description : "")}</textarea>
      <input type="hidden" name="description[format]" value="1">
      <input type="hidden" name="description[itemid]" value="${draft}">
      <input type="text" name="location" value="${escaped(event ? event.location : "")}">
      ${select("eventtype", ["user", "course", "group"], event ? event.eventtype : "user")}
      <select name="courseid">${[2, 3].map((entry) => `<option value="${entry}"${entry === 2 ? " selected" : ""}>${courseNames[entry]}</option>`).join("")}</select>
      <input type="radio" name="duration" value="0"${minutes ? "" : " checked"}>
      <input type="radio" name="duration" value="1">
      <input type="radio" name="duration" value="2"${minutes ? " checked" : ""}>
      <input type="text" name="timedurationminutes" value="${minutes}">
      ${select("timedurationuntil[day]", range(1, 31), clock.day)}
      ${select("timedurationuntil[month]", range(1, 12), clock.month)}
      ${select("timedurationuntil[year]", range(2020, 2030), clock.year)}
      ${select("timedurationuntil[hour]", range(0, 23), clock.hour)}
      ${select("timedurationuntil[minute]", range(0, 59), clock.minute)}
      <input type="checkbox" name="repeat" value="1">
      <input type="text" name="repeats" value="1">
    </form></div>`;
  };

  const server = createServer({ key: readFileSync(key), cert: readFileSync(certificate) }, async (request, response) => {
    const target = new URL(request.url || "/", origin);
    requests.push({ method: request.method, pathname: target.pathname, search: target.search });
    if (request.method === "GET" && target.pathname === "/course/view.php") {
      const config = { wwwroot: origin, sesskey: SESSKEY, userId: 3, courseId: 2, courseContextId: COURSE_CONTEXT_ID, usertimezone: TIME_ZONE };
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<!doctype html><body class="path-course course-2"><h1>Foundations of Care</h1><script>var M = { cfg: ${JSON.stringify(config)} };</script></body>`);
      return;
    }
    if (request.method === "POST" && target.pathname === "/lib/ajax/service.php") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const call = JSON.parse(Buffer.concat(chunks).toString("utf8"))[0];
      const send = (payload) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify([payload]));
      };
      if (target.searchParams.get("sesskey") !== SESSKEY || target.searchParams.get("info") !== call.methodname) {
        send({ error: "Invalid session key" });
        return;
      }
      if (call.methodname === "core_calendar_get_calendar_monthly_view") {
        send({ data: monthView(call.args.year, call.args.month) });
        return;
      }
      if (call.methodname === "core_calendar_get_calendar_event_by_id") {
        const found = model.events.find((event) => event.id === call.args.eventid);
        send(found ? { data: { event: exportEvent(found), warnings: [] } } : { error: "Invalid event", exception: { errorcode: "invalidevent" } });
        return;
      }
      if (call.methodname === "core_get_fragment") {
        fragments.push(call.args);
        const named = (call.args.args || []).find((entry) => entry.name === "eventid");
        const found = named ? model.events.find((event) => event.id === Number(named.value)) : null;
        send(named && !found ? { error: "Invalid event" } : { data: eventForm(found) });
        return;
      }
      if (call.methodname === "core_calendar_submit_create_update_form") {
        // The newest draft file area at the moment of the dispatch. The body must
        // carry that one, which is the form Moodle rendered immediately before it.
        writes.push({ methodname: call.methodname, formdata: String(call.args.formdata || ""), latestDraft: model.nextDraft });
        const form = new URLSearchParams(String(call.args.formdata || ""));
        if (form.get("sesskey") !== SESSKEY) {
          send({ error: "Invalid session key" });
          return;
        }
        if (model.rejectNextSubmit) {
          model.rejectNextSubmit = false;
          send({ data: { event: null, validationerror: true } });
          return;
        }
        const civil = {
          year: Number(form.get("timestart[year]")),
          month: Number(form.get("timestart[month]")),
          day: Number(form.get("timestart[day]")),
          hour: Number(form.get("timestart[hour]")),
          minute: Number(form.get("timestart[minute]")),
        };
        const minutes = Number(form.get("timedurationminutes") || 0);
        const identifier = Number(form.get("id") || 0);
        const record = identifier
          ? model.events.find((event) => event.id === identifier)
          : { id: (model.nextId += 1) };
        if (!record) {
          send({ error: "Invalid event" });
          return;
        }
        record.name = String(form.get("name") || "");
        record.location = String(form.get("location") || "");
        record.description = String(form.get("description[text]") || "");
        record.eventtype = String(form.get("eventtype") || "");
        record.courseid = Number(form.get("courseid") || 0);
        record.civil = civil;
        record.duration = form.get("duration") === "2" ? minutes * 60 : 0;
        if (!identifier) model.events.push(record);
        send({ data: { event: exportEvent(record), validationerror: false } });
        return;
      }
      if (call.methodname === "core_calendar_delete_calendar_events") {
        writes.push({ methodname: call.methodname, args: call.args });
        const targetId = call.args.events[0].eventid;
        model.events = model.events.filter((event) => event.id !== targetId);
        send({ data: null });
        return;
      }
      send({ error: "Unknown method" });
      return;
    }
    response.writeHead(404).end();
  });

  try {
    await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", (error) => (error ? reject(error) : resolve())));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");
    origin = `https://127.0.0.1:${address.port}`;
    model = initialModel();
    browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
    const page = await browser.newPage({ ignoreHTTPSErrors: true });
    await page.goto(`${origin}/course/view.php?id=2`);
    const binding = { origin, siteUrl: `${origin}/`, principalId: "3", courseId: "2" };
    const execute = (operation, argumentsValue, expiresAt = Date.now() + 60_000) => page.evaluate(
      executeMoodleCalendarInPage,
      JSON.stringify({ mode: "execute", operation, arguments: argumentsValue, binding, expiresAt }),
    );
    const listNovember = () => execute(operations.list, { course_id: 2, year: 2026, month: 11, month_count: 1 });
    const monthDigest = async () => {
      const listed = await listNovember();
      assert.equal(listed.ok, true, JSON.stringify(listed));
      return listed.data.months[0].month_digest;
    };
    const eventDigest = async (eventId) => {
      const read = await execute(operations.event, { course_id: 2, event_id: eventId });
      assert.equal(read.ok, true, JSON.stringify(read));
      return read.snapshot_digest;
    };
    const refuse = async (operation, argumentsValue, error, expiresAt) => {
      const before = writes.length;
      const result = await execute(operation, argumentsValue, expiresAt);
      assert.deepEqual([result.ok, result.sent, result.error], [false, false, error], JSON.stringify(result));
      assert.equal(writes.length, before, `${operation.toolName} dispatched a write while refusing ${error}`);
    };

    // 1. The month lists every event that names this course, with the civil day
    // Moodle itself put it on, and nothing else this person can see.
    const listed = await listNovember();
    assert.equal(listed.ok, true, JSON.stringify(listed));
    assert.equal(listed.complete, true);
    assert.equal(listed.data.time_zone, TIME_ZONE);
    assert.equal(listed.data.proof.wall_clock_conversion, "none");
    assert.equal(listed.data.proof.time_zone_source, "moodle_user_configuration");
    assert.deepEqual(listed.data.months[0].events.map((entry) => entry.event_id), [501, 503, 502, 506, 509]);
    assert.equal(listed.data.months[0].time_zone, TIME_ZONE);
    assert.deepEqual(listed.targets, [{ field: "course_id", label: "Course", name: "Foundations of Care" }]);
    const briefing = listed.data.months[0].events.find((entry) => entry.event_id === 501);
    assert.deepEqual(briefing.civil_start, { year: 2026, month: 11, day: 3 });
    assert.equal(briefing.display_time, "3/11/2026, 9:00");
    assert.equal(briefing.is_activity_event, false);
    assert.equal(briefing.spans_days, false);
    // A multi-day event is listed once, on the day it starts.
    assert.equal(listed.data.months[0].events.find((entry) => entry.event_id === 506).spans_days, true);
    assert.equal(listed.data.months[0].events.find((entry) => entry.event_id === 502).is_activity_event, true);
    assert.match(listed.data.months[0].month_digest, /^[a-f0-9]{64}$/);
    assert.equal(listed.data.months[0].events.find((entry) => entry.event_id === 502).activity_course_module_id, 71);

    // 2. The same course read as dates: every dated entry it carries over the
    // window, grouped by the activity that owns it, with the course's own
    // events apart from them. Moodle ships no core Dates page, so this is the
    // course calendar and nothing else.
    const formsBeforeDates = fragments.length;
    const dates = await execute(operations.dates, { course_id: 2, year: 2026, month: 10, month_count: 3 });
    assert.equal(dates.ok, true, JSON.stringify(dates));
    assert.equal(dates.complete, true);
    assert.equal(dates.data.time_zone, TIME_ZONE);
    assert.equal(dates.data.proof.wall_clock_conversion, "none");
    assert.equal(dates.data.proof.time_zone_source, "moodle_user_configuration");
    assert.equal(dates.data.dates_source, "course_calendar");
    assert.deepEqual(dates.data.from, { year: 2026, month: 10 });
    assert.equal(dates.data.month_count, 3);
    // The personal event and the other course's event are not this course's.
    assert.equal(dates.data.dated_entry_count, 7);
    assert.equal(dates.data.activity_count, 2);
    assert.deepEqual(dates.data.activities.map((entry) => entry.course_module_id), [84, 71]);
    assert.deepEqual(dates.targets, [{ field: "course_id", label: "Course", name: "Foundations of Care" }]);
    assert.match(dates.snapshot_digest, /^[a-f0-9]{64}$/);
    // One activity holds both of its dates, although they fall in two months.
    const skillsCheck = dates.data.activities.find((entry) => entry.course_module_id === 84);
    assert.deepEqual([skillsCheck.activity_module, skillsCheck.activity_name, skillsCheck.date_count], ["quiz", "Skills check", 2]);
    assert.deepEqual(skillsCheck.dates.map((entry) => entry.event_type), ["open", "close"]);
    assert.deepEqual(skillsCheck.dates.map((entry) => entry.civil_start), [
      { year: 2026, month: 10, day: 20 },
      { year: 2026, month: 12, day: 4 },
    ]);
    assert.deepEqual(skillsCheck.dates.map((entry) => entry.display_time), ["20/10/2026, 9:00", "4/12/2026, 17:00"]);
    // The two dates sit on opposite sides of the November change of clocks. The
    // civil hours are Moodle's own: neither is the hour of its instant, and the
    // real interval between them is one hour longer than the civil clocks say.
    assert.notEqual(new Date(skillsCheck.dates[0].time_start_seconds * 1_000).getUTCHours(), 9);
    assert.notEqual(new Date(skillsCheck.dates[1].time_start_seconds * 1_000).getUTCHours(), 17);
    assert.equal(skillsCheck.dates[1].time_start_seconds - skillsCheck.dates[0].time_start_seconds, 45 * 86_400 + 8 * 3_600 + 3_600);
    // A course event that runs from November into December is kept once, on the
    // day it starts, and the whole window is what says it spans days.
    assert.deepEqual(dates.data.course_entries.map((entry) => entry.event_id), [501, 503, 506, 509]);
    const readingWeek = dates.data.course_entries.find((entry) => entry.event_id === 509);
    assert.deepEqual(readingWeek.civil_start, { year: 2026, month: 11, day: 30 });
    assert.equal(readingWeek.spans_days, true);
    // An activity date is read here and never opened for editing.
    assert.equal(fragments.length, formsBeforeDates, "the dates read opened an event form");

    // 3. One exact event carries the wall-clock date from the event's own form,
    // and states what a deletion would remove before one is approved.
    const briefingRead = await execute(operations.event, { course_id: 2, event_id: 501 });
    assert.equal(briefingRead.ok, true, JSON.stringify(briefingRead));
    assert.deepEqual(briefingRead.data.civil_start, { year: 2026, month: 11, day: 3, hour: 9, minute: 0 });
    assert.equal(briefingRead.data.description, "Meet at the north entrance.");
    assert.equal(briefingRead.data.location, "Room 2.14");
    assert.equal(briefingRead.data.duration_minutes, 60);
    assert.equal(briefingRead.data.writable_by_morrow, true);
    assert.equal(briefingRead.data.deletion_reversible_by_morrow, false);
    assert.ok(briefingRead.data.deletion_removes.some((line) => /calendar event itself/.test(line)));
    assert.ok(briefingRead.data.deletion_keeps.some((line) => /No activity/.test(line)));
    assert.deepEqual(briefingRead.targets, [
      { field: "course_id", label: "Course", name: "Foundations of Care" },
      { field: "event_id", label: "Event", name: "Field trip briefing" },
    ]);
    // The same read, twice, gives the same digest, although Moodle issues a new
    // draft file area every time it renders the form.
    assert.equal(briefingRead.snapshot_digest, await eventDigest(501));

    // An activity's own date is read and never opened for editing.
    const fragmentCount = fragments.length;
    const activityRead = await execute(operations.event, { course_id: 2, event_id: 502 });
    assert.equal(activityRead.ok, true, JSON.stringify(activityRead));
    assert.equal(activityRead.data.is_activity_event, true);
    assert.equal(activityRead.data.activity_module, "assign");
    assert.equal(activityRead.data.writable_by_morrow, false);
    assert.equal(activityRead.data.civil_start, null);
    assert.equal(fragments.length, fragmentCount, "the activity event opened an event form");

    // 4. Every refusal happens before any request that changes the calendar.
    const november = await monthDigest();
    const draft = (values) => ({
      course_id: 2, name: "Clinic orientation", description: "Bring your placement folder.", location: "Simulation suite",
      year: 2026, month: 11, day: 1, hour: 1, minute: 30, duration_minutes: 90, expected_digest: november, ...values,
    });
    await refuse(operations.create, draft({ expected_digest: "0".repeat(64) }), "moodle_expected_digest_mismatch");
    await refuse(operations.create, draft({ name: "<b>Clinic</b>" }), "moodle_calendar_arguments_invalid");
    await refuse(operations.create, draft({ description: "Bring folder & pen." }), "moodle_calendar_arguments_invalid");
    await refuse(operations.create, draft({ name: "" }), "moodle_calendar_arguments_invalid");
    // 31 November is not a date. Moodle would roll it into December.
    await refuse(operations.create, draft({ day: 31 }), "moodle_calendar_arguments_invalid");
    await refuse(operations.create, draft({ course_id: 3 }), "moodle_calendar_arguments_invalid");
    await refuse(operations.create, draft({ duration_minutes: -30 }), "moodle_calendar_arguments_invalid");
    await refuse(operations.create, draft({}), "moodle_execution_expired", Date.now() - 1);
    const change = (values) => ({ course_id: 2, event_id: 501, name: "Field trip briefing", description: "Meet at the north entrance.", location: "Room 2.14", year: 2026, month: 11, day: 3, hour: 9, minute: 0, duration_minutes: 60, expected_digest: briefingRead.snapshot_digest, ...values });
    await refuse(operations.update, change({}), "moodle_calendar_event_unchanged");
    await refuse(operations.update, change({ event_id: 502, expected_digest: activityRead.snapshot_digest, hour: 10 }), "moodle_calendar_activity_event_refused");
    await refuse(operations.remove, { course_id: 2, event_id: 502, expected_digest: activityRead.snapshot_digest }, "moodle_calendar_activity_event_refused");
    const seminarDigest = await eventDigest(503);
    await refuse(operations.update, change({ event_id: 503, expected_digest: seminarDigest, hour: 15 }), "moodle_calendar_repeat_event_refused");
    await refuse(operations.remove, { course_id: 2, event_id: 503, expected_digest: seminarDigest }, "moodle_calendar_repeat_event_refused");
    const otherCourseDigest = await eventDigest(505);
    await refuse(operations.update, change({ event_id: 505, expected_digest: otherCourseDigest, hour: 11 }), "moodle_calendar_event_not_in_course");
    const personalDigest = await eventDigest(504);
    await refuse(operations.remove, { course_id: 2, event_id: 504, expected_digest: personalDigest }, "moodle_calendar_event_not_in_course");
    await refuse(operations.event, { course_id: 2, event_id: 999 }, "moodle_calendar_event_unavailable");
    assert.equal(writes.length, 0);

    // 5. One dispatch creates the event, on the day the clocks go back, and the
    // saved wall-clock date is exactly the approved one.
    const created = await execute(operations.create, draft({ expected_digest: await monthDigest() }));
    assert.equal(created.ok, true, JSON.stringify(created));
    assert.deepEqual(created.verification, { schema: "morrow.browser-verification.v1", status: "verified" });
    assert.equal(writes.length, 1);
    assert.equal(writes[0].methodname, "core_calendar_submit_create_update_form");
    assert.deepEqual(created.data.civil_start, { year: 2026, month: 11, day: 1, hour: 1, minute: 30 });
    assert.equal(created.data.name, "Clinic orientation");
    assert.equal(created.data.description, "Bring your placement folder.");
    assert.equal(created.data.location, "Simulation suite");
    assert.equal(created.data.duration_seconds, 5_400);
    assert.equal(created.data.event_type, "course");
    assert.equal(created.data.time_zone, TIME_ZONE);
    assert.deepEqual(created.targets, [
      { field: "course_id", label: "Course", name: "Foundations of Care" },
      { field: "event_id", label: "Event", name: "Clinic orientation" },
    ]);
    const createdId = created.data.event_id;
    const createdStart = created.data.time_start_seconds;
    assert.equal(createdStart, epochFor({ year: 2026, month: 11, day: 1, hour: 1, minute: 30 }));
    // The instant Moodle stored, read as a wall clock anywhere else, is not
    // 01:30. The returned civil hour is the site's, not a converted one.
    assert.notEqual(new Date(createdStart * 1_000).getUTCHours(), created.data.civil_start.hour);

    // The one dispatch carried the form Moodle had just rendered: its own
    // hidden controls, the newest draft file area, and no repeat.
    const body = new URLSearchParams(writes[0].formdata);
    assert.equal(body.get("sesskey"), SESSKEY);
    assert.equal(body.get("userid"), "3");
    assert.equal(body.get("_qf__core_calendar_local_event_forms_create"), "1");
    assert.equal(body.get("description[format]"), "1");
    assert.equal(body.get("description[itemid]"), String(writes[0].latestDraft));
    assert.equal(body.get("eventtype"), "course");
    assert.equal(body.get("courseid"), "2");
    assert.equal(body.get("duration"), "2");
    assert.equal(body.get("timedurationminutes"), "90");
    assert.deepEqual([body.get("timestart[year]"), body.get("timestart[month]"), body.get("timestart[day]"), body.get("timestart[hour]"), body.get("timestart[minute]")], ["2026", "11", "1", "1", "30"]);
    assert.equal(body.get("repeat"), null);
    assert.equal(body.get("repeats"), null);

    // 6. Moving the event across the same day's daylight-saving change keeps
    // the approved wall clock. Two civil hours later is three real hours later.
    const moved = await execute(operations.update, change({
      event_id: createdId, name: "Clinic orientation", description: "Bring your placement folder.", location: "Simulation suite",
      hour: 3, minute: 30, day: 1, duration_minutes: 90, expected_digest: await eventDigest(createdId),
    }));
    assert.equal(moved.ok, true, JSON.stringify(moved));
    assert.deepEqual(moved.verification, { schema: "morrow.browser-verification.v1", status: "verified" });
    assert.equal(writes.length, 2);
    assert.deepEqual(moved.data.civil_start, { year: 2026, month: 11, day: 1, hour: 3, minute: 30 });
    assert.equal(moved.data.time_start_seconds - createdStart, 3 * 3_600);
    assert.equal(moved.data.duration_seconds, 5_400);
    assert.notEqual(new Date(moved.data.time_start_seconds * 1_000).getUTCHours(), moved.data.civil_start.hour);

    // 7. A stale review refuses the deletion before it is dispatched.
    const removalDigest = await eventDigest(createdId);
    model.events.find((event) => event.id === createdId).name = "Renamed by someone else";
    await refuse(operations.remove, { course_id: 2, event_id: createdId, expected_digest: removalDigest }, "moodle_expected_digest_mismatch");

    // 8. One dispatch removes the event, and the month comes back as the
    // reviewed month with exactly that event gone.
    const removed = await execute(operations.remove, { course_id: 2, event_id: createdId, expected_digest: await eventDigest(createdId) });
    assert.equal(removed.ok, true, JSON.stringify(removed));
    assert.deepEqual(removed.verification, { schema: "morrow.browser-verification.v1", status: "verified" });
    assert.equal(writes.length, 3);
    assert.equal(writes[2].methodname, "core_calendar_delete_calendar_events");
    assert.deepEqual(writes[2].args, { events: [{ eventid: createdId, repeat: false }] });
    assert.equal(removed.data.proof.reversible_by_morrow, false);
    assert.ok(removed.data.proof.removes.length >= 1);
    assert.equal(removed.data.month.events.some((entry) => entry.event_id === createdId), false);
    assert.deepEqual(removed.data.month.events.map((entry) => entry.event_id), [501, 503, 502, 506, 509]);
    await refuse(operations.event, { course_id: 2, event_id: createdId }, "moodle_calendar_event_unavailable");

    // 9. A form Moodle rejects is reported as dispatched and not retried.
    model.rejectNextSubmit = true;
    const rejected = await execute(operations.create, draft({ name: "Rejected event", expected_digest: await monthDigest() }));
    assert.deepEqual(
      [rejected.ok, rejected.sent, rejected.outcomeUnknown, rejected.error, rejected.verification.status],
      [false, true, true, "moodle_calendar_form_rejected", "unconfirmed"],
    );
    assert.equal(writes.length, 4);

    // 10. A lost response after the dispatch is applied-or-unknown, and Morrow
    // sends nothing a second time.
    await page.evaluate(() => {
      const nativeFetch = globalThis.fetch;
      globalThis.fetch = async (...parameters) => {
        const target = new URL(String(parameters[0]), globalThis.location.href);
        if (String(parameters[1]?.method || "GET").toUpperCase() === "POST"
          && target.searchParams.get("info") === "core_calendar_submit_create_update_form") {
          const response = await nativeFetch(...parameters);
          globalThis.fetch = nativeFetch;
          await response.text();
          throw new TypeError("submit response lost after dispatch");
        }
        return nativeFetch(...parameters);
      };
    });
    const lost = await execute(operations.create, draft({ name: "Lost response", expected_digest: await monthDigest() }));
    assert.deepEqual(
      [lost.ok, lost.sent, lost.outcomeUnknown, lost.error, lost.verification.status],
      [false, true, true, "moodle_calendar_write_unconfirmed", "unconfirmed"],
    );
    assert.equal(writes.length, 5);
    // Moodle did save it. Morrow reports that it cannot tell, and never repeats
    // the request.
    assert.equal(model.events.some((event) => event.name === "Lost response"), true);

    // 11. Without a stated time zone Morrow reports no date at all.
    await page.evaluate(() => { delete globalThis.M.cfg.usertimezone; });
    for (const [operation, argumentsValue] of [
      [operations.list, { course_id: 2, year: 2026, month: 11, month_count: 1 }],
      [operations.dates, { course_id: 2, year: 2026, month: 11, month_count: 1 }],
      [operations.event, { course_id: 2, event_id: 501 }],
    ]) {
      const refused = await execute(operation, argumentsValue);
      assert.deepEqual([refused.ok, refused.sent, refused.error], [false, false, "moodle_calendar_timezone_unavailable"], JSON.stringify(refused));
    }
    await refuse(operations.remove, { course_id: 2, event_id: 501, expected_digest: "a".repeat(64) }, "moodle_calendar_timezone_unavailable");
    await page.evaluate((zone) => { globalThis.M.cfg.usertimezone = zone; }, TIME_ZONE);

    // 12. Nothing in this executor opened an activity or a calendar page.
    assert.equal(requests.some((entry) => entry.pathname.startsWith("/mod/")), false);
    assert.equal(requests.some((entry) => entry.pathname === "/calendar/view.php"), false);
    assert.equal(requests.filter((entry) => entry.pathname === "/course/view.php").length, 1);
    assert.equal(writes.length, 5);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
});
