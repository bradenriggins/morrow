import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { executeMoodleActivityContentReadInPage } from "../../connector/extension/src/moodle-activity-content-read.js";

const READS = Object.freeze([
  { key: "moodle.form.choice.options.read.v1", toolName: "moodle_get_choice_options", moduleId: 8 },
  { key: "moodle.form.choice.response_summary.read.v1", toolName: "moodle_get_choice_response_summary", moduleId: 8 },
  { key: "moodle.form.feedback.items.read.v1", toolName: "moodle_get_feedback_items", moduleId: 9 },
  { key: "moodle.form.feedback.response_summary.read.v1", toolName: "moodle_get_feedback_response_summary", moduleId: 9 },
  { key: "moodle.form.data.fields.read.v1", toolName: "moodle_get_database_fields", moduleId: 10 },
  { key: "moodle.form.data.entry_summary.read.v1", toolName: "moodle_get_database_entry_summary", moduleId: 10 },
]);

test("every Choice, Feedback and Database child read is cataloged and routed through the extension worker", () => {
  const root = new URL("../..", import.meta.url);
  const catalog = JSON.parse(readFileSync(new URL("connector/extension/generated/moodle-browser-catalog.json", root), "utf8"));
  const worker = readFileSync(new URL("connector/extension/src/service-worker.js", root), "utf8");
  assert.match(worker, /import \{ executeMoodleActivityContentReadInPage \} from "\.\/moodle-activity-content-read\.js";/);
  assert.match(worker, /func: executeMoodleActivityContentReadInPage/);
  for (const read of READS) {
    const entries = catalog.operations.filter((entry) => entry.key === read.key);
    assert.equal(entries.length, 1, `${read.key} is not in the catalog exactly once`);
    assert.equal(entries[0].toolName, read.toolName);
    assert.equal(entries[0].provider, "moodle");
    assert.equal(entries[0].readOnly, true);
    assert.ok(worker.includes(`["${read.key}", { toolName: "${read.toolName}"`), `${read.key} is not routed by the worker`);
  }
});

