import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { executeMoodleSubsectionInPage } from "../../connector/extension/src/moodle-subsection-executor.js";
import { executeMoodleInPage } from "../../connector/extension/src/moodle-executor.js";
import { categoriesForBinding } from "../../connector/extension/src/edit-policy.js";

const root = new URL("../..", import.meta.url);
const operations = Object.freeze({
  read: { key: "moodle.state.subsection.read.v1", toolName: "moodle_get_subsection", provider: "moodle", readOnly: true },
  contents: { key: "moodle.state.subsection.contents.read.v1", toolName: "moodle_list_subsection_contents", provider: "moodle", readOnly: true },
  create: { key: "moodle.form.course.modedit.subsection.create.write.v1", toolName: "moodle_create_subsection", provider: "moodle", readOnly: false },
});
// The operations of the main executor whose blanket delegated refusal this item
// replaces with an exact contract.
const CONTENTS = { key: "moodle.ajax.core_courseformat_get_state.v1", toolName: "moodle_get_contents", provider: "moodle", readOnly: true };
const MOVE = { key: "moodle.ajax.core_courseformat_update_course.cm_move.v1", toolName: "moodle_move_activity", provider: "moodle", readOnly: false };
const HIDE_ACTIVITY = { key: "moodle.ajax.core_courseformat_update_course.cm_hide.v1", toolName: "moodle_hide_activity", provider: "moodle", readOnly: false };
const SHOW_ACTIVITY = { key: "moodle.ajax.core_courseformat_update_course.cm_show.v1", toolName: "moodle_show_activity", provider: "moodle", readOnly: false };
const HIDE_SECTION = { key: "moodle.ajax.core_courseformat_update_course.section_hide.v1", toolName: "moodle_hide_section", provider: "moodle", readOnly: false };
const SHOW_SECTION = { key: "moodle.ajax.core_courseformat_update_course.section_show.v1", toolName: "moodle_show_section", provider: "moodle", readOnly: false };
const SESSKEY = "moodle-private-session";
const STATE_KEY = "state-key-never-crosses-the-bridge";

