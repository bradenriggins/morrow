import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { executeMoodleLtiInPage } from "../../connector/extension/src/moodle-lti-executor.js";

const ANCHOR_SESSION = "moodle-lti-session-a";
const FOREIGN_SESSION = "moodle-lti-session-b";
const COURSE_ID = "2";
const SECTION_ID = "7";
const SECTION_NUMBER = "3";
const TOOL_ID = "5";
const TOOL_NAME = "Reviewed publisher tool";
const OTHER_TOOL_ID = "9";
const OTHER_TOOL_NAME = "Another external tool";
const EXISTING_MODULE_ID = "11";
const EXISTING_NAME = "Publisher reading";
const NEW_MODULE_ID = "21";
const NEW_NAME = "Chapter 4 practice";
const DRAFT_ITEM_ID = "884401";
const CONSUMER_KEY = "consumer-key-do-not-leak";
const SHARED_SECRET = "shared-secret-do-not-leak";

const operations = Object.freeze({
  activity: { key: "moodle.form.course.modedit.lti.read.v1", toolName: "moodle_get_lti", provider: "moodle", readOnly: true },
  creationForm: { key: "moodle.form.course.modedit.lti.create.read.v1", toolName: "moodle_get_lti_creation_form", provider: "moodle", readOnly: true },
  create: { key: "moodle.form.course.modedit.lti.create.write.v1", toolName: "moodle_create_lti", provider: "moodle", readOnly: false },
  update: { key: "moodle.form.course.modedit.lti.write.v1", toolName: "moodle_update_lti", provider: "moodle", readOnly: false },
});

