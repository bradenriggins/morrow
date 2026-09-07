import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { executeMoodleGlossaryWikiInPage } from "../../connector/extension/src/moodle-glossary-wiki-executor.js";

const OPERATIONS = Object.freeze([
  { key: "moodle.form.glossary.entries.read.v1", toolName: "moodle_list_glossary_entries", readOnly: true },
  { key: "moodle.form.glossary.entry.read.v1", toolName: "moodle_get_glossary_entry", readOnly: true },
  { key: "moodle.form.glossary.entry.create.write.v1", toolName: "moodle_create_glossary_entry", readOnly: false, reviewTool: "moodle_list_glossary_entries" },
  { key: "moodle.form.glossary.entry.update.write.v1", toolName: "moodle_update_glossary_entry", readOnly: false, reviewTool: "moodle_get_glossary_entry" },
  { key: "moodle.form.wiki.pages.read.v1", toolName: "moodle_list_wiki_pages", readOnly: true },
  { key: "moodle.form.wiki.page.read.v1", toolName: "moodle_get_wiki_page", readOnly: true },
  { key: "moodle.form.wiki.page.update.write.v1", toolName: "moodle_update_wiki_page", readOnly: false, reviewTool: "moodle_get_wiki_page" },
]);

test("every Glossary entry and Wiki page operation is cataloged and routed through the extension worker", () => {
  const root = new URL("../..", import.meta.url);
  const catalog = JSON.parse(readFileSync(new URL("connector/extension/generated/moodle-browser-catalog.json", root), "utf8"));
  const worker = readFileSync(new URL("connector/extension/src/service-worker.js", root), "utf8");
  const policy = readFileSync(new URL("connector/extension/src/edit-policy.js", root), "utf8");
  const bundle = readFileSync(new URL("scripts/package-mcp-bundle.mjs", root), "utf8");
  assert.match(worker, /import \{ executeMoodleGlossaryWikiInPage \} from "\.\/moodle-glossary-wiki-executor\.js";/);
  assert.match(worker, /func: executeMoodleGlossaryWikiInPage/);
  assert.ok(bundle.includes('"src/moodle-glossary-wiki-executor.js"'), "the executor is not in the Bridge release file set");
  const tools = new Map(catalog.operations.map((entry) => [entry.toolName, entry]));
  for (const operation of OPERATIONS) {
    const entries = catalog.operations.filter((entry) => entry.key === operation.key);
    assert.equal(entries.length, 1, `${operation.key} is not in the catalog exactly once`);
    assert.equal(entries[0].toolName, operation.toolName);
    assert.equal(entries[0].provider, "moodle");
    assert.equal(entries[0].readOnly, operation.readOnly);
    assert.ok(worker.includes(`"${operation.key}"`), `${operation.key} is not routed by the worker`);
    if (operation.readOnly) {
      assert.equal(entries[0].reviewTool, undefined);
      continue;
    }
    assert.equal(entries[0].reviewTool, operation.reviewTool, `${operation.toolName} must be reviewed through its own read`);
    assert.ok(tools.has(operation.reviewTool), `${operation.reviewTool} is not in the catalog`);
    // Every write here saves content that learners can see, and Morrow has no
    // route that puts the previous state back, so the Edit card says so.
    assert.ok(policy.includes(`"${operation.toolName}"`), `${operation.toolName} is not named in the Edit policy`);
  }
  assert.equal(tools.get("moodle_update_glossary_entry").irreversible, true);
});