test("Choice, Feedback and Database child reads bind one module and return aggregate or content rows only", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morrow-moodle-activity-content-"));
  const key = join(directory, "key.pem");
  const certificate = join(directory, "certificate.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", certificate], { stdio: "ignore" });
  const PRIVATE_SESSION = "moodle-private-session";
  const LEARNER_NAME = "Jane Moodle";
  const LEARNER_EMAIL = "jane@example.edu";
  const requests = [];
  let origin = "";
  let mode = "complete";
  let browser;

  const settingsForm = (module, moduleId, instance, controls) => {
    const boundModule = mode === "wrong-module" ? "99" : String(moduleId);
    const boundCourse = mode === "wrong-course" ? "9" : "2";
    const boundName = mode === "wrong-type" ? "assign" : module;
    return `<!doctype html><html><body><form method="post" action="/course/modedit.php?update=${moduleId}&amp;return=0">
      <input type="hidden" name="course" value="${boundCourse}"><input type="hidden" name="coursemodule" value="${boundModule}">
      <input type="hidden" name="update" value="${moduleId}"><input type="hidden" name="modulename" value="${boundName}">
      <input type="hidden" name="instance" value="${instance}"><input type="hidden" name="sesskey" value="${PRIVATE_SESSION}">
      ${controls}
    </form></body></html>`;
  };
  const choiceForm = () => settingsForm("choice", 8, 21, `
      <input type="text" name="option[0]" value="Morning lab">
      <input type="text" name="limit[0]" value="12">
      <input type="hidden" name="optionid[0]" value="41">
      <input type="text" name="option[1]" value="Evening lab">
      <input type="text" name="limit[1]" value="0">
      <input type="hidden" name="optionid[1]" value="42">
      <input type="text" name="option[2]" value="">
      <input type="text" name="limit[2]" value="0">
      <input type="hidden" name="optionid[2]" value="0">
      ${mode === "choice-overflow" ? '<input type="text" name="option[100]" value="Overflow lab">' : ""}
      <select name="limitanswers"><option value="0">No</option><option value="1" selected="selected">Yes</option></select>
      <select name="allowmultiple"${mode === "choice-responses" ? " disabled" : ""}><option value="0" selected="selected">No</option><option value="1">Yes</option></select>`);
  const feedbackForm = () => settingsForm("feedback", 9, 22, `
      <select name="anonymous">
        <option value="1"${mode === "named-feedback" ? "" : ' selected="selected"'}>Anonymous</option>
        <option value="2"${mode === "named-feedback" ? ' selected="selected"' : ""}>Non anonymous</option>
      </select>`);
  const databaseForm = () => settingsForm("data", 10, 31, `
      <select name="approval"><option value="0">No</option><option value="1" selected="selected">Yes</option></select>`);
  const feedbackItemsXml = () => {
    const item = (type, required, itemId, text, label, presentation, dependItem, dependValue) => `     <ITEM TYPE="${type}" REQUIRED="${required}">
          <ITEMID>
               <![CDATA[${itemId}]]>
          </ITEMID>
          <ITEMTEXT>
               <![CDATA[${text}]]>
          </ITEMTEXT>
          <ITEMLABEL>
               <![CDATA[${label}]]>
          </ITEMLABEL>
          <PRESENTATION>
               <![CDATA[${presentation}]]>
          </PRESENTATION>
          <DEPENDITEM>
               <![CDATA[${dependItem}]]>
          </DEPENDITEM>
          <DEPENDVALUE>
               <![CDATA[${dependValue}]]>
          </DEPENDVALUE>
     </ITEM>`;
    return `<?xml version="1.0" encoding="UTF-8" ?>
<FEEDBACK VERSION="200701" COMMENT="XML-Importfile for mod/feedback">
     <ITEMS>
${item("multichoice", "1", 501, "How clear was the lab brief?", "clarity", "r>>>>>Very clear|Clear|Unclear", "0", "")}
${item("textarea", "0", 502, "What would you change?", "changes", "30|5", "501", "Unclear")}
     </ITEMS>
</FEEDBACK>
`;
  };
  const databaseFieldsHtml = () => {
    if (mode === "database-no-fields") {
      return `<!doctype html><html><body class="path-mod-data course-2 cmid-10 cm-type-data"><div class="alert">Create a field to get started.</div></body></html>`;
    }
    const row = (fieldId, name, type) => `<tr>
        <td>${name}</td>
        <td><a href="/mod/data/field.php?d=31&amp;fid=${fieldId}&amp;sesskey=${PRIVATE_SESSION}&amp;mode=display"><img class="icon" alt="${type}" title="${type}" src="/theme/image.php/boost/data/1/field/${type}"></a>&nbsp;${type}</td>
        <td>Yes</td><td>Field description</td>
        <td><a href="/mod/data/field.php?d=31&amp;fid=${fieldId}&amp;sesskey=${PRIVATE_SESSION}&amp;mode=display">Edit</a></td>
      </tr>`;
    return `<!doctype html><html><body class="path-mod-data course-2 cmid-${mode === "database-other-module" ? "77" : "10"} cm-type-data">
      <table class="generaltable"><tbody>${row(71, "Species", "text")}${row(72, "Habitat", "menu")}</tbody></table>
      <div class="sortdefault"><form id="sortdefault" action="/mod/data/field.php" method="get">
        <input type="hidden" name="d" value="31"><input type="hidden" name="mode" value="sort">
        <input type="hidden" name="sesskey" value="${PRIVATE_SESSION}">
        <select id="defaultsort" name="defaultsort">
          <optgroup label="Fields"><option value="71">Species</option><option value="72" selected="selected">Habitat</option></optgroup>
          <optgroup label="Other"><option value="0">Time added</option></optgroup>
        </select>
      </form></div></body></html>`;
  };
  const overviewItem = (itemKey, value, extra = {}) => ({
    key: itemKey,
    name: itemKey,
    contenttype: "text",
    exportertype: null,
    alertlabel: null,
    alertcount: null,
    contentjson: JSON.stringify({ value, datatype: typeof value === "number" ? "integer" : "string", content: String(value) }),
    extrajson: null,
    ...extra,
  });
  const overviewActivity = (modname) => {
    if (modname === "choice") {
      const items = [overviewItem("name", "Lab preference")];
      if (mode !== "no-capability") items.push(overviewItem("studentwhoresponded", 2));
      return { name: "Lab preference", modname, contextid: 501, cmid: 8, url: `${origin}/mod/choice/view.php?id=8`, haserror: false, items };
    }
    if (modname === "feedback") {
      const items = [overviewItem("name", "Lab feedback")];
      if (mode !== "no-capability") items.push(overviewItem("responses", 5));
      return { name: "Lab feedback", modname, contextid: 502, cmid: 9, url: `${origin}/mod/feedback/view.php?id=9`, haserror: false, items };
    }
    const items = [overviewItem("name", "Species log"), overviewItem("totalentries", 7), overviewItem("comments", 3)];
    if (mode !== "no-capability") {
      items.push({
        key: "actions", name: "Approve", contenttype: "action", exportertype: "core_courseformat\\external\\overviewaction_exporter",
        alertlabel: "2 entries to approve", alertcount: "2",
        contentjson: JSON.stringify({ url: `${origin}/mod/data/view.php?id=10`, text: "Approve", badgevalue: 2 }), extrajson: null,
      });
    }
    return { name: "Species log", modname, contextid: 503, cmid: 10, url: `${origin}/mod/data/view.php?id=10`, haserror: false, items };
  };
  const overviewDecoy = (modname) => ({
    name: `${LEARNER_NAME} private activity`,
    modname,
    contextid: 900,
    cmid: 99,
    url: `${origin}/mod/${modname}/view.php?id=99`,
    haserror: false,
    items: [
      overviewItem("studentwhoresponded", 44),
      overviewItem("responses", 44),
      overviewItem("totalentries", 44),
      overviewItem("comments", 44),
      overviewItem("respondents", LEARNER_EMAIL),
    ],
  });

  const server = createServer({ key: readFileSync(key), cert: readFileSync(certificate) }, async (request, response) => {
    const target = new URL(request.url || "/", origin);
    requests.push({ method: request.method, pathname: target.pathname, search: target.search });
    if (target.pathname === "/course/view.php") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<!doctype html><body class="path-course course-2"><script>var M = { cfg: ${JSON.stringify({ wwwroot: origin, sesskey: PRIVATE_SESSION, userId: 3, courseId: 2 })} };</script></body>`);
      return;
    }
    if (request.method === "GET" && target.pathname === "/course/modedit.php") {
      const forms = new Map([["?update=8&return=0", choiceForm], ["?update=9&return=0", feedbackForm], ["?update=10&return=0", databaseForm]]);
      const form = forms.get(target.search);
      if (form) { response.writeHead(200, { "content-type": "text/html" }); response.end(form()); return; }
    }
    if (request.method === "GET" && target.pathname === "/mod/feedback/export.php" && target.search === "?id=9&action=exportfile") {
      if (mode === "feedback-no-items") { response.writeHead(500, { "content-type": "text/html" }); response.end("<!doctype html><body>error</body>"); return; }
      response.writeHead(200, { "content-type": "application/xml; charset=UTF-8", "content-disposition": 'attachment; filename="feedback_22.xml"' });
      response.end(feedbackItemsXml());
      return;
    }
    if (request.method === "GET" && target.pathname === "/mod/data/field.php" && target.search === "?id=10") {
      response.writeHead(200, { "content-type": "text/html" }); response.end(databaseFieldsHtml()); return;
    }
    if (request.method === "POST" && target.pathname === "/lib/ajax/service.php"
      && target.search === `?sesskey=${PRIVATE_SESSION}&info=core_courseformat_get_overview_information`) {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const call = JSON.parse(Buffer.concat(chunks).toString("utf8"))[0];
      assert.equal(call.index, 0);
      assert.equal(call.methodname, "core_courseformat_get_overview_information");
      assert.equal(call.args.courseid, 2);
      assert.ok(["choice", "feedback", "data"].includes(call.args.modname));
      if (mode === "overview-unavailable") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify([{ index: 0, error: "Invalid parameter value detected", exception: { errorcode: "invalidparameter" } }]));
        return;
      }
      const activities = mode === "overview-overflow"
        ? Array.from({ length: 501 }, (_, index) => ({ name: "Bounded", modname: call.args.modname, contextid: 1000 + index, cmid: 1000 + index, url: null, haserror: false, items: [] }))
        : [overviewDecoy(call.args.modname), overviewActivity(call.args.modname)];
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify([{
        index: 0,
        data: { courseid: 2, hasintegration: true, headers: [{ name: "Name", key: "name", align: "start" }], activities },
      }]));
      return;
    }
    response.writeHead(404).end();
  });

  try {
    await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", (error) => error ? reject(error) : resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");
    origin = `https://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
    const page = await browser.newPage({ ignoreHTTPSErrors: true });
    await page.goto(`${origin}/course/view.php?id=2`);
    const invoke = (read, args) => page.evaluate(
      executeMoodleActivityContentReadInPage,
      JSON.stringify({
        operation: { key: read.key, toolName: read.toolName, provider: "moodle", readOnly: true },
        arguments: args || { course_id: 2, module_id: read.moduleId },
        binding: { origin, siteUrl: `${origin}/`, principalId: "3", courseId: "2" },
        expiresAt: Date.now() + 60_000,
      }),
    );
    const read = (toolName) => READS.find((entry) => entry.toolName === toolName);
    const sourceRequests = () => requests.filter((entry) => entry.pathname !== "/course/view.php").length;

    assert.deepEqual(
      await page.evaluate(executeMoodleActivityContentReadInPage, JSON.stringify({ operation: { key: "moodle.form.choice.unknown.read.v1" } })),
      { ok: false, sent: false, error: "moodle_activity_content_read_operation_unsupported" },
    );
    const beforeInvalid = sourceRequests();
    assert.deepEqual(
      await invoke(read("moodle_get_choice_options"), { course_id: 2, module_id: 8, extra: true }),
      { ok: false, sent: false, error: "moodle_choice_options_arguments_invalid" },
    );
    assert.equal(sourceRequests(), beforeInvalid);

    const options = await invoke(read("moodle_get_choice_options"));
    assert.equal(options.ok, true, JSON.stringify(options));
    assert.deepEqual(options.data, {
      schema: "morrow.moodle-choice-options.v1", provider: "moodle", course_id: 2, module_id: 8, choice_id: 21,
      option_count: 2,
      options: [
        { option_id: 41, position: 1, text: "Morning lab", response_limit: 12 },
        { option_id: 42, position: 2, text: "Evening lab", response_limit: 0 },
      ],
      limit_answers: true, allow_multiple: false, has_responses: false,
      proof: {
        method: "course_modedit_form", complete: true, exact_module_binding: "course_modedit_form",
        required_capability: "moodle/course:manageactivities", option_limit: 100, option_rows: 2, text_limit: 4000,
      },
    });

    const choiceSummary = await invoke(read("moodle_get_choice_response_summary"));
    assert.equal(choiceSummary.ok, true, JSON.stringify(choiceSummary));
    assert.deepEqual(choiceSummary.data, {
      schema: "morrow.moodle-choice-response-summary.v1", provider: "moodle", course_id: 2, module_id: 8, choice_id: 21,
      responded_participant_count: 2, allow_multiple: false,
      proof: {
        method: "course_modedit_form+core_courseformat_get_overview_information", complete: true,
        exact_module_binding: "course_modedit_form", required_capability: "mod/choice:readresponses",
        activity_limit: 500, activity_rows: 2, overview_item_key: "studentwhoresponded",
      },
    });

    const items = await invoke(read("moodle_get_feedback_items"));
    assert.equal(items.ok, true, JSON.stringify(items));
    assert.deepEqual(items.data, {
      schema: "morrow.moodle-feedback-items.v1", provider: "moodle", course_id: 2, module_id: 9, feedback_id: 22,
      anonymous: true, item_count: 2,
      items: [
        {
          item_id: 501, position: 1, type: "multichoice", required: true,
          text: "How clear was the lab brief?", label: "clarity", presentation: "r>>>>>Very clear|Clear|Unclear",
          depends_on_item_id: null, depends_on_value: "",
        },
        {
          item_id: 502, position: 2, type: "textarea", required: false,
          text: "What would you change?", label: "changes", presentation: "30|5",
          depends_on_item_id: 501, depends_on_value: "Unclear",
        },
      ],
      proof: {
        method: "course_modedit_form+mod_feedback_export_items", complete: true, exact_module_binding: "course_modedit_form",
        required_capability: "mod/feedback:edititems", item_limit: 200, item_rows: 2, text_limit: 4000,
      },
    });

    const feedbackSummary = await invoke(read("moodle_get_feedback_response_summary"));
    assert.equal(feedbackSummary.ok, true, JSON.stringify(feedbackSummary));
    assert.deepEqual(feedbackSummary.data, {
      schema: "morrow.moodle-feedback-response-summary.v1", provider: "moodle", course_id: 2, module_id: 9, feedback_id: 22,
      anonymous: true, response_count: 5, per_learner_projection: "refused_anonymous",
      proof: {
        method: "course_modedit_form+core_courseformat_get_overview_information", complete: true,
        exact_module_binding: "course_modedit_form", required_capability: "mod/feedback:viewreports",
        activity_limit: 500, activity_rows: 2, overview_item_key: "responses",
      },
    });

    const fields = await invoke(read("moodle_get_database_fields"));
    assert.equal(fields.ok, true, JSON.stringify(fields));
    assert.deepEqual(fields.data, {
      schema: "morrow.moodle-database-fields.v1", provider: "moodle", course_id: 2, module_id: 10, database_id: 31,
      field_count: 2, default_sort_field_id: 72,
      fields: [{ field_id: 71, name: "Species", type: "text" }, { field_id: 72, name: "Habitat", type: "menu" }],
      proof: {
        method: "course_modedit_form+mod_data_field_index", complete: true, exact_module_binding: "course_modedit_form",
        required_capability: "mod/data:managetemplates", field_limit: 100, field_rows: 2, text_limit: 4000,
      },
    });

    const entries = await invoke(read("moodle_get_database_entry_summary"));
    assert.equal(entries.ok, true, JSON.stringify(entries));
    assert.deepEqual(entries.data, {
      schema: "morrow.moodle-database-entry-summary.v1", provider: "moodle", course_id: 2, module_id: 10, database_id: 31,
      entry_count: 7, entries_awaiting_approval: 2, comment_count: 3, approval_required: true,
      proof: {
        method: "course_modedit_form+core_courseformat_get_overview_information", complete: true,
        exact_module_binding: "course_modedit_form", required_capability: "mod/data:approve",
        activity_limit: 500, activity_rows: 2, overview_item_key: "totalentries",
      },
    });

    const serialized = JSON.stringify([options, choiceSummary, items, feedbackSummary, fields, entries]);
    for (const privateValue of [PRIVATE_SESSION, LEARNER_NAME, LEARNER_EMAIL, "respondents"]) {
      assert.equal(serialized.includes(privateValue), false, `result leaked ${privateValue}`);
    }
    assert.equal(requests.some((entry) => entry.pathname.endsWith("/view.php") && entry.pathname !== "/course/view.php"), false);
    assert.equal(requests.some((entry) => entry.pathname === "/mod/choice/report.php" || entry.pathname === "/mod/feedback/show_entries.php"
      || entry.pathname === "/mod/feedback/analysis.php"), false);

    mode = "choice-responses";
    assert.equal((await invoke(read("moodle_get_choice_options"))).data.has_responses, true);
    mode = "named-feedback";
    const named = await invoke(read("moodle_get_feedback_response_summary"));
    assert.equal(named.data.anonymous, false);
    assert.equal(named.data.per_learner_projection, "not_supported");
    mode = "database-no-fields";
    const empty = await invoke(read("moodle_get_database_fields"));
    assert.equal(empty.data.field_count, 0);
    assert.deepEqual(empty.data.fields, []);
    assert.equal(empty.data.default_sort_field_id, null);

    mode = "database-other-module";
    assert.deepEqual(await invoke(read("moodle_get_database_fields")), { ok: false, sent: false, error: "moodle_database_fields_target_unavailable" });
    mode = "feedback-no-items";
    assert.deepEqual(await invoke(read("moodle_get_feedback_items")), { ok: false, sent: false, error: "moodle_feedback_items_unavailable" });
    mode = "no-capability";
    assert.deepEqual(await invoke(read("moodle_get_choice_response_summary")), { ok: false, sent: false, error: "moodle_choice_response_summary_capability_missing" });
    assert.deepEqual(await invoke(read("moodle_get_feedback_response_summary")), { ok: false, sent: false, error: "moodle_feedback_response_summary_capability_missing" });
    assert.deepEqual(await invoke(read("moodle_get_database_entry_summary")), { ok: false, sent: false, error: "moodle_database_entry_summary_capability_missing" });
    mode = "overview-unavailable";
    assert.deepEqual(await invoke(read("moodle_get_database_entry_summary")), { ok: false, sent: false, error: "moodle_database_entry_summary_service_unavailable" });
    mode = "overview-overflow";
    assert.deepEqual(await invoke(read("moodle_get_choice_response_summary")), { ok: false, sent: false, complete: false, error: "moodle_choice_response_summary_incomplete" });
    mode = "choice-overflow";
    assert.deepEqual(await invoke(read("moodle_get_choice_options")), { ok: false, sent: false, complete: false, error: "moodle_choice_options_incomplete" });

    for (const failure of ["wrong-module", "wrong-course", "wrong-type"]) {
      mode = failure;
      for (const entry of READS) {
        const before = sourceRequests();
        assert.deepEqual(await invoke(entry), { ok: false, sent: false, error: `${entry.toolName.replace("moodle_get_", "moodle_")}_target_unavailable` });
        assert.equal(sourceRequests(), before + 1, `${entry.toolName} kept reading after a failed binding`);
      }
    }
  } finally {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
});