function readBody(request) {
  return new Promise((resolve) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

test("the Moodle External tool route is cataloged and wired, and reaches no launch route", () => {
  const root = new URL("../..", import.meta.url);
  const catalog = JSON.parse(readFileSync(new URL("connector/extension/generated/moodle-browser-catalog.json", root), "utf8"));
  const entries = catalog.operations.filter((entry) => String(entry.key).includes(".modedit.lti."));
  assert.deepEqual(entries.map((entry) => entry.key).sort(), [
    "moodle.form.course.modedit.lti.create.read.v1",
    "moodle.form.course.modedit.lti.create.write.v1",
    "moodle.form.course.modedit.lti.read.v1",
    "moodle.form.course.modedit.lti.write.v1",
  ]);
  const byTool = new Map(entries.map((entry) => [entry.toolName, entry]));
  assert.deepEqual([...byTool.keys()].sort(), ["moodle_create_lti", "moodle_get_lti", "moodle_get_lti_creation_form", "moodle_update_lti"]);
  assert.equal(byTool.get("moodle_get_lti").readOnly, true);
  assert.equal(byTool.get("moodle_get_lti_creation_form").readOnly, true);
  assert.equal(byTool.get("moodle_create_lti").reviewTool, "moodle_get_lti_creation_form");
  assert.equal(byTool.get("moodle_update_lti").reviewTool, "moodle_get_lti");
  for (const entry of entries) {
    assert.equal(entry.provider, "moodle", entry.toolName);
    assert.equal(entry.destructive, undefined, entry.toolName);
    // Every result has to say that the external tool itself cannot be checked.
    assert.match(entry.description, /Morrow cannot verify anything about the external tool\./, entry.toolName);
    assert.match(entry.description, /never launches the tool/, entry.toolName);
    assert.match(entry.description, /consumer key|shared secret/, entry.toolName);
  }
  for (const toolName of ["moodle_create_lti", "moodle_update_lti"]) {
    assert.match(byTool.get(toolName).description, /Browser-fixture proof only; no signed-in Moodle site has run it\./, toolName);
    assert.deepEqual(byTool.get(toolName).inputSchema.required.includes("expected_digest"), true, toolName);
  }
  // The grade passback statement the approval must carry.
  assert.match(byTool.get("moodle_update_lti").description, /write a grade into the course gradebook for every learner/);
  assert.match(byTool.get("moodle_update_lti").description, /cannot be turned off here/);
  // The tool must be named in the approval.
  assert.match(byTool.get("moodle_create_lti").description, /tool_name/);
  assert.deepEqual(byTool.get("moodle_create_lti").inputSchema.required.includes("tool_name"), true);
  assert.deepEqual(byTool.get("moodle_create_lti").inputSchema.required.includes("tool_type_id"), true);
  assert.deepEqual(Object.keys(byTool.get("moodle_update_lti").inputSchema.properties).sort(), ["accept_grades", "course_id", "expected_digest", "module_id", "name"]);
  assert.deepEqual(byTool.get("moodle_update_lti").inputSchema.properties.accept_grades.enum, [true]);

  const worker = readFileSync(new URL("connector/extension/src/service-worker.js", root), "utf8");
  assert.match(worker, /import \{ executeMoodleLtiInPage \} from "\.\/moodle-lti-executor\.js";/);
  assert.match(worker, /func: executeMoodleLtiInPage/);
  for (const entry of entries) assert.match(worker, new RegExp(`"${entry.key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`), entry.key);

  // No launch, deep-linking, service, grade or report route can be built here.
  const executor = readFileSync(new URL("connector/extension/src/moodle-lti-executor.js", root), "utf8");
  const source = executor.split("export async function")[1] || "";
  for (const route of ["/mod/lti/view.php", "/mod/lti/launch.php", "/mod/lti/auth.php", "/mod/lti/token.php", "/mod/lti/service.php", "/mod/lti/grade.php", "/mod/lti/return.php", "contentitem.php"]) {
    assert.equal(source.includes(route), false, `the executor body must not name ${route}`);
  }
  assert.equal(/"\/mod\//.test(source), false, "the executor body must build no /mod/ route");
  assert.match(source, /redirect: "manual"/);
});

test("the Moodle External tool route reads, creates hidden, and edits bounded settings without a launch or a leaked secret", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morrow-moodle-lti-"));
  const key = join(directory, "key.pem");
  const certificate = join(directory, "certificate.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", certificate], { stdio: "ignore" });

  const state = {
    instances: {
      [EXISTING_MODULE_ID]: { name: EXISTING_NAME, typeid: TOOL_ID, sectionid: Number(SECTION_ID), visible: true, acceptGrades: false, resourcekey: CONSUMER_KEY, password: SHARED_SECRET },
    },
    otherActivities: [{ id: 4, module: "page", sectionid: Number(SECTION_ID), name: "Overview", visible: true }],
    sections: [{ id: Number(SECTION_ID), number: Number(SECTION_NUMBER), title: "Assessment" }],
    tools: [{ id: TOOL_ID, title: TOOL_NAME }, { id: OTHER_TOOL_ID, title: OTHER_TOOL_NAME }],
    creationSessionQueue: [],
    creationView: "core",
    activityView: "core",
    postOutcome: "saved",
    savedNameOverride: "",
  };
  const requests = [];
  const posts = [];
  let origin = "";
  let browser;
  let context;

  const activities = () => [
    ...state.otherActivities,
    ...Object.entries(state.instances).map(([moduleId, instance]) => ({
      id: Number(moduleId), module: "lti", sectionid: instance.sectionid, name: instance.name, visible: instance.visible,
    })),
  ];
  const control = (name, value, type = "hidden") => `<input type="${type}" name="${name}" value="${value}">`;
  const ltiForm = (view, sesskey, identity, instance, typeId) => {
    const moduleName = view === "wrong-module" ? "page" : "lti";
    const action = view === "query-action" ? "/course/modedit.php?add=lti&course=2"
      : view === "external-action" ? "https://outside.example/course/modedit.php" : "/course/modedit.php";
    const urlMatched = view === "legacy" ? "" : control("urlmatchedtypeid", "");
    const fileArea = view === "file-manager" ? '<div data-fieldtype="filemanager"><input type="hidden" name="attachments" value="99"></div>' : "";
    const extraDraft = view === "extra-draft" ? control("attachments[itemid]", "990011") : "";
    const contentItem = view === "content-item" ? control("contentitem", "1") : "";
    const acceptChecked = instance?.acceptGrades ? " checked" : "";
    const acceptGrades = view === "no-accept-grades" ? "" : `${control("instructorchoiceacceptgrades", "0")}<input type="checkbox" name="instructorchoiceacceptgrades" value="1"${acceptChecked}>`;
    const visibleSelected = instance ? (instance.visible ? "1" : "0") : "1";
    const visible = view === "frozen-visible"
      ? control("visible", visibleSelected)
      : `<select name="visible"><option value="1"${visibleSelected === "1" ? " selected" : ""}>Show</option><option value="0"${visibleSelected === "0" ? " selected" : ""}>Hide</option></select>`;
    return `<!doctype html><html><body class="path-course course-2"><form method="post" action="${action}" id="mform1">
      ${Object.entries(identity).map(([name, value]) => control(name, value)).join("")}
      ${control("module", "17")}${control("modulename", moduleName)}${control("instance", instance ? "3" : "0")}
      ${control("sr", "0")}${control("beforemod", "0")}${control("sesskey", sesskey)}${control("_qf__mod_lti_mod_form", "1")}
      ${control("typeid", instance ? instance.typeid : typeId)}${urlMatched}${contentItem}
      ${control("toolurl", "")}${control("securetoolurl", "")}
      ${control("lineitemresourceid", "")}${control("lineitemtag", "")}${control("lineitemsubreviewurl", "")}${control("lineitemsubreviewparams", "")}
      ${control("launchcontainer", "1")}
      ${control("resourcekey", instance ? instance.resourcekey : "")}${control("password", instance ? instance.password : "")}
      ${control("icon", "")}${control("secureicon", "")}
      ${control("showtitlelaunch", "1")}${control("showdescriptionlaunch", "0")}
      <input type="text" name="name" value="${instance ? instance.name : ""}">
      <textarea name="introeditor[text]"></textarea>${control("introeditor[format]", "1")}${control("introeditor[itemid]", DRAFT_ITEM_ID)}
      ${control("showdescription", "0")}<input type="checkbox" name="showdescription" value="1">
      <textarea name="instructorcustomparameters"></textarea>
      ${acceptGrades}
      <select name="grade[modgrade_type]"><option value="none" selected>None</option><option value="point">Point</option></select>
      <input type="text" name="grade[modgrade_point]" value="100">
      <select name="gradecat"><option value="12" selected>Uncategorised</option></select>
      <input type="text" name="gradepass" value="">
      ${visible}
      <input type="text" name="cmidnumber" value="">
      ${fileArea}${extraDraft}
      <input type="checkbox" name="coursecontentnotification" value="1">
      <input type="button" name="selectcontent" value="Select content">
      <input type="submit" name="submitbutton2" value="Save and return to course">
      <input type="submit" name="submitbutton" value="Save and display">
      <input type="submit" name="cancel" value="Cancel">
    </form></body></html>`;
  };
  const creationForm = (typeId) => ltiForm(state.creationView, state.creationSessionQueue.shift() || ANCHOR_SESSION, {
    course: COURSE_ID, coursemodule: "0", section: SECTION_NUMBER, add: "lti", update: "0", return: "0",
  }, null, typeId);
  const activityForm = (moduleId) => {
    const instance = { ...state.instances[moduleId] };
    if (state.savedNameOverride) instance.name = state.savedNameOverride;
    return ltiForm(state.activityView, ANCHOR_SESSION, {
      course: COURSE_ID, coursemodule: moduleId, section: SECTION_NUMBER, add: "", update: moduleId, return: "0",
    }, instance, instance.typeid);
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
      if (call.methodname === "core_courseformat_get_state") {
        assert.deepEqual(call.args, { courseid: 2 });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify([{ index: 0, data: JSON.stringify({
          course: { id: 2, fullname: "External tool evidence course" },
          section: state.sections,
          cm: activities(),
        }) }]));
        return;
      }
      if (call.methodname === "core_courseformat_get_section_content_items") {
        assert.deepEqual(call.args, { courseid: 2, sectionid: Number(SECTION_ID) });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify([{ index: 0, data: JSON.stringify({
          content_items: [
            { id: 4, name: "page", title: "Page", link: `${origin}/course/modedit.php?add=page&return=0&course=${COURSE_ID}`, componentname: "mod_page" },
            ...state.tools.map((tool) => ({
              id: Number(tool.id) + 1,
              name: `lti_type_${tool.id}`,
              title: tool.title,
              link: `${origin}/course/modedit.php?add=lti&return=0&course=${COURSE_ID}&typeid=${tool.id}`,
              componentname: "mod_lti",
            })),
          ],
        }) }]));
        return;
      }
      response.writeHead(404).end();
      return;
    }
    if (request.method === "GET" && url.pathname === "/course/modedit.php") {
      const typeId = url.searchParams.get("typeid") || "";
      if (url.search === `?add=lti&course=${COURSE_ID}&sectionid=${SECTION_ID}&typeid=${typeId}&return=0` && state.tools.some((tool) => tool.id === typeId)) {
        response.writeHead(200, { "content-type": "text/html" });
        response.end(creationForm(typeId));
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
      if (state.postOutcome === "validation") {
        response.writeHead(200, { "content-type": "text/html" });
        response.end(creationForm(values.get("typeid") || TOOL_ID));
        return;
      }
      const update = values.get("update") || "0";
      if (update !== "0" && state.instances[update]) {
        const instance = state.instances[update];
        instance.name = values.get("name") || instance.name;
        instance.acceptGrades = values.getAll("instructorchoiceacceptgrades").includes("1");
        instance.visible = values.get("visible") === "1";
      } else {
        state.instances[String(Number(NEW_MODULE_ID) + Object.keys(state.instances).length - 1)] = {
          name: values.get("name") || "",
          typeid: values.get("typeid") || "",
          sectionid: Number(SECTION_ID),
          visible: values.get("visible") === "1",
          acceptGrades: values.getAll("instructorchoiceacceptgrades").includes("1"),
          resourcekey: "",
          password: "",
        };
      }
      response.writeHead(303, { location: `/course/view.php?id=${COURSE_ID}` });
      response.end();
      return;
    }
    response.writeHead(404).end();
  });

  try {
    await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", (error) => error ? reject(error) : resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("lti test server did not bind");
    origin = `https://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
    context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    await page.goto(`${origin}/course/view.php?id=1`);
    const binding = { origin, siteUrl: `${origin}/`, principalId: "3", courseId: COURSE_ID };
    const results = [];
    const execute = async (operation, argumentsValue, expiresAt = Date.now() + 60_000) => {
      const result = await page.evaluate(executeMoodleLtiInPage, JSON.stringify({ mode: "execute", operation, arguments: argumentsValue, binding, expiresAt }));
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

    // 1. Arguments are refused before any native request.
    const beforeArguments = sourceRequests();
    for (const [operation, args] of [
      [operations.creationForm, { course_id: 3, section_id: 7, tool_type_id: 5 }],
      [operations.creationForm, { course_id: 2, section_id: 7 }],
      [operations.create, { course_id: 2, section_id: 7, tool_type_id: 5, tool_name: TOOL_NAME, name: NEW_NAME }],
      [operations.create, { course_id: 2, section_id: 7, tool_type_id: 5, tool_name: TOOL_NAME, name: " padded ", expected_digest: "a".repeat(64) }],
      [operations.update, { course_id: 2, module_id: 11, expected_digest: "a".repeat(64) }],
      // Grade passback can only be turned on, never off.
      [operations.update, { course_id: 2, module_id: 11, accept_grades: false, expected_digest: "a".repeat(64) }],
      // No credential is ever an accepted argument.
      [operations.update, { course_id: 2, module_id: 11, resourcekey: "k", expected_digest: "a".repeat(64) }],
      [operations.create, { course_id: 2, section_id: 7, tool_type_id: 5, tool_name: TOOL_NAME, name: NEW_NAME, password: "s", expected_digest: "a".repeat(64) }],
    ]) {
      assert.deepEqual(await execute(operation, args), { ok: false, sent: false, error: "moodle_lti_arguments_invalid" }, JSON.stringify(args));
    }
    assert.deepEqual(await execute({ ...operations.creationForm, readOnly: false }, { course_id: 2, section_id: 7, tool_type_id: 5 }), { ok: false, sent: false, error: "moodle_operation_refused" });
    assert.deepEqual(await execute(operations.activity, { course_id: 2, module_id: 11 }, Date.now() - 1), { ok: false, sent: false, error: "moodle_execution_expired" });
    assert.equal(sourceRequests(), beforeArguments);

    // 2. A section outside the approved course state is refused before the form read.
    assert.deepEqual(await execute(operations.creationForm, { course_id: 2, section_id: 999, tool_type_id: 5 }), { ok: false, sent: false, status: 200, error: "moodle_lti_section_target_invalid" });

    // 3. A tool the course does not offer is refused before the form is read.
    const beforeUnlisted = requests.filter((entry) => entry.pathname === "/course/modedit.php").length;
    assert.deepEqual(await execute(operations.creationForm, { course_id: 2, section_id: 7, tool_type_id: 77 }), { ok: false, sent: false, status: 200, error: "moodle_lti_tool_not_available" });
    assert.equal(requests.filter((entry) => entry.pathname === "/course/modedit.php").length, beforeUnlisted);

    // 4. Every form that is not the core preconfigured-tool form is refused, and none of them sends a POST.
    state.creationSessionQueue.push(FOREIGN_SESSION);
    assert.deepEqual(await execute(operations.creationForm, { course_id: 2, section_id: 7, tool_type_id: 5 }), { ok: false, sent: false, status: 200, error: "moodle_form_session_mismatch" });
    for (const [view, error] of [
      ["legacy", "moodle_lti_legacy_instance_refused"],
      ["wrong-module", "moodle_lti_form_invalid"],
      ["file-manager", "moodle_lti_file_area_unexpected"],
      ["extra-draft", "moodle_lti_file_area_unexpected"],
      ["frozen-visible", "moodle_lti_form_invalid"],
      ["query-action", "moodle_lti_form_invalid"],
      ["external-action", "moodle_lti_form_invalid"],
    ]) {
      state.creationView = view;
      assert.deepEqual(await execute(operations.creationForm, { course_id: 2, section_id: 7, tool_type_id: 5 }), { ok: false, sent: false, status: 200, error }, view);
    }
    state.creationView = "core";
    assert.equal(posts.length, 0);

    // 5. The reviewed creation form names the tool and states the unverifiable boundary.
    const form = await execute(operations.creationForm, { course_id: 2, section_id: 7, tool_type_id: 5 });
    assert.equal(form.ok, true, JSON.stringify(form));
    assert.deepEqual(form.targets, [
      { field: "course_id", label: "Course", name: "External tool evidence course" },
      { field: "section_id", label: "Section", name: "Assessment" },
      { field: "tool_type_id", label: "External tool", name: TOOL_NAME },
    ]);
    assert.deepEqual(form.data, {
      schema: "morrow.moodle-lti-activity.v1",
      provider: "moodle",
      course_id: 2,
      section_id: 7,
      section_number: 3,
      module: "lti",
      tool_type_id: 5,
      tool_name: TOOL_NAME,
      tool_listed_in_course: true,
      supports_content_selection: false,
      consumer_key_present: false,
      shared_secret_present: false,
      custom_parameters_present: false,
      accept_grades: false,
      accept_grades_writable: true,
      introduction_empty: true,
      visible: false,
      protected_setting_names: [
        "add", "beforemod", "cmidnumber", "course", "coursemodule", "grade[modgrade_point]", "grade[modgrade_type]",
        "gradecat", "gradepass", "icon", "instance", "instructorcustomparameters", "introeditor[format]",
        "introeditor[text]", "launchcontainer", "lineitemresourceid", "lineitemsubreviewparams",
        "lineitemsubreviewurl", "lineitemtag", "module", "modulename", "password", "resourcekey", "return", "section",
        "secureicon", "securetoolurl", "showdescription", "showdescriptionlaunch", "showtitlelaunch", "sr", "toolurl",
        "typeid", "update", "urlmatchedtypeid", "visible",
      ],
      proof: {
        method: "native_form_read",
        route: "/course/modedit.php",
        required_capability: "moodle/course:manageactivities",
        required_tool_capability: "mod/lti:addpreconfiguredinstance",
        scope: "one_external_tool_activity",
        module: "lti",
        tool_source: "course_activity_list",
        launch_requested: false,
        content_item_requested: false,
        external_tool_verification: "not_possible",
        credential_fields: "kept_in_browser",
      },
    });
    assert.match(form.snapshot_digest, /^[a-f0-9]{64}$/);
    assert.equal(Object.hasOwn(form.data, "name"), false, "a creation form has no current activity name");
    // The digest covers the reviewed form, so an unchanged form repeats it and a
    // different tool's form does not.
    assert.equal((await execute(operations.creationForm, { course_id: 2, section_id: 7, tool_type_id: 5 })).snapshot_digest, form.snapshot_digest);
    const otherToolForm = await execute(operations.creationForm, { course_id: 2, section_id: 7, tool_type_id: 9 });
    assert.equal(otherToolForm.ok, true, JSON.stringify(otherToolForm));
    assert.equal(otherToolForm.data.tool_name, OTHER_TOOL_NAME);
    assert.notEqual(otherToolForm.snapshot_digest, form.snapshot_digest);

    // 6. A stale digest and a tool the approval did not name never reach a POST.
    assert.deepEqual(await execute(operations.create, { course_id: 2, section_id: 7, tool_type_id: 5, tool_name: TOOL_NAME, name: NEW_NAME, expected_digest: "b".repeat(64) }), { ok: false, sent: false, status: 200, error: "moodle_expected_digest_mismatch" });
    assert.deepEqual(await execute(operations.create, { course_id: 2, section_id: 7, tool_type_id: 5, tool_name: OTHER_TOOL_NAME, name: NEW_NAME, expected_digest: form.snapshot_digest }), { ok: false, sent: false, status: 200, error: "moodle_lti_tool_not_named" });
    assert.deepEqual(await execute(operations.create, { course_id: 2, section_id: 7, tool_type_id: 9, tool_name: OTHER_TOOL_NAME, name: NEW_NAME, expected_digest: form.snapshot_digest }), { ok: false, sent: false, status: 200, error: "moodle_expected_digest_mismatch" });
    assert.equal(posts.length, 0);

    // 7. The native form answers a refused save with itself, which saved nothing.
    state.postOutcome = "validation";
    assert.deepEqual(await execute(operations.create, { course_id: 2, section_id: 7, tool_type_id: 5, tool_name: TOOL_NAME, name: NEW_NAME, expected_digest: form.snapshot_digest }), {
      ok: false, sent: true, status: 200, outcomeUnknown: false,
      verification: { schema: "morrow.browser-verification.v1", status: "mismatch", reason: "moodle_form_validation_failed" },
      error: "moodle_form_validation_failed",
    });
    assert.equal(posts.length, 1);
    assert.equal(Object.keys(state.instances).length, 1);
    state.postOutcome = "saved";

    // 8. One approved creation: one POST, hidden, and the credentials go back untouched.
    const created = await execute(operations.create, { course_id: 2, section_id: 7, tool_type_id: 5, tool_name: TOOL_NAME, name: NEW_NAME, expected_digest: form.snapshot_digest });
    assert.equal(created.ok, true, JSON.stringify(created));
    assert.deepEqual(created.verification, { schema: "morrow.browser-verification.v1", status: "verified" });
    assert.equal(posts.length, 2);
    const sent = posts[1].values;
    assert.equal(sent.get("name"), NEW_NAME);
    assert.equal(sent.getAll("name").length, 1);
    assert.equal(sent.get("visible"), "0");
    assert.equal(sent.get("add"), "lti");
    assert.equal(sent.get("modulename"), "lti");
    assert.equal(sent.get("typeid"), TOOL_ID);
    assert.equal(sent.get("course"), COURSE_ID);
    assert.equal(sent.get("section"), SECTION_NUMBER);
    assert.equal(sent.get("submitbutton2"), "Save and return to course");
    assert.equal(sent.get("submitbutton"), null, "only the reviewed submit control is sent");
    assert.equal(sent.get("coursecontentnotification"), null, "a save never notifies learners");
    assert.equal(sent.get("selectcontent"), null, "a save never carries the deep-linking control");
    assert.equal(sent.get("resourcekey"), "", "the consumer key control goes back exactly as it was read");
    assert.equal(sent.get("password"), "", "the shared secret control goes back exactly as it was read");
    assert.equal(created.data.module_id, Number(NEW_MODULE_ID));
    assert.equal(created.data.visible, false);
    assert.equal(created.data.tool_name, TOOL_NAME);
    assert.equal(created.data.created, true);
    assert.equal(created.data.proof.external_tool_verification, "not_possible");
    assert.match(created.snapshot_digest, /^[a-f0-9]{64}$/);

    // 9. The saved activity read is the review read of the settings edit.
    const activity = await execute(operations.activity, { course_id: 2, module_id: Number(EXISTING_MODULE_ID) });
    assert.equal(activity.ok, true, JSON.stringify(activity));
    assert.deepEqual(activity.targets, [
      { field: "course_id", label: "Course", name: "External tool evidence course" },
      { field: "module_id", label: "External tool activity", name: EXISTING_NAME },
    ]);
    assert.equal(activity.data.name, EXISTING_NAME);
    assert.equal(activity.data.tool_type_id, Number(TOOL_ID));
    assert.equal(activity.data.tool_name, TOOL_NAME);
    assert.equal(activity.data.tool_listed_in_course, true);
    assert.equal(activity.data.visible, true);
    assert.equal(activity.data.accept_grades, false);
    assert.equal(activity.data.accept_grades_writable, true);
    // The saved instance holds both credentials; the result reports presence only.
    assert.equal(activity.data.consumer_key_present, true);
    assert.equal(activity.data.shared_secret_present, true);
    assert.equal(activity.data.proof.external_tool_verification, "not_possible");
    assert.deepEqual(await execute(operations.activity, { course_id: 2, module_id: 4 }), { ok: false, sent: false, status: 200, error: "moodle_lti_module_target_invalid" });

    // 10. A tool the course no longer lists is reported as unlisted, not guessed.
    state.tools = [{ id: OTHER_TOOL_ID, title: OTHER_TOOL_NAME }];
    const unlisted = await execute(operations.activity, { course_id: 2, module_id: Number(EXISTING_MODULE_ID) });
    assert.equal(unlisted.ok, true, JSON.stringify(unlisted));
    assert.equal(unlisted.data.tool_name, null);
    assert.equal(unlisted.data.tool_listed_in_course, false);
    assert.equal(unlisted.data.proof.tool_source, "not_listed_in_course");
    assert.notEqual(unlisted.snapshot_digest, activity.snapshot_digest, "the tool identity is part of the reviewed digest");
    state.tools = [{ id: TOOL_ID, title: TOOL_NAME }, { id: OTHER_TOOL_ID, title: OTHER_TOOL_NAME }];

    // 11. A stale digest never reaches a settings POST.
    const beforeUpdate = posts.length;
    assert.deepEqual(await execute(operations.update, { course_id: 2, module_id: Number(EXISTING_MODULE_ID), name: "Renamed", expected_digest: "c".repeat(64) }), { ok: false, sent: false, status: 200, error: "moodle_expected_digest_mismatch" });
    assert.equal(posts.length, beforeUpdate);

    // 12. One approved settings edit: rename and turn grade passback on, with one POST.
    const updated = await execute(operations.update, { course_id: 2, module_id: Number(EXISTING_MODULE_ID), name: "Publisher reading, week 4", accept_grades: true, expected_digest: activity.snapshot_digest });
    assert.equal(updated.ok, true, JSON.stringify(updated));
    assert.deepEqual(updated.verification, { schema: "morrow.browser-verification.v1", status: "verified" });
    assert.equal(posts.length, beforeUpdate + 1);
    const edit = posts[posts.length - 1].values;
    assert.equal(edit.get("update"), EXISTING_MODULE_ID);
    assert.equal(edit.get("name"), "Publisher reading, week 4");
    assert.deepEqual(edit.getAll("instructorchoiceacceptgrades"), ["0", "1"]);
    assert.equal(edit.get("visible"), "1", "an edit never changes whether the activity is visible");
    assert.equal(edit.get("resourcekey"), CONSUMER_KEY, "the consumer key goes back exactly as it was read");
    assert.equal(edit.get("password"), SHARED_SECRET, "the shared secret goes back exactly as it was read");
    assert.equal(edit.get("coursecontentnotification"), null);
    assert.equal(updated.data.name, "Publisher reading, week 4");
    assert.equal(updated.data.accept_grades, true);

    // 13. A setting whose native control is not there is refused, with nothing sent.
    state.activityView = "no-accept-grades";
    const reread = await execute(operations.activity, { course_id: 2, module_id: Number(EXISTING_MODULE_ID) });
    assert.equal(reread.ok, true, JSON.stringify(reread));
    assert.equal(reread.data.accept_grades, null);
    assert.equal(reread.data.accept_grades_writable, false);
    const noControl = posts.length;
    assert.deepEqual(await execute(operations.update, { course_id: 2, module_id: Number(EXISTING_MODULE_ID), accept_grades: true, expected_digest: reread.snapshot_digest }), { ok: false, sent: false, status: 200, error: "moodle_lti_setting_not_writable" });
    assert.equal(posts.length, noControl);
    state.activityView = "core";

    // 14. A lost response after the dispatch is applied-or-unknown, and never retried.
    const lostForm = await execute(operations.creationForm, { course_id: 2, section_id: 7, tool_type_id: 5 });
    assert.equal(lostForm.ok, true, JSON.stringify(lostForm));
    const lostBefore = posts.length;
    await loseNextResponse("/course/modedit.php", "POST");
    assert.deepEqual(await execute(operations.create, { course_id: 2, section_id: 7, tool_type_id: 5, tool_name: TOOL_NAME, name: "Lost response tool", expected_digest: lostForm.snapshot_digest }), {
      ok: false, sent: true, outcomeUnknown: true,
      verification: { schema: "morrow.browser-verification.v1", status: "unconfirmed", reason: "moodle_lti_create_unconfirmed" },
      error: "moodle_lti_create_unconfirmed",
    });
    assert.equal(posts.length, lostBefore + 1);
    assert.equal(Object.values(state.instances).filter((instance) => instance.name === "Lost response tool").length, 1, "the site kept the change the browser could not confirm");

    // 15. A saved name that is not the approved name is applied-or-unknown.
    const driftForm = await execute(operations.creationForm, { course_id: 2, section_id: 7, tool_type_id: 5 });
    const driftBefore = posts.length;
    state.savedNameOverride = "Name the site kept";
    assert.deepEqual(await execute(operations.create, { course_id: 2, section_id: 7, tool_type_id: 5, tool_name: TOOL_NAME, name: "Requested tool name", expected_digest: driftForm.snapshot_digest }), {
      ok: false, sent: true, outcomeUnknown: true,
      verification: { schema: "morrow.browser-verification.v1", status: "unconfirmed", reason: "moodle_lti_create_not_verified" },
      error: "moodle_lti_create_not_verified",
    });
    assert.equal(posts.length, driftBefore + 1);
    state.savedNameOverride = "";

    // 16. Route and secret boundaries across the whole run.
    assert.equal(requests.some((entry) => entry.pathname.startsWith("/mod/")), false, "no mod route was opened, so no launch and no content-item request was sent");
    assert.equal(courseViewRequests(), viewsAfterNavigation, "the save redirect was never followed");
    assert.equal(requests.some((entry) => entry.method !== "GET" && !SOURCE_PATHS.includes(entry.pathname)), false);
    const serialized = JSON.stringify(results);
    assert.equal(serialized.includes(CONSUMER_KEY), false, "a result leaked the consumer key");
    assert.equal(serialized.includes(SHARED_SECRET), false, "a result leaked the shared secret");
    assert.equal(serialized.includes(ANCHOR_SESSION), false, "a result leaked the session key");
    assert.equal(serialized.includes(FOREIGN_SESSION), false, "a result leaked a session key");
    assert.equal(serialized.includes(DRAFT_ITEM_ID), false, "a result leaked a draft item ID");
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
