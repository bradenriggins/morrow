import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { executeMoodleH5pInPage } from "../../connector/extension/src/moodle-h5p-executor.js";

const SESSION = "synthetic-session";
const CRLF = Buffer.from([13, 10]);
const HEADER_END = Buffer.from([13, 10, 13, 10]);
const COURSE_ID = "2";
const SECTION_ID = "5";
const SECTION_NUMBER = "3";
const MODULE_ID = "77";
const CONTEXT_ID = "88";

const creationRead = { key: "moodle.form.course.modedit.h5pactivity.create.read.v1", toolName: "moodle_get_h5pactivity_creation_form", provider: "moodle", readOnly: true };
const activityRead = { key: "moodle.form.course.modedit.h5pactivity.read.v1", toolName: "moodle_get_h5pactivity", provider: "moodle", readOnly: true };
const create = { key: "moodle.form.course.modedit.h5pactivity.create.write.v1", toolName: "moodle_create_h5pactivity", provider: "moodle", readOnly: false };
const replace = { key: "moodle.form.course.modedit.h5pactivity.package.replace.write.v1", toolName: "moodle_replace_h5pactivity_package", provider: "moodle", readOnly: false };
const update = { key: "moodle.form.course.modedit.h5pactivity.write.v1", toolName: "moodle_update_h5pactivity", provider: "moodle", readOnly: false };

function zipArchive(entryName) {
  const name = Buffer.from(entryName, "utf8");
  const content = Buffer.from('{"title":"Reviewed activity"}', "utf8");
  const local = Buffer.alloc(30 + name.length + content.length);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4);
  local.writeUInt32LE(content.length, 18); local.writeUInt32LE(content.length, 22); local.writeUInt16LE(name.length, 26);
  name.copy(local, 30); content.copy(local, 30 + name.length);
  const central = Buffer.alloc(46 + name.length);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
  central.writeUInt32LE(content.length, 20); central.writeUInt32LE(content.length, 24); central.writeUInt16LE(name.length, 28);
  name.copy(central, 46);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length, 12); end.writeUInt32LE(local.length, 16);
  return Buffer.concat([local, central, end]);
}