test("the subsection operations are cataloged, routed, and grouped by what they act on", () => {
  const catalog = JSON.parse(readFileSync(new URL("connector/extension/generated/moodle-browser-catalog.json", root), "utf8"));
  const byTool = new Map(catalog.operations.map((entry) => [entry.toolName, entry]));

  for (const operation of Object.values(operations)) {
    const entry = byTool.get(operation.toolName);
    assert.ok(entry, `${operation.toolName} is missing from the Moodle catalog`);
    assert.equal(entry.key, operation.key);
    assert.equal(entry.provider, "moodle");
    assert.equal(entry.readOnly, operation.readOnly);
    assert.match(entry.description, /Browser-fixture proof only; no signed-in Moodle site has run it\./);
    assert.match(entry.documentation, /^https:\/\/github\.com\/moodle\/moodle\/blob\/v5\.2\.2\/public\/mod\/subsection\//);
  }

  for (const toolName of ["moodle_get_subsection", "moodle_list_subsection_contents"]) {
    const entry = byTool.get(toolName);
    assert.deepEqual(entry.inputSchema.required, ["course_id", "module_id"]);
    assert.equal(entry.reviewTool, undefined);
    // A read must never open the Subsection activity view, which records a
    // module view and a completion state.
    assert.match(entry.description, /never opens the Subsection activity view/);
    assert.match(entry.description, /refuses a course whose subsection pairing it cannot read in full/);
    assert.match(entry.description, /moodle\/course:viewhiddensections/);
  }
  assert.match(byTool.get("moodle_list_subsection_contents").description, /in the stored order of the section it owns/);
  assert.match(byTool.get("moodle_list_subsection_contents").description, /A subsection cannot hold another subsection/);

  const created = byTool.get("moodle_create_subsection");
  assert.equal(created.reviewTool, "moodle_get_contents");
  assert.deepEqual(created.inputSchema.required, ["course_id", "section_id", "name", "expected_digest"]);
  assert.equal(created.inputSchema.properties.expected_digest.pattern, "^[a-f0-9]{64}$");
  assert.equal(created.destructive, undefined);
  assert.equal(created.irreversible, undefined);
  assert.match(created.description, /Create one hidden Subsection/);
  assert.match(created.description, /moodle\/course:manageactivities with mod\/subsection:addinstance/);
  assert.match(created.description, /creates the activity and the course section it owns in one Save/);
  assert.match(created.description, /nothing already in the course changes place/);
  assert.match(created.description, /it does not notify learners/);

  const worker = readFileSync(new URL("connector/extension/src/service-worker.js", root), "utf8");
  assert.match(worker, /import \{ executeMoodleSubsectionInPage \} from "\.\/moodle-subsection-executor\.js";/);
  assert.match(worker, /MOODLE_SUBSECTION_OPERATION_KEYS = new Set\(\[/);
  assert.match(worker, /func: executeMoodleSubsectionInPage/);
  for (const operation of Object.values(operations)) {
    assert.ok(worker.includes(`"${operation.key}"`), `service-worker.js does not route ${operation.key}`);
  }
  const bundle = readFileSync(new URL("scripts/package-mcp-bundle.mjs", root), "utf8");
  assert.ok(bundle.includes('"src/moodle-subsection-executor.js"'), "the bridge bundle does not carry the subsection executor");

  const actions = categoriesForBinding({ provider: "moodle" }, catalog.operations);
  const action = actions.find((entry) => entry.id === "action:moodle:moodle_create_subsection");
  assert.equal(action.availability, "edit");
  assert.equal(action.group, "Moodle · Subsection");
  assert.equal(action.tier, "standard");
});

test("one subsection is read, listed, and created hidden, and a delegated move or hide states every activity it carries", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morrow-moodle-subsection-"));
  const key = join(directory, "key.pem");
  const certificate = join(directory, "certificate.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", certificate], { stdio: "ignore" });
  const requests = [];
  const updates = [];
  const creates = [];
  let origin = "";
  let browser;
  let model;

  const activity = (values) => ({
    visible: true, stealth: false, hasdelegatedsection: false, uservisible: true, accessvisible: true,
    hascmrestrictions: false, allowstealth: true, indent: 0, ...values,
  });
  const section = (values) => ({ visible: true, hasrestrictions: false, hassummary: false, component: "", itemid: null, parentsectionid: null, ...values });
  // Moodle numbers a section it owns after every ordinary one, and shows it
  // inside the section that holds the activity delegating it.
  const initialModel = () => ({
    format: "topics",
    courseFormReadable: true,
    formSesskey: SESSKEY,
    formVisibleDefault: "1",
    extraFormControl: "",
    formReads: 0,
    changeFormOnSecondRead: false,
    breakPairing: "",
    nextId: 90,
    course: { id: 2, fullname: "Foundations of Care", editmode: true, statekey: STATE_KEY },
    section: [
      section({ id: "5", number: 0, rawtitle: "", cmlist: ["50"] }),
      section({ id: "6", number: 1, rawtitle: "Week 1: Foundations", cmlist: ["51", "55"] }),
      section({ id: "7", number: 2, rawtitle: "Week 2: Practice", cmlist: ["52"] }),
      section({ id: "20", number: 3, rawtitle: "Skills laboratory", component: "mod_subsection", itemid: 4, parentsectionid: "6", cmlist: ["53", "54"] }),
    ],
    cm: [
      activity({ id: "50", module: "page", sectionid: "5", name: "Welcome" }),
      activity({ id: "51", module: "page", sectionid: "6", name: "Reading notes" }),
      activity({ id: "52", module: "page", sectionid: "7", name: "Case study" }),
      activity({ id: "53", module: "page", sectionid: "20", name: "Handwashing steps" }),
      activity({ id: "54", module: "quiz", sectionid: "20", name: "Skills check" }),
      activity({ id: "55", module: "subsection", sectionid: "6", name: "Skills laboratory", hasdelegatedsection: true, delegatesectionid: "20" }),
    ],
  });
  const owned = (cmId) => model.section.find((entry) => entry.component === "mod_subsection" && entry.parentsectionid !== null
    && model.cm.some((cm) => cm.id === cmId && cm.delegatesectionid === entry.id));
  const derive = () => {
    for (const entry of model.section) {
      entry.title = entry.rawtitle || (entry.number === 0 ? "General" : `Topic ${entry.number}`);
      entry.current = false;
      entry.sectionurl = `/course/view.php?id=2#section-${entry.number}`;
      // Moodle shows no restriction indicator on a hidden section.
      if (!entry.visible) entry.hasrestrictions = false;
      for (const cm of model.cm) if (cm.sectionid === entry.id) cm.sectionnumber = entry.number;
    }
    for (const cm of model.cm) cm.accessvisible = cm.visible;
    model.course.numsections = Math.max(...model.section.map((entry) => entry.number));
    model.course.sectionlist = [...model.section].sort((left, right) => left.number - right.number).map((entry) => Number(entry.id));
    if (model.breakPairing === "orphan-section") {
      // A section Moodle owns with no activity delegating it.
      const target = model.section.find((entry) => entry.id === "20");
      if (target) target.parentsectionid = null;
    }
    if (model.breakPairing === "unknown-component") {
      const target = model.section.find((entry) => entry.id === "20");
      if (target) target.component = "mod_othercontainer";
    }
  };
  const stateBody = () => {
    derive();
    return JSON.stringify([{
      data: JSON.stringify({
        course: { ...model.course },
        section: model.section.map((entry) => ({ ...entry })),
        cm: model.cm.map((entry) => ({ ...entry })),
      }),
    }]);
  };
  // Moodle carries a subsection's visibility into the section it owns and into
  // every activity that section holds.
  // course/format/classes/local/sectionactions.php transfer_visibility_to_cms
  const transferVisibility = (sectionEntry, visible) => {
    if (sectionEntry.visible === visible || !sectionEntry.cmlist.length) return;
    sectionEntry.visible = visible;
    for (const cmId of sectionEntry.cmlist) {
      const child = model.cm.find((entry) => entry.id === cmId);
      if (child) child.visible = visible;
    }
    if (sectionEntry.component === "mod_subsection") {
      const delegator = model.cm.find((entry) => entry.delegatesectionid === sectionEntry.id);
      if (delegator) delegator.visible = visible;
    }
  };
  const setActivityVisibility = (cmId, visible) => {
    const cm = model.cm.find((entry) => entry.id === cmId);
    if (!cm || cm.visible === visible) return;
    cm.visible = visible;
    const delegated = owned(cmId);
    if (!delegated) return;
    const wasVisible = delegated.visible;
    delegated.visible = visible;
    if (wasVisible !== visible) {
      for (const childId of delegated.cmlist) {
        const child = model.cm.find((entry) => entry.id === childId);
        if (child) child.visible = visible;
      }
    }
  };
  const applyUpdate = (args) => {
    const targetId = String(args.ids[0]);
    if (args.action === "cm_move") {
      const cm = model.cm.find((entry) => entry.id === targetId);
      const destination = model.section.find((entry) => entry.id === String(args.targetsectionid));
      if (!cm || !destination) return;
      for (const entry of model.section) entry.cmlist = entry.cmlist.filter((cmId) => cmId !== targetId);
      destination.cmlist = [...destination.cmlist, targetId];
      cm.sectionid = destination.id;
      const delegated = owned(targetId);
      if (delegated) delegated.parentsectionid = destination.id;
      return;
    }
    if (args.action === "cm_hide" || args.action === "cm_show") {
      setActivityVisibility(targetId, args.action === "cm_show");
      return;
    }
    const sectionEntry = model.section.find((entry) => entry.id === targetId);
    if (!sectionEntry) return;
    const visible = args.action === "section_show";
    if (!sectionEntry.cmlist.length) {
      sectionEntry.visible = visible;
      return;
    }
    const members = [...sectionEntry.cmlist];
    transferVisibility(sectionEntry, visible);
    // An activity that delegates a section carries the change into it.
    for (const cmId of members) {
      const delegated = owned(cmId);
      if (delegated) transferVisibility(delegated, visible);
    }
  };
  const courseForm = () => `<!doctype html><html><body class="path-course course-2"><form method="post" action="/course/edit.php">`
    + `<input type="hidden" name="id" value="2"><input name="fullname" value="Foundations of Care"><input name="shortname" value="FOC">`
    + `<select name="format" id="id_format">${["topics", "weeks", "tiles"].map((entry) => `<option value="${entry}"${entry === model.format ? " selected" : ""}>${entry}</option>`).join("")}</select>`
    + `<input type="hidden" name="visible" value="1"><textarea name="summary_editor[text]"></textarea><input type="hidden" name="summary_editor[format]" value="1">`
    + `<input type="hidden" name="sesskey" value="${SESSKEY}"><input type="submit" name="saveanddisplay" value="Save and display"></form></body></html>`;
  // The native mod_subsection creation form: a name, the standard course-module
  // controls, and the two save buttons.
  const creationForm = (sectionNumber, changed = false) => `<!doctype html><html><body class="path-course course-2"><form method="post" action="/course/modedit.php" enctype="multipart/form-data">`
    + `<input type="hidden" name="course" value="2"><input type="hidden" name="add" value="subsection"><input type="hidden" name="modulename" value="subsection">`
    + `<input type="hidden" name="section" value="${sectionNumber}"><input type="hidden" name="return" value="0"><input type="hidden" name="sr" value="0">`
    + `<input type="hidden" name="sesskey" value="${model.formSesskey}"><input type="hidden" name="_qf__mod_subsection_mod_form" value="1">`
    + `<input type="text" name="name" value=""><select name="visible">${["0", "1"].map((value) => `<option value="${value}"${value === model.formVisibleDefault ? " selected" : ""}>${value}</option>`).join("")}</select>`
    + `<input type="hidden" name="visibleoncoursepage" value="1"><input type="hidden" name="availabilityconditionsjson" value="{&quot;op&quot;:&quot;&amp;&quot;,&quot;c&quot;:[],&quot;showc&quot;:[]}">`
    + `<input type="checkbox" name="coursecontentnotification" value="1"><input type="hidden" name="cmidnumber" value="">${changed ? '<input type="hidden" name="groupmode" value="1">' : ""}${model.extraFormControl}`
    + `<input type="submit" name="submitbutton2" value="Save and return to course"><input type="submit" name="submitbutton" value="Save and display"></form></body></html>`;

  const server = createServer({ key: readFileSync(key), cert: readFileSync(certificate) }, async (request, response) => {
    const target = new URL(request.url || "/", origin);
    requests.push({ method: request.method, pathname: target.pathname, search: target.search });
    if (request.method === "GET" && target.pathname === "/course/view.php") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<!doctype html><body class="path-course course-2"><h1>Foundations of Care</h1><script>var M = { cfg: ${JSON.stringify({ wwwroot: origin, sesskey: SESSKEY, userId: 3, courseId: 2 })} };</script></body>`);
      return;
    }
    if (request.method === "GET" && target.pathname === "/course/edit.php") {
      if (!model.courseFormReadable || target.searchParams.get("id") !== "2") {
        response.writeHead(503).end();
        return;
      }
      response.writeHead(200, { "content-type": "text/html" });
      response.end(courseForm());
      return;
    }
    if (request.method === "GET" && target.pathname === "/course/modedit.php") {
      derive();
      const parent = model.section.find((entry) => entry.id === target.searchParams.get("sectionid"));
      if (target.searchParams.get("add") !== "subsection" || target.searchParams.get("course") !== "2" || !parent) {
        response.writeHead(404).end();
        return;
      }
      model.formReads += 1;
      response.writeHead(200, { "content-type": "text/html" });
      response.end(creationForm(parent.number, model.changeFormOnSecondRead && model.formReads > 1));
      return;
    }
    if (request.method === "POST" && target.pathname === "/course/modedit.php") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const posted = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
      creates.push(posted);
      derive();
      const parent = model.section.find((entry) => entry.number === Number(posted.get("section")));
      if (posted.get("sesskey") !== SESSKEY || !parent) {
        response.writeHead(403).end();
        return;
      }
      const instanceId = (model.nextId += 1);
      const sectionId = String(model.nextId += 1);
      const moduleId = String(model.nextId += 1);
      const visible = posted.get("visible") === "1";
      model.section.push(section({
        id: sectionId, number: Math.max(...model.section.map((entry) => entry.number)) + 1, rawtitle: posted.get("name"),
        component: "mod_subsection", itemid: instanceId, parentsectionid: parent.id, visible, cmlist: [],
      }));
      model.cm.push(activity({
        id: moduleId, module: "subsection", sectionid: parent.id, name: posted.get("name"),
        visible, hasdelegatedsection: true, delegatesectionid: sectionId,
      }));
      parent.cmlist = [...parent.cmlist, moduleId];
      response.writeHead(303, { location: "/course/view.php?id=2" }).end();
      return;
    }
    if (request.method === "POST" && target.pathname === "/lib/ajax/service.php") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const call = JSON.parse(Buffer.concat(chunks).toString("utf8"))[0];
      assert.equal(target.searchParams.get("sesskey"), SESSKEY);
      assert.equal(target.searchParams.get("info"), call.methodname);
      if (call.methodname === "core_courseformat_get_state") {
        assert.equal(call.args.courseid, 2);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(stateBody());
        return;
      }
      if (call.methodname === "core_courseformat_update_course") {
        updates.push(call.args);
        applyUpdate(call.args);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify([{ data: null }]));
        return;
      }
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
      executeMoodleSubsectionInPage,
      JSON.stringify({ mode: "execute", operation, arguments: argumentsValue, binding, expiresAt }),
    );
    const main = (operation, argumentsValue) => page.evaluate(
      executeMoodleInPage,
      JSON.stringify({ mode: "execute", operation, arguments: argumentsValue, binding, expiresAt: Date.now() + 60_000 }),
    );
    const reviewedDigest = async () => {
      const read = await main(CONTENTS, { course_id: 2 });
      assert.equal(read.ok, true, JSON.stringify(read));
      return read.snapshot_digest;
    };
    const sectionsOf = (result) => Object.fromEntries(result.data.sections.map((entry) => [entry.id, entry]));
    const activitiesOf = (result) => Object.fromEntries(result.data.activities.map((entry) => [entry.id, entry]));
    // Moodle applies the change and the answer never arrives, exactly as a
    // dropped connection after one dispatch would leave it.
    const loseNextPostResponse = (match) => page.evaluate((matcher) => {
      const nativeFetch = globalThis.fetch;
      globalThis.fetch = async (...parameters) => {
        const response = await nativeFetch(...parameters);
        const target = new URL(String(parameters[0]), globalThis.location.href);
        const posted = String(parameters[1]?.method || "GET").toUpperCase() === "POST";
        const matches = matcher.info ? target.searchParams.get("info") === matcher.info : target.pathname === matcher.pathname;
        if (posted && matches) {
          globalThis.fetch = nativeFetch;
          throw new TypeError("response lost after dispatch");
        }
        return response;
      };
    }, match);

    // The subsection read names the section Moodle owns for it, the section
    // that holds it, and how many activities it carries.
    const read = await execute(operations.read, { course_id: 2, module_id: 55 });
    assert.equal(read.ok, true, JSON.stringify(read));
    assert.equal(read.sent, false);
    assert.deepEqual(read.data.section, {
      section_id: 20, number: 3, title: "Skills laboratory", stored_name: "Skills laboratory",
      visible: true, has_summary: false, has_restrictions: false,
    });
    assert.deepEqual(read.data.parent_section, { section_id: 6, number: 1, title: "Week 1: Foundations" });
    assert.deepEqual([read.data.module_id, read.data.name, read.data.visible, read.data.activity_count], [55, "Skills laboratory", true, 2]);
    assert.equal(read.data.proof.opens_activity_view, false);
    assert.equal(read.data.proof.learner_identity, "never_returned");
    assert.deepEqual(read.targets, [
      { field: "course_id", label: "Course", name: "Foundations of Care" },
      { field: "module_id", label: "Subsection", name: "Skills laboratory" },
    ]);
    // No Subsection view page is ever requested.
    assert.equal(requests.some((entry) => entry.pathname.startsWith("/mod/subsection/")), false);

    // The contents list is the stored order of the section Moodle owns.
    const listed = await execute(operations.contents, { course_id: 2, module_id: 55 });
    assert.equal(listed.ok, true, JSON.stringify(listed));
    assert.deepEqual(listed.data.activities, [
      { position: 1, module_id: 53, name: "Handwashing steps", module: "page", visible: true, stealth: false, access_visible: true, has_restrictions: false },
      { position: 2, module_id: 54, name: "Skills check", module: "quiz", visible: true, stealth: false, access_visible: true, has_restrictions: false },
    ]);
    assert.equal(listed.data.activity_count, 2);
    assert.equal(JSON.stringify(listed).includes(SESSKEY), false);
    assert.equal(JSON.stringify(listed).includes(STATE_KEY), false);

    // An activity that is not a subsection, and a course whose pairing cannot
    // be read in full, are refused.
    const notSubsection = await execute(operations.read, { course_id: 2, module_id: 51 });
    assert.deepEqual([notSubsection.ok, notSubsection.sent, notSubsection.error], [false, false, "moodle_subsection_target_invalid"]);
    for (const broken of ["orphan-section", "unknown-component"]) {
      model.breakPairing = broken;
      const refused = await execute(operations.read, { course_id: 2, module_id: 55 });
      assert.deepEqual([refused.ok, refused.sent, refused.error], [false, false, "moodle_subsection_membership_incomplete"], broken);
    }
    model = initialModel();

    // Every refusal below happens before any native request that changes state.
    const refuseCreate = async (argumentsValue, error, expiresAt) => {
      const before = creates.length;
      const result = await execute(operations.create, argumentsValue, expiresAt);
      assert.deepEqual([result.ok, result.sent, result.error], [false, false, error], JSON.stringify(result));
      assert.equal(creates.length, before, `moodle_create_subsection posted while refusing ${error}`);
    };
    let digest = await reviewedDigest();
    await refuseCreate({ course_id: 2, section_id: 6, name: "Simulation lab", expected_digest: "0".repeat(64) }, "moodle_expected_digest_mismatch");
    await refuseCreate({ course_id: 2, section_id: 6, name: "", expected_digest: digest }, "moodle_subsection_arguments_invalid");
    // Moodle rewrites these characters when it renders a name, so the saved
    // name could not be compared exactly.
    await refuseCreate({ course_id: 2, section_id: 6, name: "Skills & drills", expected_digest: digest }, "moodle_subsection_arguments_invalid");
    await refuseCreate({ course_id: 2, section_id: 6, expected_digest: digest }, "moodle_subsection_arguments_invalid");
    await refuseCreate({ course_id: 2, section_id: 6, name: "Simulation lab", expected_digest: digest }, "moodle_execution_expired", Date.now() - 1);
    // A subsection cannot hold a subsection.
    await refuseCreate({ course_id: 2, section_id: 20, name: "Simulation lab", expected_digest: digest }, "moodle_subsection_parent_refused");
    // A control that changed between the reviewed form and the send stops the
    // write before it is sent.
    model = initialModel();
    model.changeFormOnSecondRead = true;
    creates.length = 0;
    digest = await reviewedDigest();
    const changed = await execute(operations.create, { course_id: 2, section_id: 6, name: "Simulation lab", expected_digest: digest });
    assert.deepEqual([changed.ok, changed.sent, changed.error], [false, false, "moodle_subsection_form_changed"], JSON.stringify(changed));
    assert.equal(creates.length, 0);
    model = initialModel();

    // One POST creates one hidden subsection and the one hidden section Moodle
    // owns for it, at the end of the course's section numbers, with nothing
    // already in the course moved.
    creates.length = 0;
    const created = await execute(operations.create, { course_id: 2, section_id: 6, name: "Simulation lab", expected_digest: await reviewedDigest() });
    assert.equal(created.ok, true, JSON.stringify(created));
    assert.equal(creates.length, 1);
    assert.deepEqual(created.verification, { schema: "morrow.browser-verification.v1", status: "verified" });
    assert.deepEqual(created.subsection, { module_id: 93, section_id: 92, name: "Simulation lab", number: 4 });
    const createdBody = creates[0];
    assert.equal(createdBody.get("visible"), "0");
    assert.equal(createdBody.get("name"), "Simulation lab");
    assert.equal(createdBody.get("submitbutton2"), "Save and return to course");
    // The other save button and the learner notification are never sent.
    assert.equal(createdBody.get("submitbutton"), null);
    assert.equal(createdBody.get("coursecontentnotification"), null);
    const createdSections = sectionsOf(created);
    assert.deepEqual(
      [createdSections["92"].component, createdSections["92"].parentsectionid, createdSections["92"].visible, createdSections["92"].number, createdSections["92"].cmlist],
      ["mod_subsection", "6", false, 4, []],
    );
    assert.equal(activitiesOf(created)["93"].visible, false);
    assert.equal(activitiesOf(created)["93"].hasdelegatedsection, true);
    assert.deepEqual(created.data.sections.find((entry) => entry.id === "6").cmlist, ["51", "55", "93"]);
    assert.equal(created.data.course.numsections, 4);
    assert.equal(created.snapshot_digest, await reviewedDigest());
    assert.equal(created.proof.created_hidden, true);
    assert.equal(created.proof.creates_delegated_section, true);
    assert.equal(created.proof.sections_renumbered, 0);
    assert.equal(created.proof.learners_notified, false);
    assert.equal(created.proof.required_capability, "moodle/course:manageactivities with mod/subsection:addinstance");
    assert.deepEqual(created.targets, [
      { field: "course_id", label: "Course", name: "Foundations of Care" },
      { field: "section_id", label: "Section", name: "Week 1: Foundations" },
      { field: "module_id", label: "Subsection", name: "Simulation lab" },
    ]);
    assert.equal(JSON.stringify(created).includes(SESSKEY), false);
    assert.equal(JSON.stringify(created).includes(STATE_KEY), false);

    // A lost response after the one POST is applied_or_unknown, and nothing is
    // sent a second time.
    model = initialModel();
    creates.length = 0;
    const lostCreateDigest = await reviewedDigest();
    await loseNextPostResponse({ pathname: "/course/modedit.php" });
    const lost = await execute(operations.create, { course_id: 2, section_id: 6, name: "Simulation lab", expected_digest: lostCreateDigest });
    assert.deepEqual([lost.ok, lost.sent, lost.outcomeUnknown, lost.error], [false, true, true, "moodle_subsection_write_unconfirmed"]);
    assert.deepEqual(lost.verification, { schema: "morrow.browser-verification.v1", status: "unconfirmed", reason: "moodle_subsection_write_unconfirmed" });
    assert.equal(creates.length, 1);
    // Moodle did apply it, which is exactly why the result is unknown.
    assert.equal(model.cm.some((entry) => entry.name === "Simulation lab"), true);

    // A delegated move now succeeds: one activity moved into the section a
    // subsection owns, with one dispatch and the complete state back.
    model = initialModel();
    updates.length = 0;
    const movedIn = await main(MOVE, { course_id: 2, module_id: 52, target_section_id: 20, expected_digest: await reviewedDigest() });
    assert.equal(movedIn.ok, true, JSON.stringify(movedIn));
    assert.deepEqual(movedIn.verification, { schema: "morrow.browser-verification.v1", status: "verified" });
    assert.deepEqual(updates, [{ action: "cm_move", courseid: 2, ids: [52], targetsectionid: 20, targetcmid: null }]);
    assert.deepEqual(sectionsOf(movedIn)["20"].cmlist, ["53", "54", "52"]);
    assert.deepEqual(sectionsOf(movedIn)["7"].cmlist, []);
    assert.equal(activitiesOf(movedIn)["52"].sectionnumber, 3);
    assert.deepEqual(movedIn.delegated, { subsection_moved: null, destination_subsection: "Skills laboratory", affected_activities: [] });

    // And the subsection itself moves between ordinary sections, carrying the
    // section it owns and every activity in it. The result names each one.
    model = initialModel();
    updates.length = 0;
    const movedOut = await main(MOVE, { course_id: 2, module_id: 55, target_section_id: 7, expected_digest: await reviewedDigest() });
    assert.equal(movedOut.ok, true, JSON.stringify(movedOut));
    assert.deepEqual(updates, [{ action: "cm_move", courseid: 2, ids: [55], targetsectionid: 7, targetcmid: null }]);
    assert.equal(sectionsOf(movedOut)["20"].parentsectionid, "7");
    assert.deepEqual(sectionsOf(movedOut)["6"].cmlist, ["51"]);
    assert.deepEqual(sectionsOf(movedOut)["7"].cmlist, ["52", "55"]);
    assert.deepEqual(movedOut.delegated, {
      subsection_moved: "Skills laboratory",
      destination_subsection: null,
      affected_activities: [
        { module_id: 53, name: "Handwashing steps", module: "page" },
        { module_id: 54, name: "Skills check", module: "quiz" },
      ],
    });

    // Moodle refuses a subsection moved into a subsection, so Morrow refuses it
    // before anything is sent.
    model = initialModel();
    updates.length = 0;
    const nested = await main(MOVE, { course_id: 2, module_id: 55, target_section_id: 20, expected_digest: await reviewedDigest() });
    assert.deepEqual([nested.ok, nested.sent, nested.error], [false, false, "moodle_move_precondition_refused"]);
    assert.equal(updates.length, 0);

    // A pairing that cannot be read in full still refuses every one of them.
    for (const broken of ["orphan-section", "unknown-component"]) {
      model = initialModel();
      model.breakPairing = broken;
      updates.length = 0;
      const brokenDigest = await reviewedDigest();
      const refusedMove = await main(MOVE, { course_id: 2, module_id: 52, target_section_id: 6, expected_digest: brokenDigest });
      assert.deepEqual([refusedMove.ok, refusedMove.sent, refusedMove.error], [false, false, "moodle_delegated_membership_incomplete"], broken);
      const refusedHide = await main(HIDE_ACTIVITY, { course_id: 2, module_id: 51, expected_digest: brokenDigest });
      assert.deepEqual([refusedHide.ok, refusedHide.sent, refusedHide.error], [false, false, "moodle_delegated_membership_incomplete"], broken);
      assert.equal(updates.length, 0);
    }

    // Hiding the subsection hides the section Moodle owns for it and every
    // activity in that section, and the result names each one.
    model = initialModel();
    updates.length = 0;
    const hidden = await main(HIDE_ACTIVITY, { course_id: 2, module_id: 55, expected_digest: await reviewedDigest() });
    assert.equal(hidden.ok, true, JSON.stringify(hidden));
    assert.deepEqual(hidden.verification, { schema: "morrow.browser-verification.v1", status: "verified" });
    assert.deepEqual(updates, [{ action: "cm_hide", courseid: 2, ids: [55], targetsectionid: null, targetcmid: null }]);
    assert.equal(sectionsOf(hidden)["20"].visible, false);
    assert.deepEqual(["53", "54", "55"].map((entry) => activitiesOf(hidden)[entry].visible), [false, false, false]);
    assert.deepEqual(hidden.delegated, {
      subsections: [{
        section_id: 20,
        module_id: 55,
        name: "Skills laboratory",
        visibility_changed: true,
        activities: [
          { module_id: 53, name: "Handwashing steps", module: "page" },
          { module_id: 54, name: "Skills check", module: "quiz" },
        ],
      }],
    });

    // Hiding the ordinary section that holds it reaches the same activities.
    model = initialModel();
    updates.length = 0;
    const hiddenSection = await main(HIDE_SECTION, { course_id: 2, section_id: 6, expected_digest: await reviewedDigest() });
    assert.equal(hiddenSection.ok, true, JSON.stringify(hiddenSection));
    assert.deepEqual(updates, [{ action: "section_hide", courseid: 2, ids: [6], targetsectionid: null, targetcmid: null }]);
    assert.deepEqual(["51", "53", "54", "55"].map((entry) => activitiesOf(hiddenSection)[entry].visible), [false, false, false, false]);
    assert.equal(sectionsOf(hiddenSection)["20"].visible, false);
    assert.equal(hiddenSection.delegated.subsections[0].visibility_changed, true);

    // Hiding the section Moodle owns hides the subsection activity with it.
    model = initialModel();
    updates.length = 0;
    const hiddenOwned = await main(HIDE_SECTION, { course_id: 2, section_id: 20, expected_digest: await reviewedDigest() });
    assert.equal(hiddenOwned.ok, true, JSON.stringify(hiddenOwned));
    assert.deepEqual(["53", "54", "55"].map((entry) => activitiesOf(hiddenOwned)[entry].visible), [false, false, false]);
    assert.equal(sectionsOf(hiddenOwned)["20"].visible, false);

    // Moodle puts each activity back to the visibility it had before, and the
    // course state does not carry that stored value, so a show that would
    // restore one is refused before anything is sent.
    model = initialModel();
    for (const entry of model.cm) entry.visible = false;
    for (const entry of model.section) if (entry.id === "20") entry.visible = false;
    updates.length = 0;
    const restoringDigest = await reviewedDigest();
    for (const [operation, argumentsValue] of [
      [SHOW_ACTIVITY, { course_id: 2, module_id: 55, expected_digest: restoringDigest }],
      [SHOW_SECTION, { course_id: 2, section_id: 6, expected_digest: restoringDigest }],
      [SHOW_SECTION, { course_id: 2, section_id: 20, expected_digest: restoringDigest }],
    ]) {
      const refused = await main(operation, argumentsValue);
      assert.deepEqual([refused.ok, refused.sent, refused.error], [false, false, "moodle_delegated_show_refused"], operation.toolName);
    }
    assert.equal(updates.length, 0);

    // A subsection holding nothing restores nothing, so showing it is the one
    // show this contract can state exactly.
    model = initialModel();
    const empty = model.section.find((entry) => entry.id === "20");
    empty.cmlist = [];
    empty.visible = false;
    model.cm = model.cm.filter((entry) => entry.sectionid !== "20");
    model.cm.find((entry) => entry.id === "55").visible = false;
    updates.length = 0;
    const shown = await main(SHOW_ACTIVITY, { course_id: 2, module_id: 55, expected_digest: await reviewedDigest() });
    assert.equal(shown.ok, true, JSON.stringify(shown));
    assert.deepEqual(updates, [{ action: "cm_show", courseid: 2, ids: [55], targetsectionid: null, targetcmid: null }]);
    assert.equal(sectionsOf(shown)["20"].visible, true);
    assert.equal(activitiesOf(shown)["55"].visible, true);
    assert.deepEqual(shown.delegated.subsections[0].activities, []);

    // A subsection whose own visibility and whose section's visibility already
    // differ cannot be planned forward.
    model = initialModel();
    model.section.find((entry) => entry.id === "20").visible = false;
    updates.length = 0;
    const partial = await main(HIDE_ACTIVITY, { course_id: 2, module_id: 55, expected_digest: await reviewedDigest() });
    assert.deepEqual([partial.ok, partial.sent, partial.error], [false, false, "moodle_delegated_visibility_partial"]);
    assert.equal(updates.length, 0);

    // A change to the owned section that would leave it as it is names that
    // instead of sending an action whose effect it cannot state.
    model = initialModel();
    model.section.find((entry) => entry.id === "20").visible = false;
    model.cm.find((entry) => entry.id === "55").visible = false;
    for (const entry of model.cm) if (entry.sectionid === "20") entry.visible = false;
    updates.length = 0;
    const unchanged = await main(HIDE_SECTION, { course_id: 2, section_id: 20, expected_digest: await reviewedDigest() });
    assert.deepEqual([unchanged.ok, unchanged.sent, unchanged.error], [false, false, "moodle_delegated_visibility_unchanged"]);
    assert.equal(updates.length, 0);

    // A lost response after one delegated hide is applied_or_unknown, and
    // nothing is sent a second time.
    model = initialModel();
    updates.length = 0;
    const lostHideDigest = await reviewedDigest();
    await loseNextPostResponse({ info: "core_courseformat_update_course" });
    const lostHide = await main(HIDE_ACTIVITY, { course_id: 2, module_id: 55, expected_digest: lostHideDigest });
    assert.deepEqual([lostHide.ok, lostHide.sent, lostHide.outcomeUnknown], [false, true, true]);
    assert.equal(updates.length, 1);
    assert.equal(model.cm.find((entry) => entry.id === "53").visible, false);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});
