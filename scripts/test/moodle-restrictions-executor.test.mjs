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
import { executeMoodleRestrictionsInPage } from "../../connector/extension/src/moodle-restrictions-executor.js";

const ANCHOR_SESSION = "moodle-session-a";
const FOREIGN_SESSION = "moodle-session-b";
// A profile restriction can name one person. This value must never appear in a
// bridge result.
const PROFILE_VALUE = "ada@example.edu";

const operations = Object.freeze({
  activityRead: { key: "moodle.form.course.modedit.restrictions.read.v1", toolName: "moodle_get_activity_restrictions", provider: "moodle", readOnly: true },
  activityWrite: { key: "moodle.form.course.modedit.restrictions.write.v1", toolName: "moodle_update_activity_restrictions", provider: "moodle", readOnly: false },
  sectionRead: { key: "moodle.form.course.editsection.restrictions.read.v1", toolName: "moodle_get_section_restrictions", provider: "moodle", readOnly: true },
  sectionWrite: { key: "moodle.form.course.editsection.restrictions.write.v1", toolName: "moodle_update_section_restrictions", provider: "moodle", readOnly: false },
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

const PROFILE_DIGEST = digestOf(PROFILE_VALUE);

// The native restriction tree of course/moodleform_mod.php, exactly as Moodle
// stores it: an outer set with a per-child show flag, one nested set, and one
// profile condition whose value names a person.
// https://github.com/moodle/moodle/blob/v5.2.2/public/availability/classes/tree.php
const ACTIVITY_JSON = JSON.stringify({
  op: "&",
  c: [
    { type: "date", d: ">=", t: 1767225600 },
    { type: "profile", op: "isequalto", sf: "email", v: PROFILE_VALUE },
    { op: "|", c: [{ type: "group", id: 4 }, { type: "grouping", activity: true }] },
  ],
  showc: [true, false, true],
});
const ACTIVITY_TREE = Object.freeze({
  match: "all",
  children: [
    { type: "date", direction: "from", time: 1767225600, hidden_entirely: false },
    { type: "profile", field: "email", field_kind: "standard", operator: "isequalto", value_digest: PROFILE_DIGEST, hidden_entirely: true },
    { match: "any", children: [{ type: "group", group_id: 4 }, { type: "grouping", activity_grouping: true }], hidden_entirely: false },
  ],
});
const SECTION_JSON = JSON.stringify({
  op: "|",
  c: [{ type: "grade", id: 12, min: 50 }, { type: "completion", cm: 6, e: 1 }],
  show: false,
});
const SECTION_TREE = Object.freeze({
  match: "any",
  children: [
    { type: "grade", grade_item_id: 12, min: 50 },
    { type: "completion", module_id: 6, required: "complete" },
  ],
  hidden_entirely: true,
});
// A condition class this parser has never seen. An installed availability
// plugin can add one, and the browser cannot resolve what it means.
const PLUGIN_JSON = JSON.stringify({
  op: "&",
  c: [{ type: "language", id: "en" }],
  showc: [true],
});
const EMPTY_JSON = JSON.stringify({ op: "&", c: [], showc: [] });

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

const escape = (value) => String(value)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * The native activity settings form of one Forum, with the Restrict access
 * section Moodle builds in course/moodleform_mod.php.
 * https://github.com/moodle/moodle/blob/v5.2.2/public/course/moodleform_mod.php
 */
function activityForm(state, action, sesskey, draft, dueDay) {
  const activity = state.activity;
  const restrictions = state.availabilityEnabled
    ? `<fieldset id="id_availabilityconditionsheader">
        <input type="hidden" name="mform_isexpanded_id_availabilityconditionsheader" value="1">
        <textarea name="availabilityconditionsjson">${escape(activity.availability)}</textarea>
        <div id="fitem_id_availabilityconditionsjson"><div class="availability-field"></div></div>
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
        <input type="text" name="name" value="${escape(activity.name)}">
        <textarea name="introeditor[text]">${escape(activity.intro)}</textarea>
        <input type="hidden" name="introeditor[format]" value="1">
        <input type="hidden" name="introeditor[itemid]" value="${draft}">
      </fieldset>
      <fieldset id="id_availability">
        ${dateTimeGroup("duedate", { enabled: false, year: "2026", month: "10", day: dueDay, hour: "0", minute: "0" })}
      </fieldset>
      ${restrictions}
      <input type="checkbox" name="coursecontentnotification" value="1">
      <input type="submit" name="submitbutton2" value="Save and return to course">
      <input type="submit" name="submitbutton" value="Save and display">
      <input type="submit" name="cancel" value="Cancel">
    </form>
  </body></html>`;
}

/**
 * The native section settings form of course/editsection_form.php.
 * https://github.com/moodle/moodle/blob/v5.2.2/public/course/editsection_form.php
 */
function sectionForm(state, action, sesskey, draft) {
  const section = state.section;
  return `<!doctype html><html><body class="path-course course-2">
    <form method="post" action="${action}" id="id_editsection_form">
      <input type="hidden" name="id" value="7">
      <input type="hidden" name="course" value="2">
      <input type="hidden" name="returnurl" value="/course/view.php?id=2">
      <input type="hidden" name="sesskey" value="${sesskey}">
      <input type="hidden" name="_qf__editsection_form" value="1">
      <input type="text" name="name" value="${escape(section.name)}">
      <textarea name="summary_editor[text]">${escape(section.summary)}</textarea>
      <input type="hidden" name="summary_editor[format]" value="1">
      <input type="hidden" name="summary_editor[itemid]" value="${draft}">
      <fieldset id="id_availabilityconditions">
        <textarea name="availabilityconditionsjson">${escape(section.availability)}</textarea>
      </fieldset>
      <input type="submit" name="submitbutton" value="Save changes">
      <input type="submit" name="cancel" value="Cancel">
    </form>
  </body></html>`;
}

function readBody(request) {
  return new Promise((resolve) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

test("Moodle restrictions executor round-trips a nested tree, refuses a condition class it does not know, and sends one POST per change", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morrow-moodle-restrictions-"));
  const key = join(directory, "key.pem");
  const certificate = join(directory, "certificate.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", certificate], { stdio: "ignore" });

  const state = {
    activity: { name: "Week 1 discussion", intro: "<p>Introduce yourself.</p>", availability: ACTIVITY_JSON },
    section: { name: "Week 3", summary: "<p>Evidence week.</p>", availability: SECTION_JSON },
    availabilityEnabled: true,
    introFiles: "empty",
    session: ANCHOR_SESSION,
    sessionQueue: [],
    // What something else stores instead of what the change sent.
    changeOnSave: "",
  };
  const posts = [];
  const requests = [];
  const draftStates = new Map();
  let draftCounter = 900;
  // Moodle re-defaults a switched-off date selector on every load of the same
  // form, so the fixture moves it exactly as Moodle would.
  let dueDay = 10;
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
      dueDay = dueDay === 28 ? 10 : dueDay + 1;
      const sesskey = state.sessionQueue.shift() || state.session;
      response.writeHead(200, { "content-type": "text/html" });
      response.end(activityForm(state, "/course/modedit.php?update=6&amp;return=0", sesskey, draft, String(dueDay)));
      return;
    }
    if (request.method === "GET" && url.pathname === "/course/editsection.php" && url.search === "?id=7") {
      const draft = String(++draftCounter);
      draftStates.set(draft, "empty");
      const sesskey = state.sessionQueue.shift() || state.session;
      response.writeHead(200, { "content-type": "text/html" });
      response.end(sectionForm(state, "/course/editsection.php?id=7", sesskey, draft));
      return;
    }
    if (request.method === "POST" && url.pathname === "/repository/draftfiles_ajax.php" && url.search === "?action=list") {
      const values = new URLSearchParams(await readBody(request));
      const itemState = draftStates.get(values.get("itemid") || "");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(itemState === "nonempty"
        ? JSON.stringify({ filecount: 1, list: [{ filename: "brief.pdf", filepath: "/", size: 2048 }], tree: { children: [] } })
        : JSON.stringify({ filecount: 0, list: [], tree: { children: [] } }));
      return;
    }
    if (request.method === "POST" && url.pathname === "/course/modedit.php") {
      const values = new URLSearchParams(await readBody(request));
      posts.push({ path: url.pathname, values });
      assert.equal(values.get("sesskey"), ANCHOR_SESSION);
      assert.equal(values.get("submitbutton2"), "Save and return to course");
      assert.equal(values.get("submitbutton"), null);
      // The native content change notification mails every enrolled learner.
      assert.equal(values.get("coursecontentnotification"), null);
      assert.equal(values.get("name"), state.activity.name);
      state.activity.availability = state.changeOnSave || String(values.get("availabilityconditionsjson") ?? "");
      response.writeHead(303, { location: "/course/view.php?id=2#module-6" });
      response.end();
      return;
    }
    if (request.method === "POST" && url.pathname === "/course/editsection.php") {
      const values = new URLSearchParams(await readBody(request));
      posts.push({ path: url.pathname, values });
      assert.equal(values.get("sesskey"), ANCHOR_SESSION);
      assert.equal(values.get("submitbutton"), "Save changes");
      assert.equal(values.get("name"), state.section.name);
      assert.equal(values.get("summary_editor[text]"), state.section.summary);
      state.section.availability = state.changeOnSave || String(values.get("availabilityconditionsjson") ?? "");
      // A course format that shows one section per page returns to the section.
      response.writeHead(303, { location: "/course/section.php?id=7" });
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
    if (!address || typeof address === "string") throw new Error("restrictions test server did not bind");
    origin = `https://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
    context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    await page.goto(`${origin}/course/view.php?id=2`);
    const binding = { origin, siteUrl: `${origin}/`, principalId: "3", courseId: "2" };
    const execute = (operation, argumentsValue) => page.evaluate(
      executeMoodleRestrictionsInPage,
      JSON.stringify({ mode: "execute", operation, arguments: argumentsValue, binding, expiresAt: Date.now() + 60_000 }),
    );
    const executeExpired = (operation, argumentsValue) => page.evaluate(
      executeMoodleRestrictionsInPage,
      JSON.stringify({ mode: "execute", operation, arguments: argumentsValue, binding, expiresAt: Date.now() - 1 }),
    );
    const readActivity = () => execute(operations.activityRead, { course_id: 2, module_id: 6 });
    const readSection = () => execute(operations.sectionRead, { course_id: 2, section_id: 7 });
    const loseNextPostResponse = (target) => page.evaluate((path) => {
      const nativeFetch = globalThis.fetch;
      globalThis.fetch = async (...parameters) => {
        const response = await nativeFetch(...parameters);
        const request = new URL(parameters[0], globalThis.location.href);
        if (String(parameters[1]?.method || "GET").toUpperCase() === "POST" && request.pathname === path) {
          globalThis.fetch = nativeFetch;
          throw new TypeError("post response lost after dispatch");
        }
        return response;
      };
    }, target);

    // An approval window that has closed sends and reads nothing at all.
    assert.deepEqual(await executeExpired(operations.activityRead, { course_id: 2, module_id: 6 }), {
      ok: false, sent: false, error: "moodle_execution_expired",
    });
    assert.deepEqual(requests.filter((entry) => /modedit\.php|editsection\.php/.test(entry)), []);

    // A form that does not carry the signed-in session key is refused before anything is sent.
    state.sessionQueue.push(FOREIGN_SESSION);
    assert.deepEqual(await readActivity(), { ok: false, sent: false, status: 200, error: "moodle_form_session_mismatch" });
    assert.equal(posts.length, 0);

    const read = await readActivity();
    assert.equal(read.ok, true, JSON.stringify(read));
    assert.equal(read.data.course_id, "2");
    assert.equal(read.data.module_id, "6");
    assert.equal(read.data.module_type, "forum");
    assert.equal(read.data.activity_name, "Week 1 discussion");
    assert.equal(read.data.restrictions_available, true);
    assert.equal(read.data.restrictions_understood, true);
    assert.deepEqual(read.data.proof, {
      method: "native_form_read",
      route: "/course/modedit.php",
      control: "availabilityconditionsjson",
      required_capability: "moodle/course:manageactivities",
      scope: "activity_restrictions_only",
    });
    // The saved tree, with the nested set and the per-child hidden flags.
    assert.deepEqual(read.data.restrictions, ACTIVITY_TREE);
    assert.deepEqual(read.data.restriction_lines, [
      { depth: 0, text: "A learner must match all of these:" },
      { depth: 1, text: "Date from 1767225600 in Unix seconds (2026-01-01T00:00:00.000Z). Shown greyed out, with the restriction, to a learner who does not match." },
      { depth: 1, text: "Profile field email, a standard field, is equal to a value that stays in the browser. Hidden entirely from a learner who does not match." },
      { depth: 1, text: "A learner must match any of these: Shown greyed out, with the restriction, to a learner who does not match." },
      { depth: 2, text: "Group 4." },
      { depth: 2, text: "The grouping this activity uses." },
    ]);
    assert.deepEqual(read.data.file_areas, [{ field: "introeditor[itemid]", state: "empty" }]);
    // The profile value and the session key stay in the page.
    const readText = JSON.stringify(read);
    assert.ok(!readText.includes(PROFILE_VALUE), "a profile restriction value must not cross the bridge");
    assert.ok(!readText.includes(ANCHOR_SESSION), "the session key must not cross the bridge");
    // The disclosed protected settings are the exact digest preimage.
    assert.equal(
      digestOf({ courseId: "2", targetId: "6", entries: read.data.protected_settings.map(({ name, value }) => [name, value]) }),
      read.data.protected_settings_digest,
    );
    // The restriction control is the one control these operations write, and its
    // raw value can name a person, so it is not in the protected set at all.
    // The snapshot digest still covers it.
    assert.ok(!read.data.protected_setting_names.includes("availabilityconditionsjson"));
    assert.ok(!read.data.protected_setting_names.includes("sesskey"));
    assert.ok(read.data.protected_setting_names.includes("introeditor[text]"));
    // A switched-off native date is recorded as its toggle alone, so the same
    // form read twice has the same digest even though Moodle re-defaults it.
    const second = await readActivity();
    assert.equal(second.snapshot_digest, read.snapshot_digest);

    // The reviewed tree, sent back exactly as it was read, reaches Moodle as the
    // exact native value it came from, including the value that stayed in the
    // browser, and is confirmed by reading the saved tree back.
    const roundTrip = await execute(operations.activityWrite, {
      course_id: 2, module_id: 6, restrictions: read.data.restrictions, expected_digest: read.snapshot_digest,
    });
    assert.equal(roundTrip.ok, true, JSON.stringify(roundTrip));
    assert.equal(posts.length, 1, "one POST per change");
    assert.equal(posts[0].values.get("availabilityconditionsjson"), ACTIVITY_JSON);
    assert.equal(state.activity.availability, ACTIVITY_JSON);
    assert.deepEqual(roundTrip.data.restrictions, ACTIVITY_TREE);
    assert.equal(roundTrip.data.replaces_restriction_set, true);
    assert.deepEqual(roundTrip.verification, { schema: "morrow.browser-verification.v1", status: "verified" });
    assert.ok(!JSON.stringify(roundTrip).includes(PROFILE_VALUE));

    // A changed tree: one condition removed, one hidden flag turned over.
    const beforeChange = await readActivity();
    const changed = {
      match: "all",
      children: [
        { type: "date", direction: "until", time: 1767225600, hidden_entirely: true },
        { match: "any", children: [{ type: "group" }, { type: "grade", grade_item_id: 12, min: 50, max: 80 }], hidden_entirely: false },
      ],
    };
    const changeResult = await execute(operations.activityWrite, {
      course_id: 2, module_id: 6, restrictions: changed, expected_digest: beforeChange.snapshot_digest,
    });
    assert.equal(changeResult.ok, true, JSON.stringify(changeResult));
    assert.equal(posts.length, 2);
    assert.equal(posts[1].values.get("availabilityconditionsjson"), JSON.stringify({
      op: "&",
      c: [{ type: "date", d: "<", t: 1767225600 }, { op: "|", c: [{ type: "group" }, { type: "grade", id: 12, min: 50, max: 80 }] }],
      showc: [false, true],
    }));
    assert.deepEqual(changeResult.data.restrictions, changed);
    assert.deepEqual(changeResult.data.restriction_lines, [
      { depth: 0, text: "A learner must match all of these:" },
      { depth: 1, text: "Date before 1767225600 in Unix seconds (2026-01-01T00:00:00.000Z). Hidden entirely from a learner who does not match." },
      { depth: 1, text: "A learner must match any of these: Shown greyed out, with the restriction, to a learner who does not match." },
      { depth: 2, text: "Any group." },
      { depth: 2, text: "Grade item 12, at least 50 and less than 80." },
    ]);

    // A reviewed digest that is no longer the state of the form stops the change.
    assert.deepEqual(await execute(operations.activityWrite, {
      course_id: 2, module_id: 6, restrictions: null, expected_digest: beforeChange.snapshot_digest,
    }), { ok: false, sent: false, status: 200, error: "moodle_expected_digest_mismatch" });
    assert.equal(posts.length, 2);

    // Removing every restriction sends the empty tree the native page sends.
    const beforeClear = await readActivity();
    const cleared = await execute(operations.activityWrite, {
      course_id: 2, module_id: 6, restrictions: null, expected_digest: beforeClear.snapshot_digest,
    });
    assert.equal(cleared.ok, true, JSON.stringify(cleared));
    assert.equal(posts.length, 3);
    assert.equal(posts[2].values.get("availabilityconditionsjson"), EMPTY_JSON);
    assert.equal(cleared.data.restrictions, null);
    assert.deepEqual(cleared.data.restriction_lines, []);

    // A condition class this parser does not know is reported, not guessed, and
    // no change to that tree is sent.
    state.activity.availability = PLUGIN_JSON;
    const unknownRead = await readActivity();
    assert.equal(unknownRead.ok, true, JSON.stringify(unknownRead));
    assert.equal(unknownRead.data.restrictions_understood, false);
    assert.equal(unknownRead.data.restrictions_not_understood, "moodle_activity_restrictions_condition_unrecognised");
    assert.deepEqual(unknownRead.data.unrecognised_conditions, ["language"]);
    assert.equal(unknownRead.data.restrictions, null);
    assert.deepEqual(await execute(operations.activityWrite, {
      course_id: 2, module_id: 6, restrictions: null, expected_digest: unknownRead.snapshot_digest,
    }), { ok: false, sent: false, status: 200, error: "moodle_activity_restrictions_condition_unrecognised" });
    assert.equal(posts.length, 3);

    // A requested condition class the parser does not know is refused before send.
    state.activity.availability = ACTIVITY_JSON;
    const beforeRefusals = await readActivity();
    for (const [requested, error] of [
      [{ match: "all", children: [{ type: "language", value: "en", hidden_entirely: false }] }, "moodle_activity_restrictions_condition_unrecognised"],
      // A profile value the loaded form does not hold cannot be kept by digest.
      [{ match: "all", children: [{ type: "profile", field: "email", field_kind: "standard", operator: "isequalto", value_digest: "f".repeat(64), hidden_entirely: false }] }, "moodle_activity_restrictions_value_unknown"],
      // A nested set is one level deep, and every child of the root names its flag.
      [{ match: "all", children: [{ match: "any", children: [{ match: "all", children: [{ type: "group" }] }], hidden_entirely: false }] }, "moodle_activity_restrictions_tree_too_deep"],
      [{ match: "all", children: [{ type: "group" }] }, "moodle_activity_restrictions_tree_invalid"],
      [{ match: "all", children: [] }, "moodle_activity_restrictions_tree_invalid"],
      [{ match: "any", children: [{ type: "group" }] }, "moodle_activity_restrictions_tree_invalid"],
    ]) {
      assert.deepEqual(await execute(operations.activityWrite, {
        course_id: 2, module_id: 6, restrictions: requested, expected_digest: beforeRefusals.snapshot_digest,
      }), { ok: false, sent: false, status: 200, error }, JSON.stringify(requested));
    }
    assert.equal(posts.length, 3);

    // A new profile value the caller supplies is written, and still never comes back.
    const beforeProfile = await readActivity();
    const newValue = "grace@example.edu";
    const profileChange = await execute(operations.activityWrite, {
      course_id: 2,
      module_id: 6,
      restrictions: { match: "all", children: [{ type: "profile", field: "department", field_kind: "custom", operator: "contains", value: newValue, hidden_entirely: false }] },
      expected_digest: beforeProfile.snapshot_digest,
    });
    assert.equal(profileChange.ok, true, JSON.stringify(profileChange));
    assert.equal(posts.length, 4);
    assert.equal(posts[3].values.get("availabilityconditionsjson"), JSON.stringify({
      op: "&", c: [{ type: "profile", op: "contains", cf: "department", v: newValue }], showc: [true],
    }));
    assert.deepEqual(profileChange.data.restrictions, {
      match: "all",
      children: [{ type: "profile", field: "department", field_kind: "custom", operator: "contains", value_digest: digestOf(newValue), hidden_entirely: false }],
    });
    assert.ok(!JSON.stringify(profileChange).includes(newValue));

    // A file the native form carries cannot be proved to survive one POST of it.
    state.introFiles = "nonempty";
    const beforeFiles = await readActivity();
    assert.deepEqual(await execute(operations.activityWrite, {
      course_id: 2, module_id: 6, restrictions: null, expected_digest: beforeFiles.snapshot_digest,
    }), { ok: false, sent: false, status: 200, error: "moodle_activity_restrictions_files_present" });
    assert.equal(posts.length, 4);
    state.introFiles = "empty";

    // A saved tree that is not the approved one leaves the result unverified.
    // The value the profile condition keeps has to be the one this form holds.
    state.activity.availability = ACTIVITY_JSON;
    const beforeMismatch = await readActivity();
    state.changeOnSave = SECTION_JSON;
    const mismatch = await execute(operations.activityWrite, {
      course_id: 2, module_id: 6, restrictions: ACTIVITY_TREE, expected_digest: beforeMismatch.snapshot_digest,
    });
    assert.equal(posts.length, 5);
    assert.equal(mismatch.ok, false);
    assert.equal(mismatch.sent, true);
    assert.equal(mismatch.outcomeUnknown, true);
    assert.equal(mismatch.error, "moodle_activity_restrictions_write_not_verified");
    state.changeOnSave = "";

    // A response lost after dispatch is applied or unknown, and is never retried.
    state.activity.availability = ACTIVITY_JSON;
    const beforeLoss = await readActivity();
    await loseNextPostResponse("/course/modedit.php");
    const lost = await execute(operations.activityWrite, {
      course_id: 2, module_id: 6, restrictions: null, expected_digest: beforeLoss.snapshot_digest,
    });
    assert.equal(posts.length, 6);
    assert.deepEqual(lost, {
      ok: false,
      sent: true,
      outcomeUnknown: true,
      verification: { schema: "morrow.browser-verification.v1", status: "unconfirmed", reason: "moodle_activity_restrictions_write_unconfirmed" },
      error: "moodle_activity_restrictions_write_unconfirmed",
    });

    // The section route reads and writes the same control on its own form.
    const sectionRead = await readSection();
    assert.equal(sectionRead.ok, true, JSON.stringify(sectionRead));
    assert.equal(sectionRead.data.section_id, "7");
    assert.equal(sectionRead.data.section_name, "Week 3");
    assert.deepEqual(sectionRead.data.restrictions, SECTION_TREE);
    assert.deepEqual(sectionRead.data.restriction_lines, [
      { depth: 0, text: "A learner must match any of these: Hidden entirely from a learner who does not match." },
      { depth: 1, text: "Grade item 12, at least 50." },
      { depth: 1, text: "Activity 6 is marked complete." },
    ]);
    assert.deepEqual(sectionRead.data.proof, {
      method: "native_form_read",
      route: "/course/editsection.php",
      control: "availabilityconditionsjson",
      required_capability: "moodle/course:update",
      scope: "section_restrictions_only",
    });
    const sectionWrite = await execute(operations.sectionWrite, {
      course_id: 2, section_id: 7, restrictions: sectionRead.data.restrictions, expected_digest: sectionRead.snapshot_digest,
    });
    assert.equal(sectionWrite.ok, true, JSON.stringify(sectionWrite));
    assert.equal(posts.length, 7);
    assert.equal(posts[6].path, "/course/editsection.php");
    assert.equal(posts[6].values.get("availabilityconditionsjson"), SECTION_JSON);
    assert.deepEqual(sectionWrite.data.restrictions, SECTION_TREE);

    // A site with availability switched off renders no restriction control.
    state.availabilityEnabled = false;
    const disabled = await readActivity();
    assert.equal(disabled.ok, true, JSON.stringify(disabled));
    assert.equal(disabled.data.restrictions_available, false);
    assert.equal(disabled.data.restrictions, null);
    assert.deepEqual(await execute(operations.activityWrite, {
      course_id: 2, module_id: 6, restrictions: null, expected_digest: disabled.snapshot_digest,
    }), { ok: false, sent: false, status: 200, error: "moodle_activity_restrictions_unavailable" });
    assert.equal(posts.length, 7);
    state.availabilityEnabled = true;

    // An operation that names another activity, or arguments the route does not
    // take, is refused before anything is read.
    for (const [operation, argumentsValue, error] of [
      [operations.activityRead, { course_id: 2, module_id: 6, section_id: 7 }, "moodle_restrictions_arguments_invalid"],
      [operations.activityWrite, { course_id: 2, module_id: 6, restrictions: null }, "moodle_restrictions_arguments_invalid"],
      [operations.activityWrite, { course_id: 2, module_id: 6, expected_digest: "a".repeat(64) }, "moodle_restrictions_arguments_invalid"],
      [operations.sectionRead, { course_id: 3, section_id: 7 }, "moodle_restrictions_arguments_invalid"],
      [{ ...operations.activityRead, readOnly: false }, { course_id: 2, module_id: 6 }, "moodle_operation_refused"],
    ]) {
      const result = await execute(operation, argumentsValue);
      assert.deepEqual(result, { ok: false, sent: false, error }, JSON.stringify(argumentsValue));
    }

    // Nothing here opens an activity view page, a module route, or a course page.
    assert.deepEqual(requests.filter((entry) => /\/mod\/|\/course\/section\.php/.test(entry)), []);
    assert.deepEqual(requests.filter((entry) => entry.startsWith("GET /course/view.php")), ["GET /course/view.php?id=2"]);
  } finally {
    if (context) await context.close();
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the restriction operations are in the Moodle catalog and routed by the service worker", () => {
  const root = new URL("../..", import.meta.url);
  const catalog = JSON.parse(readFileSync(new URL("connector/extension/generated/moodle-browser-catalog.json", root), "utf8"));
  const keys = Object.values(operations).map((operation) => operation.key);
  const entries = keys.map((key) => catalog.operations.find((operation) => operation.key === key));
  for (const [index, entry] of entries.entries()) {
    assert.ok(entry, `${keys[index]} is missing from the Moodle catalog`);
    assert.equal(entry.provider, "moodle");
    assert.equal(entry.toolName, Object.values(operations)[index].toolName);
    assert.equal(entry.readOnly, Object.values(operations)[index].readOnly);
    assert.match(entry.documentation, /^https:\/\/github\.com\/moodle\/moodle\/blob\/v5\.2\.2\//);
  }

  const worker = readFileSync(new URL("connector/extension/src/service-worker.js", root), "utf8");
  assert.match(worker, /import \{ executeMoodleRestrictionsInPage \} from "\.\/moodle-restrictions-executor\.js";/);
  assert.match(worker, /func: executeMoodleRestrictionsInPage/);
  for (const key of keys) assert.ok(worker.includes(`"${key}"`), `${key} needs a service-worker route`);

  const [activityRead, activityWrite, sectionRead, sectionWrite] = entries;
  assert.deepEqual(Object.keys(activityRead.inputSchema.properties), ["course_id", "module_id"]);
  assert.match(activityRead.description, /moodle\/course:manageactivities capability at that exact activity/);
  assert.match(activityRead.description, /never opens the activity view page/);
  assert.match(activityRead.description, /it does not return that value/);

  assert.equal(activityWrite.reviewTool, "moodle_get_activity_restrictions");
  assert.deepEqual(activityWrite.inputSchema.required, ["course_id", "module_id", "restrictions", "expected_digest"]);
  assert.deepEqual(Object.keys(activityWrite.inputSchema.properties), ["course_id", "module_id", "restrictions", "expected_digest"]);
  assert.match(activityWrite.description, /sends one POST/);
  assert.match(activityWrite.description, /replaces the complete restriction set/);
  assert.match(activityWrite.description, /applied but unconfirmed/);
  assert.match(activityWrite.description, /condition class it does not recognise/);

  assert.deepEqual(Object.keys(sectionRead.inputSchema.properties), ["course_id", "section_id"]);
  assert.equal(sectionWrite.reviewTool, "moodle_get_section_restrictions");
  assert.deepEqual(sectionWrite.inputSchema.required, ["course_id", "section_id", "restrictions", "expected_digest"]);
});

test("a restriction change states what it decides before it is granted, and a granted change carries the tree alone", async () => {
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

  for (const toolName of ["moodle_update_activity_restrictions", "moodle_update_section_restrictions"]) {
    const entry = options.find((option) => option.id === `action:moodle:${toolName}`);
    assert.ok(entry, toolName);
    assert.equal(entry.availability, "edit", toolName);
    assert.match(entry.description, /Morrow cannot see which learners a restriction lets in\.$/, toolName);
    assert.ok(entry.description.length <= 1_000, toolName);
  }

  const permission = await createEditPermission({
    binding, catalogDigest, revision: 1, operations: operationsList,
    enabledCategories: ["action:moodle:moodle_update_section_restrictions"],
  });
  assert.deepEqual(permission.rules, [{
    operationKey: "moodle.form.course.editsection.restrictions.write.v1",
    toolName: "moodle_update_section_restrictions",
    allowedChangedFields: ["restrictions"],
  }]);
  const args = { course_id: 2, section_id: 7, restrictions: null, expected_digest: "d".repeat(64) };
  assert.deepEqual(changedFields(args), ["restrictions"]);
  assert.equal(matchesBridgeEditPermission(
    { sourceBindingId: binding.sourceBindingId, provider: "moodle", courseId: binding.courseId, runtimeVerified: true, editPermission: permission },
    { provider: "moodle", catalogDigest, operationKey: "moodle.form.course.editsection.restrictions.write.v1", toolName: "moodle_update_section_restrictions", arguments: args },
  ), true);
});