function manifestOf(filename, bytes) {
  return { filename, size_bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}

function readBody(request) {
  return new Promise((resolve) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

function multipartFields(body, contentType) {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(String(contentType || ""));
  if (!boundary) return {};
  const separator = Buffer.from(`--${boundary[1] || boundary[2]}`, "latin1");
  const fields = {};
  let index = body.indexOf(separator);
  while (index >= 0) {
    const start = index + separator.length;
    const next = body.indexOf(separator, start);
    if (next < 0) break;
    const part = body.subarray(start + CRLF.length, next - CRLF.length);
    const headerEnd = part.indexOf(HEADER_END);
    if (headerEnd >= 0) {
      const headers = part.subarray(0, headerEnd).toString("latin1");
      const name = /name="([^"]+)"/.exec(headers)?.[1];
      const content = part.subarray(headerEnd + HEADER_END.length);
      if (name) fields[name] = headers.includes("filename=") ? content : content.toString("utf8");
    }
    index = next;
  }
  return fields;
}

function option(value, selected) {
  return `<option value="${value}"${value === selected ? " selected" : ""}>${value}</option>`;
}

function selectControl(name, selected, values) {
  return `<select name="${name}">${values.map((value) => option(value, selected)).join("")}</select>`;
}

function checkbox(name, checked) {
  return `<input type="checkbox" name="${name}" value="1"${checked ? " checked" : ""}>`;
}

function fileManagerScript(draftItem) {
  const manager = {
    target: "id_packagefile", itemid: draftItem, context: { id: Number(CONTEXT_ID) }, maxbytes: -1, maxfiles: 1, subdirs: 0,
    accepted_types: [".h5p"], filepicker: { repositories: { 17: { id: "17", type: "upload" } } }, author: "Morrow",
  };
  return `<script>M.form_filemanager.init(Y, ${JSON.stringify(manager)});</script>`;
}

function settingControls(state) {
  return `
      ${selectControl("enabletracking", state.enabletracking, ["0", "1"])}
      ${selectControl("grademethod", state.grademethod, ["1", "2", "3", "4", "5"])}
      ${selectControl("reviewmode", state.reviewmode, ["0", "1", "2"])}
      ${checkbox("displayopt[export]", state.display.export)}
      ${checkbox("displayopt[embed]", state.display.embed)}
      ${checkbox("displayopt[copyright]", state.display.copyright)}
      <input type="hidden" name="grade[modgrade_type]" value="point">
      <input type="hidden" name="grade[modgrade_point]" value="100">
      <input type="hidden" name="cmidnumber" value="">
      <input type="hidden" name="completion" value="1">`;
}

function contentBankNotice(options) {
  return options.contentBankReference
    ? `<div class="contentbank"><a href="/contentbank/view.php?id=41">Open in content bank</a></div>`
    : `<div class="contentbank"><a href="/contentbank/index.php?contextid=12">Use the content bank</a></div>`;
}

function creationForm(state, draftItem, options) {
  return `<!doctype html><html><body class="path-course course-${COURSE_ID}">
    <form method="post" action="/course/modedit.php">
      <input type="hidden" name="course" value="${COURSE_ID}"><input type="hidden" name="add" value="h5pactivity">
      <input type="hidden" name="modulename" value="h5pactivity"><input type="hidden" name="section" value="${SECTION_NUMBER}">
      <input type="hidden" name="return" value="0"><input type="hidden" name="sesskey" value="${SESSION}">
      <input type="hidden" name="_qf__mod_h5pactivity_mod_form" value="1"><input type="hidden" name="coursecontentnotification" value="1">
      <input name="name" value="">
      <textarea name="introeditor[text]"></textarea><input type="hidden" name="introeditor[format]" value="1"><input type="hidden" name="introeditor[itemid]" value="900">
      <div data-fieldtype="filemanager"><input type="hidden" id="id_packagefile" name="packagefile" value="${draftItem}"></div>
      ${contentBankNotice(options)}
      ${settingControls(state)}
      ${selectControl("visible", "1", ["0", "1"])}
      <input type="submit" name="submitbutton" value="Save and display">
      <input type="submit" name="submitbutton2" value="Save and return to course">
    </form>
    ${fileManagerScript(draftItem)}
  </body></html>`;
}

function activityForm(state, draftItem, options) {
  return `<!doctype html><html><body class="path-course course-${COURSE_ID}">
    <form method="post" action="/course/modedit.php?update=${MODULE_ID}&amp;return=0">
      <input type="hidden" name="update" value="${MODULE_ID}"><input type="hidden" name="course" value="${COURSE_ID}">
      <input type="hidden" name="modulename" value="h5pactivity"><input type="hidden" name="return" value="0">
      <input type="hidden" name="sesskey" value="${SESSION}"><input type="hidden" name="_qf__mod_h5pactivity_mod_form" value="1">
      <input type="hidden" name="coursecontentnotification" value="1">
      <input name="name" value="${state.name}">
      <textarea name="introeditor[text]">${state.instructions}</textarea><input type="hidden" name="introeditor[format]" value="1"><input type="hidden" name="introeditor[itemid]" value="901">
      <div data-fieldtype="filemanager"><input type="hidden" id="id_packagefile" name="packagefile" value="${draftItem}"></div>
      ${contentBankNotice(options)}
      ${settingControls(state)}
      ${selectControl("visible", state.visible ? "1" : "0", ["0", "1"])}
      <input type="hidden" name="groupmode" value="${state.groupmode}">
      <input type="submit" name="submitbutton" value="Save and display">
      <input type="submit" name="submitbutton2" value="Save and return to course">
    </form>
    ${fileManagerScript(draftItem)}
  </body></html>`;
}

function listing(file, reference) {
  return file
    ? {
      filecount: 1,
      list: [{ filename: file.filename, filepath: "/", type: "file", size: file.bytes.length, sortorder: 1, ...(reference ? { isref: true } : {}) }],
      tree: { children: [] },
    }
    : { filecount: 0, list: [], tree: { children: [] } };
}

test("Moodle H5P executor creates one hidden activity from a reviewed package and edits bounded settings without opening the player", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morrow-moodle-h5p-"));
  const key = join(directory, "key.pem");
  const certificate = join(directory, "certificate.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", certificate], { stdio: "ignore" });

  const packageBytes = zipArchive("h5p.json");
  const withoutDefinition = zipArchive("content/index.html");
  const reviewed = manifestOf("reviewed-activity.h5p", packageBytes);
  const unusable = manifestOf("broken-activity.h5p", withoutDefinition);

  const activity = {
    exists: false,
    name: "",
    instructions: "",
    enabletracking: "1",
    grademethod: "1",
    reviewmode: "1",
    display: { export: true, embed: false, copyright: false },
    visible: false,
    groupmode: "0",
    package: null,
  };
  const options = { contentBankReference: false, draftReference: false, saveUnknown: false, rejectSave: false, driftProtectedOnSave: false, keepName: "" };
  const drafts = new Map();
  const posts = [];
  const requests = [];
  let nextDraft = 100;
  let lastIssuedDraft = "";
  const staleDraftPosts = [];
  let origin = "";

  const courseState = () => JSON.stringify({
    course: { id: Number(COURSE_ID), fullname: "Health Sciences 101" },
    section: [{ id: Number(SECTION_ID), number: Number(SECTION_NUMBER), title: "Week three" }],
    cm: activity.exists
      ? [{ id: Number(MODULE_ID), module: "h5pactivity", name: activity.name, sectionid: Number(SECTION_ID), visible: activity.visible }]
      : [],
  });

  const server = createServer({ key: readFileSync(key), cert: readFileSync(certificate) }, async (request, response) => {
    const url = new URL(request.url || "/", origin || "https://127.0.0.1");
    requests.push(`${request.method} ${url.pathname}${url.search}`);
    if (url.pathname === "/course/view.php") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<!doctype html><html><body class="path-course course-${COURSE_ID}"><h1>Course</h1></body></html>`);
      return;
    }
    if (request.method === "POST" && url.pathname === "/lib/ajax/service.php") {
      assert.equal(url.searchParams.get("sesskey"), SESSION);
      assert.equal(url.searchParams.get("info"), "core_courseformat_get_state");
      response.writeHead(200, { "content-type": "application/json" });
      return response.end(JSON.stringify([{ index: 0, error: false, data: courseState() }]));
    }
    if (request.method === "GET" && url.pathname === "/course/modedit.php") {
      const item = String(nextDraft);
      nextDraft += 1;
      lastIssuedDraft = item;
      response.writeHead(200, { "content-type": "text/html" });
      if (url.search === `?add=h5pactivity&course=${COURSE_ID}&sectionid=${SECTION_ID}&return=0`) {
        drafts.set(item, options.contentBankReference && activity.package ? { ...activity.package, reference: true } : null);
        return response.end(creationForm(activity, item, options));
      }
      if (url.search === `?update=${MODULE_ID}&return=0` && activity.exists) {
        drafts.set(item, activity.package ? { ...activity.package, reference: options.draftReference } : null);
        return response.end(activityForm(activity, item, options));
      }
      return response.writeHead(404).end();
    }
    if (request.method === "POST" && url.pathname === "/repository/draftfiles_ajax.php") {
      const values = new URLSearchParams((await readBody(request)).toString("utf8"));
      assert.equal(values.get("sesskey"), SESSION);
      const itemId = values.get("itemid") || "";
      const draft = drafts.get(itemId) || null;
      response.setHeader("content-type", "application/json");
      if (url.searchParams.get("action") === "delete") {
        if (!draft || values.get("filepath") !== "/" || values.get("filename") !== draft.filename) return response.end(JSON.stringify({ error: "refused" }));
        drafts.set(itemId, null);
        return response.end(JSON.stringify({ filepath: "/" }));
      }
      return response.end(JSON.stringify(listing(draft, Boolean(draft?.reference))));
    }
    if (request.method === "POST" && url.pathname === "/repository/repository_ajax.php") {
      const fields = multipartFields(await readBody(request), request.headers["content-type"]);
      const item = String(fields.itemid || "");
      const uploaded = fields.repo_upload_file;
      response.setHeader("content-type", "application/json");
      if (!Buffer.isBuffer(uploaded) || drafts.get(item)) return response.end(JSON.stringify({ error: "refused" }));
      assert.equal(fields["accepted_types[]"], ".h5p");
      drafts.set(item, { filename: String(fields.title || ""), bytes: uploaded });
      return response.end(JSON.stringify({ id: Number(item), file: String(fields.title || ""), url: `${origin}/draftfile.php/3/user/draft/${item}/${fields.title}` }));
    }
    if (request.method === "GET" && url.pathname.startsWith("/draftfile.php/")) {
      const draft = drafts.get(url.pathname.split("/")[5]);
      if (!draft) return response.writeHead(404).end();
      response.writeHead(200, { "content-length": draft.bytes.length });
      return response.end(draft.bytes);
    }
    if (request.method === "GET" && activity.package
      && url.pathname === `/pluginfile.php/${CONTEXT_ID}/mod_h5pactivity/package/0/${activity.package.filename}`) {
      response.writeHead(200, { "content-length": activity.package.bytes.length });
      return response.end(activity.package.bytes);
    }
    if (request.method === "POST" && url.pathname === "/course/modedit.php") {
      const values = new URLSearchParams((await readBody(request)).toString("utf8"));
      posts.push(values);
      if (values.get("packagefile") !== lastIssuedDraft) staleDraftPosts.push(values.get("packagefile"));
      if (options.saveUnknown) return response.writeHead(500).end("unknown");
      if (options.rejectSave) {
        response.writeHead(200, { "content-type": "text/html" });
        return response.end(activity.exists ? activityForm(activity, lastIssuedDraft, options) : creationForm(activity, lastIssuedDraft, options));
      }
      activity.exists = true;
      activity.name = options.keepName || values.get("name") || "";
      activity.instructions = values.get("introeditor[text]") || "";
      for (const field of ["enabletracking", "grademethod", "reviewmode"]) activity[field] = values.get(field) || "0";
      activity.display = {
        export: values.get("displayopt[export]") === "1",
        embed: values.get("displayopt[embed]") === "1",
        copyright: values.get("displayopt[copyright]") === "1",
      };
      activity.visible = values.get("visible") === "1";
      if (options.driftProtectedOnSave) activity.groupmode = "1";
      const saved = drafts.get(values.get("packagefile") || "");
      if (saved) activity.package = { filename: saved.filename, bytes: saved.bytes };
      response.writeHead(303, { location: `/course/view.php?id=${COURSE_ID}` });
      return response.end();
    }
    response.writeHead(404).end();
  });

  let browser;
  let context;
  try {
    await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", (error) => error ? reject(error) : resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("H5P test server did not bind");
    origin = `https://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
    context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    await page.goto(`${origin}/course/view.php?id=${COURSE_ID}`);
    await page.evaluate((wwwroot) => { globalThis.M = { cfg: { wwwroot, sesskey: "synthetic-session", userId: 3, courseId: 2 } }; }, origin);
    const binding = { origin, siteUrl: `${origin}/`, principalId: "3", courseId: COURSE_ID };
    const base = { mode: "execute", binding, expiresAt: Date.now() + 60_000 };
    const run = (operation, argumentsValue, privateAttachment) => page.evaluate(
      executeMoodleH5pInPage,
      JSON.stringify({ ...base, operation, arguments: argumentsValue, ...(privateAttachment ? { privateAttachment } : {}) }),
    );
    const attachment = (handle, manifest, bytes) => ({ schema: "morrow.private-file-attachment.v1", handle, manifest, bytes_base64: bytes.toString("base64") });
    const playerRoutes = () => requests.filter((entry) => /\/(?:mod\/h5pactivity\/(?:view|report)|h5p\/embed)\.php/.test(entry));
    const uploads = () => requests.filter((entry) => entry.startsWith("POST /repository/repository_ajax.php")).length;
    const creationArguments = { course_id: 2, section_id: 5 };

    // The creation form read is the digest source for the create.
    const prepared = await run(creationRead, creationArguments);
    assert.equal(prepared.ok, true, JSON.stringify(prepared));
    assert.equal(prepared.data.schema, "morrow.moodle-h5pactivity-creation-form.v1");
    assert.equal(prepared.data.section_number, 3);
    assert.equal(prepared.data.package_area_empty, true);
    assert.equal(prepared.data.max_package_bytes, 1024 * 1024);
    assert.equal(prepared.data.accepted_type, ".h5p");
    assert.equal(prepared.data.enable_tracking, "1");
    assert.equal(prepared.data.display_export, true);
    assert.equal(prepared.data.display_embed, false);
    assert.equal(prepared.data.proof.required_capability, "moodle/course:manageactivities");
    assert.equal(prepared.data.proof.content_bank_selection, "out_of_scope_refused");
    assert.deepEqual(prepared.targets, [
      { field: "course_id", label: "Course", name: "Health Sciences 101" },
      { field: "section_id", label: "Section", name: "Week three" },
    ]);
    assert.equal(JSON.stringify(prepared).includes(SESSION), false);
    assert.equal(posts.length, 0);
    assert.equal(uploads(), 0);

    // A stale digest never reaches an upload or a save.
    assert.deepEqual(
      await run(create, { ...creationArguments, name: "Must not save", ...reviewed, expected_digest: "0".repeat(64) }, attachment("file:h5p-stale", reviewed, packageBytes)),
      { ok: false, sent: false, status: 200, error: "moodle_expected_digest_mismatch" },
    );
    assert.equal(posts.length, 0);
    assert.equal(uploads(), 0);

    // A package that is not a ZIP with one root h5p.json is refused before the upload.
    assert.deepEqual(
      await run(create, { ...creationArguments, name: "Must not save", ...unusable, expected_digest: prepared.snapshot_digest }, attachment("file:h5p-unusable", unusable, withoutDefinition)),
      { ok: false, sent: false, status: 200, error: "moodle_h5pactivity_package_definition_invalid" },
    );
    assert.equal(posts.length, 0);
    assert.equal(uploads(), 0);

    // Bytes that disagree with the reviewed manifest never reach the draft area.
    assert.deepEqual(
      await run(create, { ...creationArguments, name: "Must not save", ...reviewed, expected_digest: prepared.snapshot_digest }, attachment("file:h5p-mismatch", reviewed, withoutDefinition)),
      { ok: false, sent: false, status: 200, error: "moodle_h5pactivity_package_attachment_invalid" },
    );
    assert.equal(posts.length, 0);
    assert.equal(uploads(), 0);

    // Content bank selection is out of scope. A form that links the exact
    // content-bank content refuses before the upload and before the save.
    options.contentBankReference = true;
    assert.deepEqual(await run(creationRead, creationArguments), { ok: false, sent: false, status: 200, error: "moodle_h5pactivity_content_bank_source_refused" });
    assert.deepEqual(
      await run(create, { ...creationArguments, name: "Content bank", ...reviewed, expected_digest: prepared.snapshot_digest }, attachment("file:h5p-bank", reviewed, packageBytes)),
      { ok: false, sent: false, status: 200, error: "moodle_h5pactivity_content_bank_source_refused" },
    );
    options.contentBankReference = false;
    assert.equal(posts.length, 0);
    assert.equal(uploads(), 0);

    // The create itself: one POST, hidden activity, saved bytes read back from
    // the module's own package area.
    const fresh = await run(creationRead, creationArguments);
    assert.equal(fresh.ok, true, JSON.stringify(fresh));
    const created = await run(create, { ...creationArguments, name: "Reviewed H5P activity", ...reviewed, expected_digest: fresh.snapshot_digest }, attachment("file:h5p-1", reviewed, packageBytes));
    assert.equal(created.ok, true, JSON.stringify(created));
    assert.deepEqual(created.verification, { schema: "morrow.browser-verification.v1", status: "verified" });
    assert.equal(posts.length, 1);
    assert.equal(uploads(), 1);
    assert.equal(posts[0].get("name"), "Reviewed H5P activity");
    assert.equal(posts[0].get("visible"), "0");
    assert.equal(posts[0].get("add"), "h5pactivity");
    assert.equal(posts[0].get("section"), SECTION_NUMBER);
    assert.equal(posts[0].get("submitbutton2"), "Save and return to course");
    assert.equal(posts[0].get("submitbutton"), null);
    assert.equal(posts[0].get("coursecontentnotification"), null);
    assert.equal(created.data.module_id, Number(MODULE_ID));
    assert.equal(created.data.section_id, Number(SECTION_ID));
    assert.equal(created.data.visible, false);
    assert.equal(created.data.created, true);
    assert.deepEqual(created.data.package, reviewed);
    assert.equal(createHash("sha256").update(activity.package.bytes).digest("hex"), reviewed.sha256);
    assert.ok(requests.includes(`GET /pluginfile.php/${CONTEXT_ID}/mod_h5pactivity/package/0/${reviewed.filename}?forcedownload=1`));
    assert.equal(JSON.stringify(created).includes(SESSION), false);
    assert.deepEqual(playerRoutes(), []);

    // The settings read of the saved activity is the digest source for the update.
    const saved = await run(activityRead, { course_id: 2, module_id: 77 });
    assert.equal(saved.ok, true, JSON.stringify(saved));
    assert.equal(saved.data.schema, "morrow.moodle-h5pactivity.v1");
    assert.equal(saved.data.name, "Reviewed H5P activity");
    assert.equal(saved.data.review_mode, "1");
    assert.deepEqual(saved.data.package, { filename: reviewed.filename, size_bytes: reviewed.size_bytes });
    assert.deepEqual(saved.targets, [
      { field: "course_id", label: "Course", name: "Health Sciences 101" },
      { field: "module_id", label: "H5P activity", name: "Reviewed H5P activity" },
    ]);

    // A value the native control does not offer is refused before anything is sent.
    assert.deepEqual(await run(update, { course_id: 2, module_id: 77, review_mode: "9", expected_digest: saved.snapshot_digest }),
      { ok: false, sent: false, status: 200, error: "moodle_h5pactivity_setting_not_writable" });
    assert.equal(posts.length, 1);

    // An update that names no bounded setting, and one that carries a package, are refused.
    assert.deepEqual(await run(update, { course_id: 2, module_id: 77, expected_digest: saved.snapshot_digest }),
      { ok: false, sent: false, error: "moodle_h5pactivity_arguments_invalid" });
    assert.deepEqual(await run(update, { course_id: 2, module_id: 77, name: "Attachment refused", expected_digest: saved.snapshot_digest }, attachment("file:h5p-refused", reviewed, packageBytes)),
      { ok: false, sent: false, error: "moodle_h5pactivity_arguments_invalid" });
    assert.equal(posts.length, 1);

    // The bounded update: one POST, every other native control unchanged.
    const updated = await run(update, {
      course_id: 2, module_id: 77, name: "Reviewed H5P activity, week three", instructions: "<p>Work through every slide.</p>",
      review_mode: "2", grade_method: "3", display_export: false, display_embed: true, expected_digest: saved.snapshot_digest,
    });
    assert.equal(updated.ok, true, JSON.stringify(updated));
    assert.equal(updated.verification.status, "verified");
    assert.equal(posts.length, 2);
    assert.equal(posts[1].get("name"), "Reviewed H5P activity, week three");
    assert.equal(posts[1].get("introeditor[text]"), "<p>Work through every slide.</p>");
    assert.equal(posts[1].get("reviewmode"), "2");
    assert.equal(posts[1].get("grademethod"), "3");
    assert.equal(posts[1].get("displayopt[export]"), null);
    assert.equal(posts[1].get("displayopt[embed]"), "1");
    assert.equal(posts[1].get("enabletracking"), "1");
    assert.equal(posts[1].get("visible"), "0");
    assert.equal(posts[1].get("groupmode"), "0");
    assert.equal(posts[1].get("grade[modgrade_point]"), "100");
    assert.equal(updated.data.name, "Reviewed H5P activity, week three");
    assert.equal(updated.data.review_mode, "2");
    assert.equal(updated.data.display_export, false);
    assert.equal(updated.data.display_embed, true);
    assert.equal(updated.data.display_copyright, false);
    assert.deepEqual(updated.data.package, { filename: reviewed.filename, size_bytes: reviewed.size_bytes });
    assert.ok(Array.isArray(updated.data.protected_setting_names));
    assert.ok(updated.data.protected_setting_names.includes("groupmode"));
    assert.equal(updated.data.protected_setting_names.includes("name"), false);
    assert.equal(JSON.stringify(updated).includes(SESSION), false);
    assert.equal(uploads(), 1);
    assert.deepEqual(playerRoutes(), []);

    // A protected control the site changes during the save is reported, not hidden.
    const beforeDrift = await run(activityRead, { course_id: 2, module_id: 77 });
    options.driftProtectedOnSave = true;
    const drifted = await run(update, { course_id: 2, module_id: 77, name: "Drifted H5P activity", expected_digest: beforeDrift.snapshot_digest });
    options.driftProtectedOnSave = false;
    activity.groupmode = "0";
    assert.equal(drifted.ok, false, JSON.stringify(drifted));
    assert.equal(drifted.error, "moodle_write_not_verified");
    assert.deepEqual(drifted.verification, { schema: "morrow.browser-verification.v1", status: "mismatch", reason: "moodle_h5pactivity_readback_mismatch" });
    assert.equal(posts.length, 3);

    // A name the site keeps instead of the requested one is a mismatch, not a success.
    const beforeKeep = await run(activityRead, { course_id: 2, module_id: 77 });
    options.keepName = "Name the site kept";
    const kept = await run(update, { course_id: 2, module_id: 77, name: "Requested name", expected_digest: beforeKeep.snapshot_digest });
    options.keepName = "";
    assert.equal(kept.ok, false, JSON.stringify(kept));
    assert.equal(kept.error, "moodle_write_not_verified");
    assert.equal(posts.length, 4);

    // A content-bank reference in the saved package area refuses the settings read
    // and the update, whether the form links the exact content-bank content or the
    // native draft listing marks the package file as a reference.
    const postsBeforeBank = posts.length;
    options.contentBankReference = true;
    assert.deepEqual(await run(activityRead, { course_id: 2, module_id: 77 }),
      { ok: false, sent: false, status: 200, error: "moodle_h5pactivity_content_bank_source_refused" });
    options.contentBankReference = false;
    options.draftReference = true;
    assert.deepEqual(await run(activityRead, { course_id: 2, module_id: 77 }),
      { ok: false, sent: false, status: 200, error: "moodle_h5pactivity_content_bank_source_refused" });
    assert.deepEqual(await run(update, { course_id: 2, module_id: 77, name: "Content bank package", expected_digest: "0".repeat(64) }),
      { ok: false, sent: false, status: 200, error: "moodle_h5pactivity_content_bank_source_refused" });
    options.draftReference = false;
    assert.equal(posts.length, postsBeforeBank);

    // A native form redisplay is a refusal that saved nothing, not an unknown outcome.
    const beforeReject = await run(activityRead, { course_id: 2, module_id: 77 });
    options.rejectSave = true;
    const rejected = await run(update, { course_id: 2, module_id: 77, name: "Rejected by Moodle", expected_digest: beforeReject.snapshot_digest });
    options.rejectSave = false;
    assert.deepEqual(rejected, {
      ok: false,
      sent: true,
      status: 200,
      verification: { schema: "morrow.browser-verification.v1", status: "mismatch", reason: "moodle_h5pactivity_save_not_sent" },
      error: "moodle_h5pactivity_save_not_sent",
    });
    assert.equal(activity.name, "Name the site kept");
    assert.equal(posts.length, 5);

    // A lost save response is applied-or-unknown, never a retryable failure.
    const beforeUnknown = await run(activityRead, { course_id: 2, module_id: 77 });
    options.saveUnknown = true;
    const unknown = await run(update, { course_id: 2, module_id: 77, name: "Uncertain H5P activity", expected_digest: beforeUnknown.snapshot_digest });
    options.saveUnknown = false;
    assert.equal(unknown.ok, false, JSON.stringify(unknown));
    assert.equal(unknown.sent, true);
    assert.equal(unknown.outcomeUnknown, true);
    assert.equal(unknown.error, "moodle_h5pactivity_save_unknown");
    assert.equal(unknown.verification.status, "unconfirmed");
    assert.equal(posts.length, 6);

    // The package replacement holds the same hidden activity boundary. It
    // rejects stale or malformed reviewed packages before it changes the draft
    // area, then sends exactly one POST and reads the saved package bytes.
    const replacementBytes = zipArchive("h5p.json");
    const replacement = manifestOf("reviewed-replacement.h5p", replacementBytes);
    const postsBeforeReplacement = posts.length;
    const uploadsBeforeReplacement = uploads();
    const replacementRead = await run(activityRead, { course_id: 2, module_id: 77 });
    assert.deepEqual(
      await run(replace, { course_id: 2, module_id: 77, ...replacement, expected_digest: "0".repeat(64) }, attachment("file:h5p-replacement-stale", replacement, replacementBytes)),
      { ok: false, sent: false, status: 200, error: "moodle_expected_digest_mismatch" },
    );
    assert.deepEqual(
      await run(replace, { course_id: 2, module_id: 77, ...unusable, expected_digest: replacementRead.snapshot_digest }, attachment("file:h5p-replacement-invalid", unusable, withoutDefinition)),
      { ok: false, sent: false, status: 200, error: "moodle_h5pactivity_package_definition_invalid" },
    );
    assert.equal(posts.length, postsBeforeReplacement);
    assert.equal(uploads(), uploadsBeforeReplacement);
    const replaced = await run(replace, {
      course_id: 2, module_id: 77, ...replacement, expected_digest: replacementRead.snapshot_digest,
    }, attachment("file:h5p-replacement", replacement, replacementBytes));
    assert.equal(replaced.ok, true, JSON.stringify(replaced));
    assert.deepEqual(replaced.verification, { schema: "morrow.browser-verification.v1", status: "verified" });
    assert.equal(posts.length, postsBeforeReplacement + 1);
    assert.equal(uploads(), uploadsBeforeReplacement + 1);
    assert.match(posts.at(-1).get("packagefile") || "", /^\d+$/);
    assert.equal(posts.at(-1).get("visible"), "0");
    assert.deepEqual(replaced.data.package, replacement);
    assert.deepEqual(activity.package, { filename: replacement.filename, bytes: replacementBytes });
    assert.ok(requests.includes(`GET /pluginfile.php/${CONTEXT_ID}/mod_h5pactivity/package/0/${replacement.filename}?forcedownload=1`));
    assert.equal(replaced.data.protected_setting_names.includes("packagefile"), false);

    activity.visible = true;
    const beforeVisibleReplacement = await run(activityRead, { course_id: 2, module_id: 77 });
    assert.deepEqual(
      await run(replace, { course_id: 2, module_id: 77, ...replacement, expected_digest: beforeVisibleReplacement.snapshot_digest }, attachment("file:h5p-replacement-visible", replacement, replacementBytes)),
      { ok: false, sent: false, status: 200, error: "moodle_h5pactivity_activity_visible_refused" },
    );
    activity.visible = false;

    // Nothing in this fixture opened the activity view, a report, or the H5P player,
    // and every POST carried the draft area of the form reloaded immediately before it.
    assert.deepEqual(playerRoutes(), []);
    assert.deepEqual(staleDraftPosts, []);
  } finally {
    await context?.close();
    await browser?.close();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the Moodle H5P catalog, worker, and documentation state the same bounded route", () => {
  const root = new URL("../..", import.meta.url);
  const catalog = JSON.parse(readFileSync(new URL("connector/extension/generated/moodle-browser-catalog.json", root), "utf8"));
  const entries = catalog.operations.filter((entry) => entry.toolName.includes("h5pactivity"));
  assert.deepEqual(entries.map((entry) => entry.key).sort(), [
    "moodle.form.course.modedit.h5pactivity.create.read.v1",
    "moodle.form.course.modedit.h5pactivity.create.write.v1",
    "moodle.form.course.modedit.h5pactivity.package.replace.write.v1",
    "moodle.form.course.modedit.h5pactivity.read.v1",
    "moodle.form.course.modedit.h5pactivity.write.v1",
  ]);
  for (const entry of entries) {
    assert.ok(entry.description.includes("never opens the activity view, an attempt report, or the H5P player"), `${entry.toolName} must state the route limit`);
    assert.ok(entry.description.includes("content bank"), `${entry.toolName} must state the content-bank boundary`);
  }
  const writes = entries.filter((entry) => entry.readOnly !== true);
  assert.deepEqual(writes.map((entry) => entry.toolName).sort(), ["moodle_create_h5pactivity", "moodle_replace_h5pactivity_package", "moodle_update_h5pactivity"]);
  for (const entry of writes) {
    assert.ok(["moodle_get_h5pactivity", "moodle_get_h5pactivity_creation_form"].includes(entry.reviewTool), `${entry.toolName} needs a review tool`);
    assert.ok(entry.description.includes("no signed-in Moodle site has run it"), `${entry.toolName} must state the evidence limit`);
  }
  const creation = writes.find((entry) => entry.toolName === "moodle_create_h5pactivity");
  assert.equal(creation.inputSchema.properties.size_bytes.maximum, 1024 * 1024);
  const filename = new RegExp(creation.inputSchema.properties.filename.pattern);
  assert.equal(filename.test("reviewed-activity.h5p"), true, "the create must accept a .h5p package");
  assert.equal(filename.test("reviewed-activity.zip"), false, "the create must accept only a .h5p package");
  assert.ok(creation.description.includes("Byte equality does not establish H5P validity or learner access"));
  const replacement = writes.find((entry) => entry.toolName === "moodle_replace_h5pactivity_package");
  assert.equal(replacement.reviewTool, "moodle_get_h5pactivity");
  assert.equal(replacement.destructive, true);
  assert.equal(replacement.irreversible, true);
  assert.ok(replacement.description.includes("one root h5p.json"));
  assert.ok(replacement.description.includes("refuses an activity that is visible to learners"));

  const worker = readFileSync(new URL("connector/extension/src/service-worker.js", root), "utf8");
  assert.match(worker, /import \{ executeMoodleH5pInPage \} from "\.\/moodle-h5p-executor\.js";/);
  for (const entry of entries) assert.match(worker, new RegExp(`"${entry.key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
  assert.match(worker, /toolName: "moodle_create_h5pactivity", key: "moodle\.form\.course\.modedit\.h5pactivity\.create\.write\.v1"/);
  assert.match(worker, /toolName: "moodle_replace_h5pactivity_package", key: "moodle\.form\.course\.modedit\.h5pactivity\.package\.replace\.write\.v1"/);

  const documentation = readFileSync(new URL("docs/implementation/MOODLE-FULL-FUNCTIONALITY.md", root), "utf8");
  assert.ok(documentation.includes("moodle_create_h5pactivity"), "the H5P row must name the create operation");
  assert.ok(documentation.includes("moodle_replace_h5pactivity_package"), "the H5P row must name the package replacement operation");
  assert.ok(documentation.includes("morrow_plan_moodle_h5p_package_replacement"), "the H5P row must name the replacement planner");
  assert.ok(documentation.includes("Content bank selection is out of scope"), "the H5P row must record the content-bank gap");
});