test("Glossary entry and Wiki page reads and writes bind one activity, act once, and read the saved state back", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morrow-moodle-glossary-wiki-"));
  const key = join(directory, "key.pem");
  const certificate = join(directory, "certificate.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", certificate], { stdio: "ignore" });
  const PRIVATE_SESSION = "moodle-private-session";
  const GLOSSARY_MODULE = "8";
  const GLOSSARY_ID = "21";
  const WIKI_MODULE = "9";
  const WIKI_ID = "31";
  const EXPORT_FILE = "/pluginfile.php/501/mod_glossary/export/0/0/export.xml";
  const requests = [];
  let origin = "";
  let defaultApproval = "1";
  let attachmentFileCount = 0;
  let draftListingReadable = true;
  let writeResponse = "redirect";
  let wikiLocked = false;
  let browser;

  const entries = [
    {
      id: "101", concept: "Rubric", definition: "<p>A scoring guide.</p>", approved: true,
      aliases: ["Scoring guide"], categories: ["Assessment"], teacher: true,
    },
    {
      id: "102", concept: "Waiting entry", definition: "<p>Not approved yet.</p>", approved: false,
      aliases: [], categories: [], teacher: false,
    },
  ];
  const wikiPages = new Map([
    ["51", { title: "Lab safety", version: 4, content: "<p>Wear goggles.</p>" }],
    ["52", { title: "Equipment list", version: 2, content: "<p>Two microscopes.</p>" }],
  ]);
  const escape = (value) => String(value)
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#039;");
  const readBody = async (request) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    return Buffer.concat(chunks).toString("utf8");
  };
  const html = (response, body) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(body);
  };
  const json = (response, payload) => {
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(payload));
  };

  const settingsForm = (module, moduleId, instance, name, controls) => `<!doctype html><html><body class="path-course course-2">
    <form method="post" action="/course/modedit.php?update=${moduleId}&amp;return=0">
      <input type="hidden" name="course" value="2"><input type="hidden" name="coursemodule" value="${moduleId}">
      <input type="hidden" name="update" value="${moduleId}"><input type="hidden" name="modulename" value="${module}">
      <input type="hidden" name="instance" value="${instance}"><input type="hidden" name="sesskey" value="${PRIVATE_SESSION}">
      <input type="text" name="name" value="${escape(name)}">
      <select name="visible"><option value="0">Hide</option><option value="1" selected="selected">Show</option></select>
      ${controls}
      <input type="submit" name="submitbutton" value="Save and return to course">
    </form></body></html>`;
  const glossarySettings = () => settingsForm("glossary", GLOSSARY_MODULE, GLOSSARY_ID, "Course glossary", `
      <select name="defaultapproval">
        <option value="0"${defaultApproval === "0" ? ' selected="selected"' : ""}>No</option>
        <option value="1"${defaultApproval === "1" ? ' selected="selected"' : ""}>Yes</option>
      </select>
      <select name="allowcomments"><option value="0" selected="selected">No</option><option value="1">Yes</option></select>`);
  const wikiSettings = () => settingsForm("wiki", WIKI_MODULE, WIKI_ID, "Lab wiki", `
      <select name="defaultformat"><option value="html" selected="selected">HTML</option><option value="creole">Creole</option></select>`);

  const exportPage = () => `<!doctype html><html><body class="path-mod-glossary course-2 cmid-${GLOSSARY_MODULE} cm-type-glossary">
    <form action="${EXPORT_FILE}?forcedownload=1" method="post"><input class="btn" type="submit" value="Export entries to file"></form>
    </body></html>`;
  const exportXml = () => {
    const tag = (name, value, indent) => `${" ".repeat(indent)}<${name}>${escape(value)}</${name}>\n`;
    const entryXml = (entry) => {
      const aliases = entry.aliases.length
        ? `      <ALIASES>\n${entry.aliases.map((alias) => `        <ALIAS>\n${tag("NAME", alias, 10)}        </ALIAS>\n`).join("")}      </ALIASES>\n`
        : "";
      const categories = entry.categories.length
        ? `      <CATEGORIES>\n${entry.categories.map((category) => `        <CATEGORY>\n${tag("NAME", category, 10)}${tag("USEDYNALINK", "0", 10)}        </CATEGORY>\n`).join("")}      </CATEGORIES>\n`
        : "";
      return `      <ENTRY>\n${tag("CONCEPT", entry.concept, 8)}${tag("DEFINITION", entry.definition, 8)}${tag("FORMAT", "1", 8)}${tag("DEFINITIONTRUST", "0", 8)}${tag("USEDYNALINK", "0", 8)}${tag("CASESENSITIVE", "0", 8)}${tag("FULLMATCH", "0", 8)}${tag("TEACHERENTRY", entry.teacher ? "1" : "0", 8)}${aliases}${categories}      </ENTRY>\n`;
    };
    const approved = entries.filter((entry) => entry.approved).map(entryXml).join("");
    return `<?xml version="1.0" encoding="UTF-8"?>
<GLOSSARY>
  <INFO>
${tag("NAME", "Course glossary", 4)}${tag("INTRO", "<p>Terms.</p>", 4)}${tag("DEFAULTAPPROVAL", defaultApproval, 4)}    <ENTRIES>
${approved}    </ENTRIES>
  </INFO>
</GLOSSARY>
`;
  };
  const glossaryEntryForm = (entry) => `<!doctype html><html><body class="path-mod-glossary course-2 cmid-${GLOSSARY_MODULE} cm-type-glossary">
    <form method="post" action="/mod/glossary/edit.php?cmid=${GLOSSARY_MODULE}${entry ? `&amp;id=${entry.id}` : ""}" id="mform1">
      <input type="hidden" name="sesskey" value="${PRIVATE_SESSION}">
      <input type="hidden" name="_qf__mod_glossary_entry_form" value="1">
      <input type="text" name="concept" value="${entry ? escape(entry.concept) : ""}">
      <textarea name="definition_editor[text]">${entry ? escape(entry.definition) : ""}</textarea>
      <input type="hidden" name="definition_editor[format]" value="1">
      <input type="hidden" name="definition_editor[itemid]" value="700">
      <textarea name="aliases">${entry ? escape(entry.aliases.join("\n")) : ""}</textarea>
      <input type="hidden" name="attachment_filemanager" value="800">
      <input type="hidden" name="usedynalink" value="0">
      <input type="hidden" name="casesensitive" value="0">
      <input type="hidden" name="fullmatch" value="0">
      <input type="hidden" name="id" value="${entry ? entry.id : ""}">
      <input type="hidden" name="cmid" value="${GLOSSARY_MODULE}">
      <input type="submit" name="submitbutton" value="Save changes">
      <input type="submit" name="cancel" value="Cancel">
    </form></body></html>`;
  const wikiSearchPage = () => {
    const rows = [...wikiPages.entries()].map(([pageId, page]) => `<table class="generaltable"><thead><tr>
        <th class="header" scope="col">${escape(page.title)} (<a href="/mod/wiki/view.php?pageid=${pageId}">View</a>)</th>
      </tr></thead><tbody><tr><td class="cell wikisearchresults">${page.content}</td></tr></tbody></table>`).join("");
    return `<!doctype html><html><body class="path-mod-wiki course-2 cmid-${WIKI_MODULE} cm-type-wiki">
      <div class="no-overflow"><h3>Search results ${wikiPages.size}</h3>${rows}</div></body></html>`;
  };
  const wikiEditPage = (pageId, page) => {
    if (wikiLocked) {
      return `<!doctype html><html><body class="path-mod-wiki course-2 cmid-${WIKI_MODULE} cm-type-wiki">
        <div class="generalbox">This page is already being edited.</div>
        <form method="post" action="/mod/wiki/overridelocks.php?pageid=${pageId}">
          <input type="hidden" name="sesskey" value="${PRIVATE_SESSION}">
          <input type="submit" class="btn" value="Override locks">
        </form></body></html>`;
    }
    return `<!doctype html><html><body class="path-mod-wiki course-2 cmid-${WIKI_MODULE} cm-type-wiki">
      <form method="post" action="/mod/wiki/edit.php?pageid=${pageId}" id="mform1">
        <input type="hidden" name="sesskey" value="${PRIVATE_SESSION}">
        <input type="hidden" name="_qf__mod_wiki_edit_form" value="1">
        <textarea name="newcontent_editor[text]">${escape(page.content)}</textarea>
        <input type="hidden" name="newcontent_editor[format]" value="1">
        <input type="hidden" name="newcontent_editor[itemid]" value="900">
        <input type="hidden" name="version" value="${page.version}">
        <input type="hidden" name="contentformat" value="html">
        <input type="hidden" name="tags[_qf__force_multiselect_submission]" value="">
        <input type="submit" id="save" name="editoption" value="Save">
        <input type="submit" id="preview" name="editoption" value="Preview">
        <input type="submit" id="cancel" name="editoption" value="Cancel">
      </form></body></html>`;
  };

  const server = createServer({ key: readFileSync(key), cert: readFileSync(certificate) }, async (request, response) => {
    const target = new URL(request.url || "/", origin);
    requests.push({ method: request.method, pathname: target.pathname, search: target.search });
    if (target.pathname === "/course/view.php") {
      html(response, `<!doctype html><body class="path-course course-2"><script>var M = { cfg: ${JSON.stringify({ wwwroot: origin, sesskey: PRIVATE_SESSION, userId: 3, courseId: 2 })} };</script></body>`);
      return;
    }
    if (request.method === "GET" && target.pathname === "/course/modedit.php") {
      if (target.search === `?update=${GLOSSARY_MODULE}&return=0`) { html(response, glossarySettings()); return; }
      if (target.search === `?update=${WIKI_MODULE}&return=0`) { html(response, wikiSettings()); return; }
    }
    if (request.method === "GET" && target.pathname === "/mod/glossary/export.php" && target.search === `?id=${GLOSSARY_MODULE}`) {
      html(response, exportPage());
      return;
    }
    if (request.method === "GET" && target.pathname === EXPORT_FILE) {
      response.writeHead(200, { "content-type": "application/xml; charset=utf-8", "content-disposition": 'attachment; filename="Course glossary.xml"' });
      response.end(exportXml());
      return;
    }
    if (request.method === "GET" && target.pathname === "/mod/glossary/edit.php") {
      const entryId = target.searchParams.get("id");
      if (target.searchParams.get("cmid") !== GLOSSARY_MODULE) { response.writeHead(404).end(); return; }
      const entry = entryId ? entries.find((candidate) => candidate.id === entryId) : null;
      if (entryId && !entry) { response.writeHead(404).end(); return; }
      html(response, glossaryEntryForm(entry));
      return;
    }
    if (request.method === "POST" && target.pathname === "/mod/glossary/edit.php") {
      const body = new URLSearchParams(await readBody(request));
      assert.equal(body.get("sesskey"), PRIVATE_SESSION);
      assert.equal(body.get("submitbutton"), "Save changes");
      assert.equal(body.get("cancel"), null);
      assert.equal(body.get("cmid"), GLOSSARY_MODULE);
      assert.equal(body.get("definition_editor[format]"), "1");
      assert.equal(body.get("attachment_filemanager"), "800");
      const entryId = body.get("id") || "";
      const concept = body.get("concept") || "";
      const definition = body.get("definition_editor[text]") || "";
      if (entryId) {
        const entry = entries.find((candidate) => candidate.id === entryId);
        assert.ok(entry, "the update names a known entry");
        entry.concept = concept;
        entry.definition = definition;
        // glossary_edit_entry clears the approval and sets it again only for a
        // Glossary that approves by default or a person who can approve.
        entry.approved = defaultApproval === "1";
      } else {
        entries.push({ id: String(200 + entries.length), concept, definition, approved: defaultApproval === "1", aliases: [], categories: [], teacher: true });
      }
      if (writeResponse === "lost") { response.writeHead(500, { "content-type": "text/html" }); response.end("<p>gateway problem</p>"); return; }
      response.writeHead(303, { location: `/mod/glossary/view.php?id=${GLOSSARY_MODULE}&mode=entry&hook=${entryId || "999"}` });
      response.end();
      return;
    }
    if (request.method === "POST" && target.pathname === "/repository/draftfiles_ajax.php") {
      const body = new URLSearchParams(await readBody(request));
      assert.equal(body.get("sesskey"), PRIVATE_SESSION);
      assert.equal(body.get("filepath"), "/");
      if (!draftListingReadable) { json(response, { error: "cannot list this draft area" }); return; }
      const list = Array.from({ length: attachmentFileCount }, (_, index) => ({ filename: `left-behind-${index}.pdf`, filepath: "/" }));
      json(response, { filecount: list.length, list, filepath: [{ path: "/" }] });
      return;
    }
    if (request.method === "POST" && target.pathname === "/lib/ajax/service.php") {
      const call = JSON.parse(await readBody(request))[0];
      assert.equal(target.search, `?sesskey=${PRIVATE_SESSION}&info=${call.methodname}`);
      assert.equal(call.index, 0);
      assert.equal(call.methodname, "mod_glossary_get_entry_by_id");
      const entry = entries.find((candidate) => candidate.id === String(call.args.id));
      if (!entry) { json(response, [{ index: 0, error: "invalidentry", exception: { errorcode: "invalidentry" } }]); return; }
      json(response, [{
        index: 0,
        data: {
          entry: {
            id: Number(entry.id), glossaryid: Number(GLOSSARY_ID), concept: entry.concept,
            definition: `<p>filtered ${entry.concept}</p>`, definitionformat: 1, approved: entry.approved,
            timecreated: 1, timemodified: 2, attachment: false, attachments: [], tags: [],
          },
          permissions: { candelete: true, canupdate: true },
          warnings: [],
        },
      }]);
      return;
    }
    if (request.method === "GET" && target.pathname === "/mod/wiki/search.php") {
      if (target.search !== `?courseid=2&cmid=${WIKI_MODULE}&searchstring=`) { response.writeHead(404).end(); return; }
      html(response, wikiSearchPage());
      return;
    }
    if (request.method === "GET" && target.pathname === "/mod/wiki/edit.php") {
      const pageId = target.searchParams.get("pageid") || "";
      const page = wikiPages.get(pageId);
      if (!page) { response.writeHead(404).end(); return; }
      html(response, wikiEditPage(pageId, page));
      return;
    }
    if (request.method === "POST" && target.pathname === "/mod/wiki/edit.php") {
      const pageId = target.searchParams.get("pageid") || "";
      const page = wikiPages.get(pageId);
      assert.ok(page, "the write names a known page");
      const body = new URLSearchParams(await readBody(request));
      assert.equal(body.get("sesskey"), PRIVATE_SESSION);
      assert.equal(body.get("editoption"), "Save");
      assert.equal(body.get("contentformat"), "html");
      assert.equal(body.get("version"), String(page.version));
      page.content = body.get("newcontent_editor[text]") || "";
      page.version += 1;
      if (writeResponse === "lost") { response.writeHead(500, { "content-type": "text/html" }); response.end("<p>gateway problem</p>"); return; }
      response.writeHead(303, { location: `/mod/wiki/view.php?pageid=${pageId}` });
      response.end();
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
    const invoke = (toolName, args) => {
      const operation = OPERATIONS.find((entry) => entry.toolName === toolName);
      return page.evaluate(executeMoodleGlossaryWikiInPage, JSON.stringify({
        mode: "execute",
        operation: { key: operation.key, toolName: operation.toolName, provider: "moodle", readOnly: operation.readOnly },
        arguments: args,
        binding: { origin, siteUrl: `${origin}/`, principalId: "3", courseId: "2" },
        expiresAt: Date.now() + 60_000,
      }));
    };
    const dispatches = () => requests.filter((entry) => entry.method === "POST"
      && (entry.pathname === "/mod/glossary/edit.php" || entry.pathname === "/mod/wiki/edit.php")).length;

    assert.deepEqual(
      await page.evaluate(executeMoodleGlossaryWikiInPage, JSON.stringify({ mode: "execute", operation: { key: "moodle.form.glossary.unknown.read.v1" } })),
      { ok: false, sent: false, error: "moodle_glossary_wiki_operation_unsupported" },
    );
    const beforeInvalid = requests.length;
    assert.deepEqual(
      await invoke("moodle_list_glossary_entries", { course_id: 2, module_id: 8, extra: true }),
      { ok: false, sent: false, error: "moodle_glossary_arguments_invalid" },
    );
    assert.equal(requests.length, beforeInvalid, "an invalid request reaches no Moodle route");

    // The entry list is Moodle's own export, so it carries the approved entries
    // and says plainly that it carries neither the others nor an entry ID.
    const listed = await invoke("moodle_list_glossary_entries", { course_id: 2, module_id: 8 });
    assert.equal(listed.ok, true, JSON.stringify(listed));
    assert.deepEqual(listed.data, {
      schema: "morrow.moodle-glossary-entries.v1", provider: "moodle", course_id: 2, module_id: 8, glossary_id: 21,
      activity_name: "Course glossary", visible: true,
      entry_count: 1,
      entries: [{
        position: 1, concept: "Rubric", definition: "<p>A scoring guide.</p>", teacher_entry: true,
        aliases: ["Scoring guide"], categories: ["Assessment"], file_count: 0,
      }],
      listed_entries: "approved_only", entry_ids_listed: false,
      proof: {
        exact_module_binding: "course_modedit_form", required_capability: "mod/glossary:export",
        learner_identity: "never_returned", method: "mod_glossary_export_xml",
        native_route: "/mod/glossary/export.php", entry_limit: 500,
      },
    });
    assert.deepEqual(listed.targets, [{ field: "module_id", label: "Glossary", name: "Course glossary" }]);

    const entry = await invoke("moodle_get_glossary_entry", { course_id: 2, module_id: 8, entry_id: 101 });
    assert.equal(entry.ok, true, JSON.stringify(entry));
    assert.deepEqual(entry.data, {
      schema: "morrow.moodle-glossary-entry.v1", provider: "moodle", course_id: 2, module_id: 8, glossary_id: 21,
      activity_name: "Course glossary", visible: true,
      entry_id: 101, concept: "Rubric", definition: "<p>A scoring guide.</p>", definition_format: "1",
      aliases: ["Scoring guide"], approved: true, has_attachment: false,
      used_for_linking: false, case_sensitive: false, full_match: false,
      proof: {
        exact_module_binding: "course_modedit_form", required_capability: "mod/glossary:write",
        learner_identity: "never_returned", method: "mod_glossary_entry_form+mod_glossary_get_entry_by_id",
        native_route: "/mod/glossary/edit.php",
      },
    });
    // The entry that is waiting for approval is readable one by one even though
    // the export leaves it out.
    const waiting = await invoke("moodle_get_glossary_entry", { course_id: 2, module_id: 8, entry_id: 102 });
    assert.equal(waiting.data.approved, false);

    // A create is refused before it is sent when the review no longer matches,
    // when the person has not confirmed what learners will see, when the
    // Glossary would hold the entry back for approval, and when the form
    // carries a file Morrow did not review.
    let mark = dispatches();
    assert.deepEqual(
      await invoke("moodle_create_glossary_entry", {
        course_id: 2, module_id: 8, concept: "Moderation", definition_html: "<p>A second read.</p>",
        learner_visibility_confirmed: true, expected_digest: "0".repeat(64),
      }),
      { ok: false, sent: false, status: 200, error: "moodle_glossary_expected_digest_mismatch" },
    );
    assert.deepEqual(
      await invoke("moodle_create_glossary_entry", {
        course_id: 2, module_id: 8, concept: "Moderation", definition_html: "<p>A second read.</p>",
        learner_visibility_confirmed: false, expected_digest: listed.snapshot_digest,
      }),
      { ok: false, sent: false, status: 200, error: "moodle_glossary_learner_visibility_unconfirmed" },
    );
    defaultApproval = "0";
    const held = await invoke("moodle_list_glossary_entries", { course_id: 2, module_id: 8 });
    assert.deepEqual(
      await invoke("moodle_create_glossary_entry", {
        course_id: 2, module_id: 8, concept: "Moderation", definition_html: "<p>A second read.</p>",
        learner_visibility_confirmed: true, expected_digest: held.snapshot_digest,
      }),
      { ok: false, sent: false, status: 200, error: "moodle_glossary_default_approval_required" },
    );
    defaultApproval = "1";
    attachmentFileCount = 1;
    assert.deepEqual(
      await invoke("moodle_create_glossary_entry", {
        course_id: 2, module_id: 8, concept: "Moderation", definition_html: "<p>A second read.</p>",
        learner_visibility_confirmed: true, expected_digest: listed.snapshot_digest,
      }),
      { ok: false, sent: false, status: 200, error: "moodle_glossary_attachment_area_refused" },
    );
    draftListingReadable = false;
    assert.deepEqual(
      await invoke("moodle_create_glossary_entry", {
        course_id: 2, module_id: 8, concept: "Moderation", definition_html: "<p>A second read.</p>",
        learner_visibility_confirmed: true, expected_digest: listed.snapshot_digest,
      }),
      { ok: false, sent: false, status: 200, error: "moodle_glossary_attachment_area_unverified" },
    );
    draftListingReadable = true;
    attachmentFileCount = 0;
    // A definition that names a Moodle file is refused, because Morrow reviews
    // no file and the reference would not resolve.
    assert.deepEqual(
      await invoke("moodle_create_glossary_entry", {
        course_id: 2, module_id: 8, concept: "Moderation", definition_html: '<p><img src="@@PLUGINFILE@@/note.png"></p>',
        learner_visibility_confirmed: true, expected_digest: listed.snapshot_digest,
      }),
      { ok: false, sent: false, status: 200, error: "moodle_glossary_definition_refused" },
    );
    assert.equal(dispatches(), mark, "no refusal sent anything");

    const created = await invoke("moodle_create_glossary_entry", {
      course_id: 2, module_id: 8, concept: "Moderation", definition_html: "<p>A second read.</p>",
      learner_visibility_confirmed: true, expected_digest: listed.snapshot_digest,
    });
    assert.equal(created.ok, true, JSON.stringify(created));
    assert.equal(dispatches(), mark + 1, "one create sends exactly one POST");
    assert.deepEqual(created.verification, { schema: "morrow.browser-verification.v1", status: "verified" });
    assert.equal(created.data.entry_count, 2);
    assert.equal(created.data.created_concept, "Moderation");
    assert.deepEqual(created.data.entries[1], {
      position: 2, concept: "Moderation", definition: "<p>A second read.</p>", teacher_entry: true,
      aliases: [], categories: [], file_count: 0,
    });
    assert.deepEqual(created.data.proof, {
      exact_module_binding: "course_modedit_form", required_capability: "mod/glossary:write",
      learner_identity: "never_returned", method: "mod_glossary_entry_form",
      native_route: "/mod/glossary/edit.php", dispatch_count: 1, readback: "mod_glossary_export_xml",
      created_entry_id: "not_returned", approval_state: "approved_by_default", learner_visible: true,
    });
    assert.deepEqual(created.targets, [
      { field: "module_id", label: "Glossary", name: "Course glossary" },
      { field: "entry_id", label: "Entry", name: "Moderation" },
    ]);
    // The same concept twice would make the readback ambiguous.
    const afterCreate = await invoke("moodle_list_glossary_entries", { course_id: 2, module_id: 8 });
    assert.deepEqual(
      await invoke("moodle_create_glossary_entry", {
        course_id: 2, module_id: 8, concept: "Moderation", definition_html: "<p>Again.</p>",
        learner_visibility_confirmed: true, expected_digest: afterCreate.snapshot_digest,
      }),
      { ok: false, sent: false, status: 200, error: "moodle_glossary_concept_exists" },
    );

    // One update, bound to the reviewed entry, sends one POST and reads the
    // saved entry and its approval state back.
    const reviewed = await invoke("moodle_get_glossary_entry", { course_id: 2, module_id: 8, entry_id: 101 });
    mark = dispatches();
    assert.deepEqual(
      await invoke("moodle_update_glossary_entry", {
        course_id: 2, module_id: 8, entry_id: 101, definition_html: "<p>A scoring guide with levels.</p>",
        expected_digest: "1".repeat(64),
      }),
      { ok: false, sent: false, status: 200, error: "moodle_glossary_expected_digest_mismatch" },
    );
    assert.deepEqual(
      await invoke("moodle_update_glossary_entry", {
        course_id: 2, module_id: 8, entry_id: 101, definition_html: "<p>A scoring guide.</p>",
        expected_digest: reviewed.snapshot_digest,
      }),
      { ok: false, sent: false, status: 200, error: "moodle_glossary_change_absent" },
    );
    assert.equal(dispatches(), mark);
    const updated = await invoke("moodle_update_glossary_entry", {
      course_id: 2, module_id: 8, entry_id: 101, concept: "Rubric", definition_html: "<p>A scoring guide with levels.</p>",
      expected_digest: reviewed.snapshot_digest,
    });
    assert.equal(updated.ok, true, JSON.stringify(updated));
    assert.equal(dispatches(), mark + 1, "one update sends exactly one POST");
    assert.equal(updated.data.definition, "<p>A scoring guide with levels.</p>");
    assert.equal(updated.data.approved, true);
    assert.equal(updated.data.approved_before, true);
    assert.equal(updated.data.proof.approval_state, "unchanged");
    assert.equal(updated.data.proof.dispatch_count, 1);
    assert.deepEqual(updated.verification, { schema: "morrow.browser-verification.v1", status: "verified" });
    assert.equal(entries.find((candidate) => candidate.id === "101").definition, "<p>A scoring guide with levels.</p>");

    // Moodle clears the approval on every save. Morrow reads that back and says
    // so instead of reporting the entry as unchanged.
    defaultApproval = "0";
    const beforeApprovalLoss = await invoke("moodle_get_glossary_entry", { course_id: 2, module_id: 8, entry_id: 101 });
    const unapproved = await invoke("moodle_update_glossary_entry", {
      course_id: 2, module_id: 8, entry_id: 101, definition_html: "<p>A scoring guide with three levels.</p>",
      expected_digest: beforeApprovalLoss.snapshot_digest,
    });
    assert.equal(unapproved.ok, true, JSON.stringify(unapproved));
    assert.equal(unapproved.data.approved, false);
    assert.equal(unapproved.data.approved_before, true);
    assert.equal(unapproved.data.proof.approval_state, "changed_by_moodle");
    defaultApproval = "1";

    // A lost response after one dispatch is applied_or_unknown, and nothing is
    // sent again.
    writeResponse = "lost";
    const lostReview = await invoke("moodle_get_glossary_entry", { course_id: 2, module_id: 8, entry_id: 101 });
    mark = dispatches();
    const lost = await invoke("moodle_update_glossary_entry", {
      course_id: 2, module_id: 8, entry_id: 101, definition_html: "<p>Sent once.</p>",
      expected_digest: lostReview.snapshot_digest,
    });
    assert.deepEqual(lost, {
      ok: false,
      sent: true,
      status: 500,
      outcomeUnknown: true,
      verification: { schema: "morrow.browser-verification.v1", status: "unconfirmed", reason: "moodle_glossary_write_unconfirmed" },
      error: "moodle_glossary_write_unconfirmed",
    });
    assert.equal(dispatches(), mark + 1, "a lost response is never sent again");
    assert.equal(entries.find((candidate) => candidate.id === "101").definition, "<p>Sent once.</p>", "the fixture saved the write whose response was lost");
    writeResponse = "redirect";

    // Wiki: the page list, one page bound to its exact version, and one write.
    const pages = await invoke("moodle_list_wiki_pages", { course_id: 2, module_id: 9 });
    assert.equal(pages.ok, true, JSON.stringify(pages));
    assert.deepEqual(pages.data, {
      schema: "morrow.moodle-wiki-pages.v1", provider: "moodle", course_id: 2, module_id: 9, wiki_id: 31,
      activity_name: "Lab wiki", visible: true, page_count: 2,
      pages: [{ page_id: 51, title: "Lab safety" }, { page_id: 52, title: "Equipment list" }],
      proof: {
        exact_module_binding: "course_modedit_form", required_capability: "mod/wiki:viewpage",
        learner_identity: "never_returned", method: "mod_wiki_search_titles",
        native_route: "/mod/wiki/search.php", page_limit: 500, scope: "current_subwiki",
      },
    });

    const wikiPage = await invoke("moodle_get_wiki_page", { course_id: 2, module_id: 9, page_id: 51 });
    assert.equal(wikiPage.ok, true, JSON.stringify(wikiPage));
    assert.deepEqual(wikiPage.data, {
      schema: "morrow.moodle-wiki-page.v1", provider: "moodle", course_id: 2, module_id: 9, wiki_id: 31,
      activity_name: "Lab wiki", visible: true, page_id: 51, title: "Lab safety", version: 4,
      content_format: "html", content: "<p>Wear goggles.</p>",
      proof: {
        exact_module_binding: "course_modedit_form", required_capability: "mod/wiki:editpage",
        learner_identity: "never_returned", method: "mod_wiki_edit_form",
        native_route: "/mod/wiki/edit.php", editing_lock: "taken_for_30_seconds",
      },
    });
    assert.deepEqual(wikiPage.targets, [
      { field: "module_id", label: "Wiki", name: "Lab wiki" },
      { field: "page_id", label: "Page", name: "Lab safety" },
    ]);

    mark = dispatches();
    assert.deepEqual(
      await invoke("moodle_update_wiki_page", {
        course_id: 2, module_id: 9, page_id: 51, content: "<p>Wear goggles and a coat.</p>",
        expected_version: 3, expected_digest: wikiPage.snapshot_digest,
      }),
      { ok: false, sent: false, status: 200, error: "moodle_wiki_version_mismatch" },
    );
    assert.deepEqual(
      await invoke("moodle_update_wiki_page", {
        course_id: 2, module_id: 9, page_id: 51, content: '<p>See <a href="/pluginfile.php/1/mod_wiki/attachments/2/plan.pdf">the plan</a>.</p>',
        expected_version: 4, expected_digest: wikiPage.snapshot_digest,
      }),
      { ok: false, sent: false, status: 200, error: "moodle_wiki_content_refused" },
    );
    // A page another person is editing is refused before anything is sent.
    wikiLocked = true;
    assert.deepEqual(
      await invoke("moodle_get_wiki_page", { course_id: 2, module_id: 9, page_id: 51 }),
      { ok: false, sent: false, status: 200, error: "moodle_wiki_page_locked" },
    );
    assert.deepEqual(
      await invoke("moodle_update_wiki_page", {
        course_id: 2, module_id: 9, page_id: 51, content: "<p>Wear goggles and a coat.</p>",
        expected_version: 4, expected_digest: wikiPage.snapshot_digest,
      }),
      { ok: false, sent: false, status: 200, error: "moodle_wiki_page_locked" },
    );
    wikiLocked = false;
    assert.equal(dispatches(), mark, "no refused page write sent anything");

    const savedPage = await invoke("moodle_update_wiki_page", {
      course_id: 2, module_id: 9, page_id: 51, content: "<p>Wear goggles and a coat.</p>",
      expected_version: 4, expected_digest: wikiPage.snapshot_digest,
    });
    assert.equal(savedPage.ok, true, JSON.stringify(savedPage));
    assert.equal(dispatches(), mark + 1, "one page write sends exactly one POST");
    assert.equal(savedPage.data.version, 5);
    assert.equal(savedPage.data.previous_version, 4);
    assert.equal(savedPage.data.content, "<p>Wear goggles and a coat.</p>");
    assert.deepEqual(savedPage.verification, { schema: "morrow.browser-verification.v1", status: "verified" });
    assert.deepEqual(savedPage.data.proof, {
      exact_module_binding: "course_modedit_form", required_capability: "mod/wiki:editpage",
      learner_identity: "never_returned", method: "mod_wiki_edit_form", native_route: "/mod/wiki/edit.php",
      dispatch_count: 1, readback: "mod_wiki_edit_form", bound_version: 4,
      editing_lock: "taken_for_30_seconds", previous_version_kept_by: "moodle_page_history", learner_visible: true,
    });
    assert.equal(wikiPages.get("51").version, 5);

    // The reviewed version is spent once. The same approval cannot be replayed.
    mark = dispatches();
    assert.deepEqual(
      await invoke("moodle_update_wiki_page", {
        course_id: 2, module_id: 9, page_id: 51, content: "<p>Wear goggles and a coat.</p>",
        expected_version: 4, expected_digest: wikiPage.snapshot_digest,
      }),
      { ok: false, sent: false, status: 200, error: "moodle_wiki_expected_digest_mismatch" },
    );
    assert.equal(dispatches(), mark);

    // A lost response on a page write is applied_or_unknown too.
    writeResponse = "lost";
    const lostPageReview = await invoke("moodle_get_wiki_page", { course_id: 2, module_id: 9, page_id: 52 });
    mark = dispatches();
    const lostPage = await invoke("moodle_update_wiki_page", {
      course_id: 2, module_id: 9, page_id: 52, content: "<p>Three microscopes.</p>",
      expected_version: 2, expected_digest: lostPageReview.snapshot_digest,
    });
    assert.deepEqual(lostPage, {
      ok: false,
      sent: true,
      status: 500,
      outcomeUnknown: true,
      verification: { schema: "morrow.browser-verification.v1", status: "unconfirmed", reason: "moodle_wiki_write_unconfirmed" },
      error: "moodle_wiki_write_unconfirmed",
    });
    assert.equal(dispatches(), mark + 1);
    assert.equal(wikiPages.get("52").version, 3, "the fixture saved the page write whose response was lost");
    writeResponse = "redirect";

    // Morrow never opens a route that records a view, a completion state or a
    // Moodle view event.
    assert.deepEqual(
      requests.filter((request) => ["/mod/glossary/view.php", "/mod/glossary/showentry.php", "/mod/glossary/print.php", "/mod/wiki/view.php", "/mod/wiki/prettyview.php", "/mod/wiki/history.php", "/mod/wiki/map.php"].includes(request.pathname)),
      [],
    );
  } finally {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
});
