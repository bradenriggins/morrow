import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { executeMoodleActivityContentInPage } from "../../connector/extension/src/moodle-activity-content-executor.js";

const WRITES = Object.freeze([
  { key: "moodle.form.choice.option.write.v1", toolName: "moodle_update_choice_option", reviewTool: "moodle_get_choice_options", prefix: "moodle_choice_option" },
  { key: "moodle.form.feedback.item.create.write.v1", toolName: "moodle_create_feedback_item", reviewTool: "moodle_get_feedback_items", prefix: "moodle_feedback_item" },
  { key: "moodle.form.feedback.item.write.v1", toolName: "moodle_update_feedback_item", reviewTool: "moodle_get_feedback_items", prefix: "moodle_feedback_item" },
  { key: "moodle.form.data.field.create.write.v1", toolName: "moodle_create_database_field", reviewTool: "moodle_get_database_fields", prefix: "moodle_database_field" },
  { key: "moodle.form.data.field.write.v1", toolName: "moodle_update_database_field", reviewTool: "moodle_get_database_fields", prefix: "moodle_database_field" },
]);

test("every Choice, Feedback and Database child write is cataloged and routed through the extension worker", () => {
  const root = new URL("../..", import.meta.url);
  const catalog = JSON.parse(readFileSync(new URL("connector/extension/generated/moodle-browser-catalog.json", root), "utf8"));
  const worker = readFileSync(new URL("connector/extension/src/service-worker.js", root), "utf8");
  const bundle = readFileSync(new URL("scripts/package-mcp-bundle.mjs", root), "utf8");
  assert.match(worker, /import \{ executeMoodleActivityContentInPage \} from "\.\/moodle-activity-content-executor\.js";/);
  assert.match(worker, /func: executeMoodleActivityContentInPage/);
  assert.ok(bundle.includes('"src/moodle-activity-content-executor.js"'), "the executor is not in the Bridge release file set");
  const readTools = new Set(catalog.operations.filter((entry) => entry.readOnly === true).map((entry) => entry.toolName));
  for (const write of WRITES) {
    const entries = catalog.operations.filter((entry) => entry.key === write.key);
    assert.equal(entries.length, 1, `${write.key} is not in the catalog exactly once`);
    assert.equal(entries[0].toolName, write.toolName);
    assert.equal(entries[0].provider, "moodle");
    assert.equal(entries[0].readOnly, false);
    assert.equal(entries[0].reviewTool, write.reviewTool);
    assert.deepEqual(entries[0].inputSchema.properties.expected_digest, {
      type: "string",
      pattern: "^[a-f0-9]{64}$",
      description: `The canonical SHA-256 digest of the complete snapshot from ${write.reviewTool}.`,
    });
    assert.ok(entries[0].inputSchema.required.includes("expected_digest"));
    assert.ok(readTools.has(entries[0].reviewTool), `${write.toolName} names a review tool that is not a catalog read`);
    assert.equal(entries[0].destructive, undefined, `${write.toolName} removes nothing and must not be marked destructive`);
    assert.ok(worker.includes(`["${write.key}", { toolName: "${write.toolName}"`), `${write.key} is not routed by the worker`);
  }
});

test("Choice, Feedback and Database child writes bind one record, send one POST, and read the child list back", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morrow-moodle-activity-write-"));
  const key = join(directory, "key.pem");
  const certificate = join(directory, "certificate.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", certificate], { stdio: "ignore" });
  const PRIVATE_SESSION = "moodle-private-session";
  const LEARNER_NAME = "Jane Moodle";
  const requests = [];
  let origin = "";
  let mode = "ready";
  let loads = 0;
  let browser;
  let state;

  const reset = () => {
    loads = 0;
    requests.length = 0;
    state = {
      choice: {
        responses: false,
        limitAnswers: true,
        showAvailable: true,
        options: [{ id: 41, text: "Morning lab", limit: 12 }, { id: 42, text: "Evening lab", limit: 0 }],
      },
      feedback: {
        responses: false,
        anonymous: true,
        nextId: 600,
        items: [
          { id: 501, typ: "textfield", required: true, name: "How clear was the lab brief?", label: "clarity", presentation: "30|255", dependitem: 0, dependvalue: "" },
          { id: 502, typ: "textarea", required: false, name: "What would you change?", label: "changes", presentation: "30|5", dependitem: 0, dependvalue: "" },
        ],
      },
      data: {
        entries: 0,
        approve: true,
        nextId: 80,
        defaultSort: 72,
        fields: [
          { id: 71, type: "text", name: "Species", description: "Latin name", required: false, param1: "1" },
          { id: 72, type: "textarea", name: "Habitat", description: "Where it was seen", required: true, param1: "" },
        ],
      },
    };
  };
  reset();

  const escape = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
  const yesNo = (name, value, frozen = false) => (frozen
    ? `<span class="form-control-static">${value ? "Yes" : "No"}</span><input type="hidden" name="${name}" value="${value ? 1 : 0}">`
    : `<select name="${name}"><option value="0"${value ? "" : ' selected="selected"'}>No</option><option value="1"${value ? ' selected="selected"' : ""}>Yes</option></select>`);
  // Moodle re-renders a draft item ID and the components of a switched-off
  // optional date on every load, so the fixture changes them on every load.
  const transientControls = () => {
    loads += 1;
    return `<input type="hidden" name="introeditor[itemid]" value="${900000 + loads}">
      <input type="checkbox" name="timeopen[enabled]" value="1">
      <select name="timeopen[day]"><option value="${loads}" selected="selected">${loads}</option></select>
      <select name="timeopen[hour]"><option value="${loads % 24}" selected="selected">${loads % 24}</option></select>`;
  };
  const moduleForm = (moduleName, moduleId, instance, controls) => `<!doctype html><html><body class="path-course course-2 cmid-${moduleId}">
    <form method="post" action="/course/modedit.php" id="mform-${moduleName}">
      <input type="hidden" name="course" value="2"><input type="hidden" name="coursemodule" value="${moduleId}">
      <input type="hidden" name="update" value="${moduleId}"><input type="hidden" name="modulename" value="${moduleName}">
      <input type="hidden" name="instance" value="${instance}"><input type="hidden" name="sesskey" value="${PRIVATE_SESSION}">
      <input type="hidden" name="_qf__mod_${moduleName}_mod_form" value="1">
      <input type="text" name="name" value="${moduleName === "choice" ? "Lab preference" : moduleName === "feedback" ? "Lab feedback" : "Species log"}">
      ${transientControls()}
      ${controls}
      <input type="submit" name="submitbutton2" value="Save and return to course">
      <input type="submit" name="submitbutton" value="Save and display">
      <input type="submit" name="cancel" value="Cancel">
    </form></body></html>`;
  const choiceForm = () => {
    const rows = state.choice.options.map((option, index) => `
      <input type="text" name="option[${index}]" value="${escape(option.text)}">
      <input type="text" name="limit[${index}]" value="${option.limit}">
      <input type="hidden" name="optionid[${index}]" value="${option.id}">`).join("");
    const spare = state.choice.options.length;
    return moduleForm("choice", 8, 21, `
      ${yesNo("allowupdate", false)}
      ${yesNo("allowmultiple", false, state.choice.responses)}
      ${yesNo("limitanswers", state.choice.limitAnswers)}
      ${yesNo("showavailable", state.choice.showAvailable)}
      ${rows}
      <input type="text" name="option[${spare}]" value="">
      <input type="text" name="limit[${spare}]" value="0">
      <input type="hidden" name="optionid[${spare}]" value="0">
      ${mode === "choice-overflow" ? `<input type="text" name="option[100]" value="Overflow lab">` : ""}`);
  };
  const feedbackForm = () => moduleForm("feedback", 9, 22, `
      <select name="anonymous">
        <option value="1"${state.feedback.anonymous ? ' selected="selected"' : ""}>Anonymous</option>
        <option value="2"${state.feedback.anonymous ? "" : ' selected="selected"'}>Non anonymous</option>
      </select>
      ${state.feedback.responses
    ? `<input type="text" name="multiple_submit_static" size="4" disabled="disabled" value="No"><input type="hidden" name="multiple_submit" value="0">`
    : yesNo("multiple_submit", false)}`);
  const databaseForm = () => moduleForm("data", 10, 31, `${yesNo("approval", true)}`);
  const feedbackExportXml = () => {
    const cdata = (name, value) => `          <${name}>\n               <![CDATA[${value}]]>\n          </${name}>`;
    const item = (entry) => `     <ITEM TYPE="${entry.typ}" REQUIRED="${entry.required ? 1 : 0}">
${cdata("ITEMID", entry.id)}
${cdata("ITEMTEXT", entry.name)}
${cdata("ITEMLABEL", entry.label)}
${cdata("PRESENTATION", entry.presentation)}
${cdata("OPTIONS", "")}
${cdata("DEPENDITEM", entry.dependitem)}
${cdata("DEPENDVALUE", entry.dependvalue)}
     </ITEM>`;
    return `<?xml version="1.0" encoding="UTF-8" ?>
<FEEDBACK VERSION="200701" COMMENT="XML-Importfile for mod/feedback">
     <ITEMS>
${state.feedback.items.map(item).join("\n")}
     </ITEMS>
</FEEDBACK>
`;
  };
  const feedbackItemForm = (entry, typ, position, positionCount) => {
    const presentation = String(entry?.presentation || "30|255").split("|");
    return `<!doctype html><html><body class="path-mod-feedback course-2 cmid-9">
      <form method="post" action="edit_item.php" id="feedback-item-form">
        <input type="hidden" name="sesskey" value="${PRIVATE_SESSION}">
        <input type="hidden" name="_qf__feedback_${typ}_form" value="1">
        <input type="hidden" name="required" value="0">
        <input type="checkbox" name="required" value="1"${entry?.required ? ' checked="checked"' : ""}>
        <input type="text" name="name" value="${escape(entry?.name || "")}" maxlength="1333">
        <input type="text" name="label" value="${escape(entry?.label || "")}" maxlength="255">
        <select name="itemsize"><option value="${presentation[0] || 30}" selected="selected">${presentation[0] || 30}</option></select>
        <input type="text" name="itemmaxlength" value="${presentation[1] || 255}">
        <input type="hidden" name="dependitem" value="${entry?.dependitem || 0}">
        <input type="hidden" name="dependvalue" value="${escape(entry?.dependvalue || "")}">
        <select name="position">${Array.from({ length: positionCount }, (unused, index) => `<option value="${index + 1}"${index + 1 === position ? ' selected="selected"' : ""}>${index + 1}</option>`).join("")}</select>
        <input type="hidden" name="cmid" value="9">
        <input type="hidden" name="id" value="${entry ? entry.id : ""}">
        <input type="hidden" name="feedback" value="22">
        <input type="hidden" name="template" value="0">
        <input type="hidden" name="typ" value="${typ}">
        <input type="hidden" name="hasvalue" value="0">
        <input type="hidden" name="options" value="">
        ${entry
    ? `<input type="submit" name="update_item" value="Save changes to question"><input type="submit" name="clone_item" value="Save as new question">`
    : `<input type="hidden" name="clone_item" value="0"><input type="submit" name="save_item" value="Save changes">`}
        <input type="submit" name="cancel" value="Cancel">
      </form></body></html>`;
  };
  const databaseFieldListHtml = () => {
    if (!state.data.fields.length) {
      return `<!doctype html><html><body class="path-mod-data course-2 cmid-10 cm-type-data"><div class="alert">Create a field to get started.</div></body></html>`;
    }
    const row = (field) => `<tr>
        <td>${escape(field.name)}</td>
        <td><a href="/mod/data/field.php?d=31&amp;fid=${field.id}&amp;sesskey=${PRIVATE_SESSION}&amp;mode=display"><img class="icon" alt="${field.type}" title="${field.type}" src="/theme/image.php/boost/data/1/field/${field.type}"></a>&nbsp;${field.type}</td>
        <td>${field.required ? "Yes" : "No"}</td><td>${escape(field.description)}</td>
        <td><a href="/mod/data/field.php?d=31&amp;fid=${field.id}&amp;sesskey=${PRIVATE_SESSION}&amp;mode=display">Edit</a></td>
      </tr>`;
    return `<!doctype html><html><body class="path-mod-data course-2 cmid-10 cm-type-data">
      <table class="generaltable"><tbody>${state.data.fields.map(row).join("")}</tbody></table>
      <div class="sortdefault"><form id="sortdefault" action="/mod/data/field.php" method="get">
        <input type="hidden" name="d" value="31"><input type="hidden" name="mode" value="sort">
        <input type="hidden" name="sesskey" value="${PRIVATE_SESSION}">
        <select id="defaultsort" name="defaultsort">
          <optgroup label="Fields">${state.data.fields.map((field) => `<option value="${field.id}"${field.id === state.data.defaultSort ? ' selected="selected"' : ""}>${escape(field.name)}</option>`).join("")}</optgroup>
          <optgroup label="Other"><option value="0">Time added</option></optgroup>
        </select>
      </form></div></body></html>`;
  };
  const databaseFieldFormHtml = (field, type) => `<!doctype html><html><body class="path-mod-data course-2 cmid-10 cm-type-data">
    <form id="editfield" action="/mod/data/field.php" method="post">
      <input type="hidden" name="d" value="31">
      ${field ? `<input type="hidden" name="fid" value="${field.id}">` : ""}
      <input type="hidden" name="mode" value="${field ? "update" : "add"}">
      <input type="hidden" name="type" value="${type}">
      <input name="sesskey" value="${PRIVATE_SESSION}" type="hidden">
      <input class="fieldname form-control" type="text" name="name" id="name" value="${escape(field?.name || "")}">
      <input class="fielddescription form-control" type="text" name="description" id="description" value="${escape(field?.description || "")}">
      <input class="requiredfield form-check" type="checkbox" name="required" id="required"${field?.required ? ' checked="checked"' : ""}>
      ${type === "text" ? `<input class="form-check" type="checkbox" name="param1" id="param1" value="1"${field?.param1 === "1" ? ' checked="checked"' : ""}>` : ""}
      <input type="submit" name="cancel" value="Cancel" class="btn btn-secondary mx-1">
      <input type="submit" value="Save" class="btn btn-primary mx-1">
    </form></body></html>`;
  const overviewItem = (itemKey, value) => ({
    key: itemKey, name: itemKey, contenttype: "text", exportertype: null, alertlabel: null, alertcount: null,
    contentjson: JSON.stringify({ value, datatype: "integer", content: String(value) }), extrajson: null,
  });
  const overviewPayload = (modname) => {
    if (modname !== "data") return { courseid: 2, hasintegration: true, headers: [], activities: [] };
    const items = [overviewItem("totalentries", state.data.entries), overviewItem("comments", 0)];
    if (state.data.approve) {
      items.push({
        key: "actions", name: "Approve", contenttype: "action", exportertype: "core_courseformat\\external\\overviewaction_exporter",
        alertlabel: "0 entries to approve", alertcount: "0",
        contentjson: JSON.stringify({ url: `${origin}/mod/data/view.php?id=10`, text: "Approve", badgevalue: null }), extrajson: null,
      });
    }
    return {
      courseid: 2,
      hasintegration: true,
      headers: [{ name: "Name", key: "name", align: "start" }],
      activities: [
        { name: `${LEARNER_NAME} private log`, modname, contextid: 900, cmid: 99, url: null, haserror: false, items: [overviewItem("totalentries", 44)] },
        { name: "Species log", modname, contextid: 503, cmid: 10, url: `${origin}/mod/data/view.php?id=10`, haserror: false, items },
      ],
    };
  };
  const readBody = async (request) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
  };

  const server = createServer({ key: readFileSync(key), cert: readFileSync(certificate) }, async (request, response) => {
    const target = new URL(request.url || "/", origin);
    requests.push({ method: request.method, pathname: target.pathname, search: target.search });
    const html = (body) => { response.writeHead(200, { "content-type": "text/html" }); response.end(body); };
    if (target.pathname === "/course/view.php") {
      html(`<!doctype html><body class="path-course course-2"><script>var M = { cfg: ${JSON.stringify({ wwwroot: origin, sesskey: PRIVATE_SESSION, userId: 3, courseId: 2 })} };</script></body>`);
      return;
    }
    if (request.method === "GET" && target.pathname === "/course/modedit.php") {
      const forms = new Map([["?update=8&return=0", choiceForm], ["?update=9&return=0", feedbackForm], ["?update=10&return=0", databaseForm]]);
      const form = forms.get(target.search);
      if (form) { html(form()); return; }
    }
    if (request.method === "POST" && target.pathname === "/course/modedit.php") {
      if (mode === "lose-response") { request.socket.destroy(); return; }
      const body = await readBody(request);
      assert.equal(body.get("sesskey"), PRIVATE_SESSION);
      assert.equal(body.get("update"), "8");
      // The save-and-return control is the only one Moodle answers with a
      // course redirect; the other one names the Choice's own view page.
      assert.equal(body.has("submitbutton2"), true);
      assert.equal(body.has("submitbutton"), false);
      assert.equal(body.has("cancel"), false);
      if (mode === "ignore-save") { response.writeHead(303, { location: "/course/view.php?id=2#module-8" }).end(); return; }
      // A native save that also moved a control the change never named.
      if (mode === "stray-change") state.choice.showAvailable = !state.choice.showAvailable;
      state.choice.options = state.choice.options.map((option, index) => ({
        ...option,
        text: body.get(`option[${index}]`) ?? option.text,
        limit: Number(body.get(`limit[${index}]`) ?? option.limit),
      }));
      response.writeHead(303, { location: "/course/view.php?id=2#module-8" }).end();
      return;
    }
    if (request.method === "GET" && target.pathname === "/mod/feedback/export.php" && target.search === "?id=9&action=exportfile") {
      if (!state.feedback.items.length) { response.writeHead(500, { "content-type": "text/html" }); response.end("<!doctype html><body>error</body>"); return; }
      response.writeHead(200, { "content-type": "application/xml; charset=UTF-8" });
      response.end(feedbackExportXml());
      return;
    }
    if (request.method === "GET" && target.pathname === "/mod/feedback/edit_item.php") {
      const itemId = target.searchParams.get("id");
      if (itemId) {
        const index = state.feedback.items.findIndex((entry) => String(entry.id) === itemId);
        if (index < 0) { response.writeHead(404).end(); return; }
        html(feedbackItemForm(state.feedback.items[index], state.feedback.items[index].typ, index + 1, state.feedback.items.length));
        return;
      }
      const typ = target.searchParams.get("typ") || "";
      if (target.searchParams.get("cmid") !== "9" || !typ) { response.writeHead(404).end(); return; }
      html(feedbackItemForm(null, typ, state.feedback.items.length + 1, state.feedback.items.length + 1));
      return;
    }
    if (request.method === "POST" && target.pathname === "/mod/feedback/edit_item.php") {
      if (mode === "lose-response") { request.socket.destroy(); return; }
      const body = await readBody(request);
      assert.equal(body.get("sesskey"), PRIVATE_SESSION);
      assert.equal(body.get("cmid"), "9");
      assert.equal(body.has("clone_item") && body.get("clone_item") !== "0", false);
      assert.equal(body.has(body.get("id") ? "update_item" : "save_item"), true);
      assert.equal(body.has(body.get("id") ? "save_item" : "update_item"), false);
      const position = Number(body.get("position"));
      const itemId = body.get("id");
      const saved = {
        id: itemId ? Number(itemId) : (state.feedback.nextId += 1),
        typ: body.get("typ"),
        // The advanced checkbox repeats its name, and Moodle reads the last value.
        required: body.getAll("required").at(-1) === "1",
        name: body.get("name") || "",
        label: body.get("label") || "",
        presentation: `${body.get("itemsize")}|${body.get("itemmaxlength")}`,
        dependitem: Number(body.get("dependitem") || 0),
        dependvalue: body.get("dependvalue") || "",
      };
      const rest = state.feedback.items.filter((entry) => String(entry.id) !== String(saved.id));
      rest.splice(Math.max(0, Math.min(rest.length, position - 1)), 0, saved);
      state.feedback.items = rest;
      response.writeHead(303, { location: "/mod/feedback/edit.php?id=9" }).end();
      return;
    }
    if (request.method === "GET" && target.pathname === "/mod/data/field.php") {
      if (target.search === "?id=10") { html(databaseFieldListHtml()); return; }
      if (target.searchParams.get("d") !== "31") { response.writeHead(404).end(); return; }
      if (target.searchParams.get("mode") === "new") { html(databaseFieldFormHtml(null, target.searchParams.get("newtype") || "")); return; }
      if (target.searchParams.get("mode") === "display" && target.searchParams.get("sesskey") === PRIVATE_SESSION) {
        const field = state.data.fields.find((entry) => String(entry.id) === target.searchParams.get("fid"));
        if (!field) { response.writeHead(404).end(); return; }
        html(databaseFieldFormHtml(field, field.type));
        return;
      }
      response.writeHead(404).end();
      return;
    }
    if (request.method === "POST" && target.pathname === "/mod/data/field.php") {
      if (mode === "lose-response") { request.socket.destroy(); return; }
      const body = await readBody(request);
      assert.equal(body.get("sesskey"), PRIVATE_SESSION);
      assert.equal(body.get("d"), "31");
      assert.equal(body.has("cancel"), false);
      if (mode === "ignore-save") { html(databaseFieldListHtml()); return; }
      const name = String(body.get("name") || "").trim();
      const fid = body.get("fid");
      const clash = state.data.fields.some((entry) => entry.name === name && String(entry.id) !== String(fid || ""));
      if (name && !clash) {
        const saved = {
          type: body.get("type"),
          name,
          description: String(body.get("description") || "").trim(),
          // Moodle reads the native checkbox as set whenever it arrives.
          required: body.has("required"),
          param1: body.get("param1") || "",
        };
        if (body.get("mode") === "add") state.data.fields.push({ id: (state.data.nextId += 1), ...saved });
        else state.data.fields = state.data.fields.map((entry) => (String(entry.id) === String(fid) ? { ...entry, ...saved } : entry));
      }
      html(databaseFieldListHtml());
      return;
    }
    if (request.method === "POST" && target.pathname === "/lib/ajax/service.php"
      && target.search === `?sesskey=${PRIVATE_SESSION}&info=core_courseformat_get_overview_information`) {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const call = JSON.parse(Buffer.concat(chunks).toString("utf8"))[0];
      assert.equal(call.methodname, "core_courseformat_get_overview_information");
      assert.equal(call.args.courseid, 2);
      if (mode === "overview-unavailable") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify([{ index: 0, error: "Invalid parameter value detected", exception: { errorcode: "invalidparameter" } }]));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify([{ index: 0, data: overviewPayload(call.args.modname) }]));
      return;
    }
    response.writeHead(404).end();
  });

  try {
    await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", (error) => (error ? reject(error) : resolve())));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");
    origin = `https://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
    const page = await browser.newPage({ ignoreHTTPSErrors: true });
    await page.goto(`${origin}/course/view.php?id=2`);
    const stable = (value) => {
      if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
      if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
      return JSON.stringify(value === undefined ? null : value);
    };
    const sha256 = (value) => createHash("sha256").update(stable(value)).digest("hex");
    const feedbackItems = () => state.feedback.items.map((entry, index) => ({
      item_id: entry.id, position: index + 1, type: entry.typ, required: entry.required,
      text: entry.name, label: entry.label, presentation: entry.presentation,
      depends_on_item_id: entry.dependitem === 0 ? null : entry.dependitem, depends_on_value: entry.dependvalue,
    }));
    const reviewDigest = (write) => {
      if (write.toolName === "moodle_update_choice_option") {
        const options = state.choice.options.map((entry, index) => ({ option_id: entry.id, position: index + 1, text: entry.text, response_limit: entry.limit }));
        return sha256({
          schema: "morrow.moodle-choice-options.v1", provider: "moodle", course_id: 2, module_id: 8, choice_id: 21,
          option_count: options.length, options, limit_answers: state.choice.limitAnswers, allow_multiple: false, has_responses: state.choice.responses,
          proof: { method: "course_modedit_form", complete: true, exact_module_binding: "course_modedit_form", required_capability: "moodle/course:manageactivities", option_limit: 100, option_rows: options.length, text_limit: 4000 },
        });
      }
      if (write.toolName.includes("feedback_item")) {
        const items = feedbackItems();
        return sha256({
          schema: "morrow.moodle-feedback-items.v1", provider: "moodle", course_id: 2, module_id: 9, feedback_id: 22,
          anonymous: state.feedback.anonymous, item_count: items.length, items,
          proof: { method: "course_modedit_form+mod_feedback_export_items", complete: true, exact_module_binding: "course_modedit_form", required_capability: "mod/feedback:edititems", item_limit: 200, item_rows: items.length, text_limit: 4000 },
        });
      }
      const fields = state.data.fields.map((entry) => ({ field_id: entry.id, name: entry.name, type: entry.type }));
      return sha256({
        schema: "morrow.moodle-database-fields.v1", provider: "moodle", course_id: 2, module_id: 10, database_id: 31,
        field_count: fields.length, default_sort_field_id: state.data.defaultSort, fields,
        proof: { method: "course_modedit_form+mod_data_field_index", complete: true, exact_module_binding: "course_modedit_form", required_capability: "mod/data:managetemplates", field_limit: 100, field_rows: fields.length, text_limit: 4000 },
      });
    };
    const rawInvoke = (write, args) => page.evaluate(
      executeMoodleActivityContentInPage,
      JSON.stringify({
        mode: "execute",
        operation: { key: write.key, toolName: write.toolName, provider: "moodle", readOnly: false },
        arguments: args,
        binding: { origin, siteUrl: `${origin}/`, principalId: "3", courseId: "2" },
        expiresAt: Date.now() + 60_000,
      }),
    );
    const invoke = (write, args) => rawInvoke(write, { ...args, expected_digest: args.expected_digest || reviewDigest(write) });
    const write = (toolName) => WRITES.find((entry) => entry.toolName === toolName);
    // A refusal that already read a native page carries that page's status, so
    // the comparison names the fields the contract fixes.
    const refusal = ({ ok, sent, error, complete }) => (complete === undefined ? { ok, sent, error } : { ok, sent, complete, error });
    const posts = () => requests.filter((entry) => entry.method === "POST" && entry.pathname !== "/lib/ajax/service.php").length;
    const results = [];
    const record = (value) => { results.push(value); return value; };

    assert.deepEqual(
      await page.evaluate(executeMoodleActivityContentInPage, JSON.stringify({ mode: "execute", operation: { key: "moodle.form.choice.option.unknown.write.v1" } })),
      { ok: false, sent: false, error: "moodle_activity_content_operation_unsupported" },
    );
    for (const entry of WRITES) {
      const before = requests.length;
      const refused = await invoke(entry, { course_id: 2, module_id: 8, unexpected: true });
      assert.deepEqual(refused, { ok: false, sent: false, error: `${entry.prefix}_arguments_invalid` });
      assert.equal(requests.length, before, `${entry.toolName} reached the site with invalid arguments`);
    }
    const staleBefore = posts();
    assert.deepEqual(
      refusal(await rawInvoke(write("moodle_update_choice_option"), {
        course_id: 2, module_id: 8, option_id: 41, position: 1, text: "Morning lab 2", expected_digest: "0".repeat(64),
      })),
      { ok: false, sent: false, error: "moodle_expected_digest_mismatch" },
    );
    assert.equal(posts(), staleBefore, "a stale review digest sent a Choice write");
    requests.length = 0;
    // A write that names no change at all is refused before anything is read.
    assert.deepEqual(
      await invoke(write("moodle_update_choice_option"), { course_id: 2, module_id: 8, option_id: 41, position: 1 }),
      { ok: false, sent: false, error: "moodle_choice_option_arguments_invalid" },
    );
    // Moodle rewrites some of these values as it saves them, so a value it
    // would not save exactly as sent is refused before anything is read.
    for (const [entry, args] of [
      [write("moodle_update_choice_option"), { course_id: 2, module_id: 8, option_id: 41, position: 1, text: "Morning lab <b>A</b>" }],
      [write("moodle_update_feedback_item"), { course_id: 2, module_id: 9, item_id: 501, position: 1, label: "<b>clarity</b>" }],
      [write("moodle_update_feedback_item"), { course_id: 2, module_id: 9, item_id: 501, position: 1, text: "Ends a section ]]> here" }],
    ]) {
      const before = requests.length;
      assert.deepEqual(await invoke(entry, args), { ok: false, sent: false, error: `${entry.prefix}_arguments_invalid` });
      assert.equal(requests.length, before, `${entry.toolName} read the site for a value Moodle would rewrite`);
    }

    // One Choice option, bound by its own ID and its position.
    let sent = posts();
    const option = record(await invoke(write("moodle_update_choice_option"), { course_id: 2, module_id: 8, option_id: 41, position: 1, text: "Morning lab (Room 2)", response_limit: 15 }));
    assert.equal(option.ok, true, JSON.stringify(option));
    assert.equal(posts(), sent + 1, "the Choice option write sent more than one POST");
    assert.deepEqual(option.data, {
      schema: "morrow.moodle-choice-option-write.v1", provider: "moodle", course_id: 2, module_id: 8, choice_id: 21,
      option_count: 2,
      options: [
        { option_id: 41, position: 1, text: "Morning lab (Room 2)", response_limit: 15 },
        { option_id: 42, position: 2, text: "Evening lab", response_limit: 0 },
      ],
      limit_answers: true, has_responses: false,
      changed_option: { option_id: 41, position: 1, text: "Morning lab (Room 2)", response_limit: 15 },
      proof: {
        method: "course_modedit_form", complete: true, exact_module_binding: "course_modedit_form",
        required_capability: "moodle/course:manageactivities", native_posts: 1,
        option_limit: 100, option_rows: 2, text_limit: 4000, response_lock: "allowmultiple_writable",
      },
    });
    assert.equal(option.verification.status, "verified");
    assert.match(option.snapshot_digest, /^[a-f0-9]{64}$/);
    // The saved state is read again from the native form, not taken from the
    // answer to the POST.
    assert.deepEqual(
      requests.filter((entry) => entry.pathname === "/course/modedit.php").map((entry) => entry.method),
      ["GET", "POST", "GET"],
    );

    // A save that also moved a control this change never named is a mismatch,
    // because the protected set of the loaded form came back different.
    mode = "stray-change";
    sent = posts();
    const stray = record(await invoke(write("moodle_update_choice_option"), { course_id: 2, module_id: 8, option_id: 42, position: 2, text: "Evening lab (Room 7)" }));
    assert.equal(posts(), sent + 1);
    assert.equal(stray.ok, false, JSON.stringify(stray));
    assert.equal(stray.sent, true);
    assert.equal(stray.verification.status, "mismatch");
    assert.equal(stray.error, "moodle_choice_option_write_not_verified");
    mode = "ready";
    state.choice.showAvailable = true;
    state.choice.options = state.choice.options.map((option) => (option.id === 42 ? { ...option, text: "Evening lab" } : option));

    // A native answer that saved nothing is a mismatch, never a done write.
    mode = "ignore-save";
    sent = posts();
    const ignored = record(await invoke(write("moodle_update_choice_option"), { course_id: 2, module_id: 8, option_id: 41, position: 1, text: "Morning lab (Room 9)" }));
    assert.equal(posts(), sent + 1);
    assert.equal(ignored.ok, false, JSON.stringify(ignored));
    assert.equal(ignored.sent, true);
    assert.equal(ignored.outcomeUnknown, undefined);
    assert.equal(ignored.verification.status, "mismatch");
    assert.equal(ignored.error, "moodle_choice_option_write_not_verified");
    mode = "ready";

    // The option list moved, so the reviewed position no longer binds it.
    sent = posts();
    assert.deepEqual(
      refusal(await invoke(write("moodle_update_choice_option"), { course_id: 2, module_id: 8, option_id: 42, position: 1, text: "Evening lab (Room 3)" })),
      { ok: false, sent: false, error: "moodle_choice_option_option_not_bound" },
    );
    assert.deepEqual(
      refusal(await invoke(write("moodle_update_choice_option"), { course_id: 2, module_id: 8, option_id: 99, position: 1, text: "Not an option" })),
      { ok: false, sent: false, error: "moodle_choice_option_option_not_bound" },
    );
    assert.equal(posts(), sent, "a Choice option that was not bound still sent a POST");

    // Moodle freezes the answer-count control once the Choice has responses.
    state.choice.responses = true;
    sent = posts();
    assert.deepEqual(
      refusal(await invoke(write("moodle_update_choice_option"), { course_id: 2, module_id: 8, option_id: 41, position: 1, text: "Morning lab (Room 4)" })),
      { ok: false, sent: false, error: "moodle_choice_option_responses_exist" },
    );
    assert.equal(posts(), sent, "a Choice with responses still sent a POST");
    state.choice.responses = false;
    state.choice.limitAnswers = false;
    assert.deepEqual(
      refusal(await invoke(write("moodle_update_choice_option"), { course_id: 2, module_id: 8, option_id: 41, position: 1, response_limit: 4 })),
      { ok: false, sent: false, error: "moodle_choice_option_response_limit_refused" },
    );
    state.choice.limitAnswers = true;
    mode = "choice-overflow";
    assert.deepEqual(
      refusal(await invoke(write("moodle_update_choice_option"), { course_id: 2, module_id: 8, option_id: 41, position: 1, text: "Morning lab (Room 5)" })),
      { ok: false, sent: false, complete: false, error: "moodle_choice_option_incomplete" },
    );
    mode = "ready";

    // One Feedback question, inserted at an exact position.
    sent = posts();
    const created = record(await invoke(write("moodle_create_feedback_item"), {
      course_id: 2, module_id: 9, type: "textfield", text: "Which room did you use?", label: "room", required: false, position: 2, expected_item_count: 2,
    }));
    assert.equal(created.ok, true, JSON.stringify(created));
    assert.equal(posts(), sent + 1, "the Feedback question create sent more than one POST");
    assert.equal(created.data.item_count, 3);
    assert.deepEqual(created.data.items.map((item) => [item.position, item.item_id, item.text]), [
      [1, 501, "How clear was the lab brief?"],
      [2, 601, "Which room did you use?"],
      [3, 502, "What would you change?"],
    ]);
    assert.deepEqual(created.data.changed_item, { item_id: 601, position: 2, type: "textfield", required: false, text: "Which room did you use?", label: "room" });
    assert.equal(created.data.anonymous, true);
    assert.equal(created.data.has_responses, false);
    assert.equal(created.data.proof.required_capability, "mod/feedback:edititems");
    assert.equal(created.verification.status, "verified");

    // A count that no longer matches the reviewed list refuses before send.
    sent = posts();
    assert.deepEqual(
      refusal(await invoke(write("moodle_create_feedback_item"), { course_id: 2, module_id: 9, type: "textfield", text: "Stale", label: "", required: false, position: 1, expected_item_count: 2 })),
      { ok: false, sent: false, error: "moodle_feedback_item_item_list_changed" },
    );
    assert.equal(posts(), sent, "a stale Feedback question count still sent a POST");

    const updated = record(await invoke(write("moodle_update_feedback_item"), { course_id: 2, module_id: 9, item_id: 502, position: 3, text: "What would you change next time?", required: true }));
    assert.equal(updated.ok, true, JSON.stringify(updated));
    assert.equal(posts(), sent + 1, "the Feedback question update sent more than one POST");
    assert.deepEqual(updated.data.items.map((item) => [item.position, item.item_id, item.text, item.required]), [
      [1, 501, "How clear was the lab brief?", true],
      [2, 601, "Which room did you use?", false],
      [3, 502, "What would you change next time?", true],
    ]);
    assert.equal(updated.data.items[2].label, "changes", "the update changed a field it was not asked to change");
    assert.equal(updated.data.items[2].presentation, "30|5", "the update changed the question's own presentation");

    sent = posts();
    assert.deepEqual(
      refusal(await invoke(write("moodle_update_feedback_item"), { course_id: 2, module_id: 9, item_id: 502, position: 1, text: "Wrong position" })),
      { ok: false, sent: false, error: "moodle_feedback_item_item_not_bound" },
    );
    state.feedback.responses = true;
    assert.deepEqual(
      refusal(await invoke(write("moodle_update_feedback_item"), { course_id: 2, module_id: 9, item_id: 502, position: 3, text: "After responses" })),
      { ok: false, sent: false, error: "moodle_feedback_item_responses_exist" },
    );
    assert.deepEqual(
      refusal(await invoke(write("moodle_create_feedback_item"), { course_id: 2, module_id: 9, type: "numeric", text: "After responses", label: "", required: false, position: 4, expected_item_count: 3 })),
      { ok: false, sent: false, error: "moodle_feedback_item_responses_exist" },
    );
    assert.equal(posts(), sent, "a Feedback with responses still sent a POST");
    state.feedback.responses = false;

    // Moodle refuses to build the item export for a Feedback with no items, so
    // the native position list is what proves the count is zero.
    state.feedback.items = [];
    sent = posts();
    const first = record(await invoke(write("moodle_create_feedback_item"), {
      course_id: 2, module_id: 9, type: "numeric", text: "How many samples did you log?", label: "samples", required: true, position: 1, expected_item_count: 0,
    }));
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(posts(), sent + 1);
    assert.equal(first.data.item_count, 1);
    assert.deepEqual(first.data.changed_item, { item_id: 602, position: 1, type: "numeric", required: true, text: "How many samples did you log?", label: "samples" });

    // One Database field, refused while the Database holds entries.
    state.data.entries = 3;
    sent = posts();
    assert.deepEqual(
      refusal(await invoke(write("moodle_create_database_field"), { course_id: 2, module_id: 10, type: "text", name: "Notes", description: "", required: false, expected_field_count: 2 })),
      { ok: false, sent: false, error: "moodle_database_field_entries_exist" },
    );
    state.data.entries = 0;
    state.data.approve = false;
    assert.deepEqual(
      refusal(await invoke(write("moodle_create_database_field"), { course_id: 2, module_id: 10, type: "text", name: "Notes", description: "", required: false, expected_field_count: 2 })),
      { ok: false, sent: false, error: "moodle_database_field_capability_missing" },
    );
    state.data.approve = true;
    mode = "overview-unavailable";
    assert.deepEqual(
      refusal(await invoke(write("moodle_create_database_field"), { course_id: 2, module_id: 10, type: "text", name: "Notes", description: "", required: false, expected_field_count: 2 })),
      { ok: false, sent: false, error: "moodle_database_field_service_unavailable" },
    );
    mode = "ready";
    assert.deepEqual(
      refusal(await invoke(write("moodle_create_database_field"), { course_id: 2, module_id: 10, type: "text", name: "Species", description: "", required: false, expected_field_count: 2 })),
      { ok: false, sent: false, error: "moodle_database_field_field_name_in_use" },
    );
    assert.deepEqual(
      refusal(await invoke(write("moodle_update_database_field"), { course_id: 2, module_id: 10, field_id: 71, position: 2, name: "Species name" })),
      { ok: false, sent: false, error: "moodle_database_field_field_not_bound" },
    );
    assert.equal(posts(), sent, "a refused Database field write still sent a POST");

    const field = record(await invoke(write("moodle_create_database_field"), {
      course_id: 2, module_id: 10, type: "text", name: "Notes", description: "What the observer saw", required: false, expected_field_count: 2,
    }));
    assert.equal(field.ok, true, JSON.stringify(field));
    assert.equal(posts(), sent + 1, "the Database field create sent more than one POST");
    assert.deepEqual(field.data, {
      schema: "morrow.moodle-database-field-write.v1", provider: "moodle", course_id: 2, module_id: 10, database_id: 31,
      entry_count: 0, field_count: 3, default_sort_field_id: 72,
      fields: [
        { field_id: 71, position: 1, name: "Species", type: "text" },
        { field_id: 72, position: 2, name: "Habitat", type: "textarea" },
        { field_id: 81, position: 3, name: "Notes", type: "text" },
      ],
      changed_field: { field_id: 81, position: 3, name: "Notes", type: "text", description: "What the observer saw", required: false },
      proof: {
        method: "course_modedit_form+mod_data_field_index", complete: true, exact_module_binding: "course_modedit_form",
        required_capability: "mod/data:managetemplates", native_posts: 1,
        field_limit: 100, field_rows: 3, text_limit: 255, entry_lock: "overview_total_entries_zero",
      },
    });
    assert.equal(field.verification.status, "verified");

    sent = posts();
    const renamed = record(await invoke(write("moodle_update_database_field"), { course_id: 2, module_id: 10, field_id: 71, position: 1, name: "Species name", required: true }));
    assert.equal(renamed.ok, true, JSON.stringify(renamed));
    assert.equal(posts(), sent + 1, "the Database field update sent more than one POST");
    assert.deepEqual(renamed.data.changed_field, { field_id: 71, position: 1, name: "Species name", type: "text", description: "Latin name", required: true });
    assert.deepEqual(renamed.data.fields.map((entry) => entry.name), ["Species name", "Habitat", "Notes"]);
    // The autolink control of this field type was not named by the change and
    // has to come back the way it was loaded.
    assert.equal(state.data.fields[0].param1, "1");

    mode = "ignore-save";
    sent = posts();
    const ignoredField = record(await invoke(write("moodle_update_database_field"), { course_id: 2, module_id: 10, field_id: 72, position: 2, name: "Habitat and weather" }));
    assert.equal(posts(), sent + 1);
    assert.equal(ignoredField.ok, false, JSON.stringify(ignoredField));
    assert.equal(ignoredField.sent, true);
    assert.equal(ignoredField.verification.status, "mismatch");
    assert.equal(ignoredField.error, "moodle_database_field_write_not_verified");
    mode = "ready";

    // A lost response is applied_or_unknown on every route, never a retryable
    // failure and never a claim that nothing was saved.
    mode = "lose-response";
    for (const [entry, args] of [
      [write("moodle_update_choice_option"), { course_id: 2, module_id: 8, option_id: 41, position: 1, text: "Morning lab (Room 6)" }],
      [write("moodle_update_feedback_item"), { course_id: 2, module_id: 9, item_id: 602, position: 1, text: "How many samples did you record?" }],
      [write("moodle_update_database_field"), { course_id: 2, module_id: 10, field_id: 72, position: 2, description: "Where it was found" }],
    ]) {
      const lost = record(await invoke(entry, args));
      assert.equal(lost.ok, false, JSON.stringify(lost));
      assert.equal(lost.sent, true, JSON.stringify(lost));
      assert.equal(lost.outcomeUnknown, true, JSON.stringify(lost));
      assert.equal(lost.verification.status, "unconfirmed");
      assert.equal(lost.error, `${entry.prefix}_write_unconfirmed`);
    }
    mode = "ready";

    const serialized = JSON.stringify(results);
    for (const secret of [PRIVATE_SESSION, LEARNER_NAME, "itemid", "900001"]) {
      assert.equal(serialized.includes(secret), false, `a write result leaked ${secret}`);
    }
    assert.equal(
      requests.some((entry) => entry.pathname.endsWith("/view.php") && entry.pathname !== "/course/view.php"),
      false,
      "a write opened an activity view page",
    );
    assert.equal(requests.some((entry) => entry.pathname === "/mod/choice/report.php" || entry.pathname === "/mod/feedback/show_entries.php"), false);
  } finally {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
});
