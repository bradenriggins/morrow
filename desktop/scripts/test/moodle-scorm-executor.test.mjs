import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { executeMoodleInPage } from "../../connector/extension/src/moodle-executor.js";
import { executeMoodleScormInPage } from "../../connector/extension/src/moodle-scorm-executor.js";

const SESSION = "synthetic-session";
const CRLF = Buffer.from([13, 10]);
const HEADER_END = Buffer.from([13, 10, 13, 10]);

const scormRead = { key: "moodle.form.course.modedit.scorm.read.v1", toolName: "moodle_get_scorm", provider: "moodle", readOnly: true };
const scormUpdate = { key: "moodle.form.course.modedit.scorm.write.v1", toolName: "moodle_update_scorm", provider: "moodle", readOnly: false };
const scormReplace = { key: "moodle.form.course.modedit.scorm.package.replace.write.v1", toolName: "moodle_replace_scorm_package", provider: "moodle", readOnly: false };

function zipPackage(entryName) {
  const name = Buffer.from(entryName, "utf8");
  const content = Buffer.from("<manifest/>", "utf8");
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

function dateControls(field, value) {
  const parts = ["year", "month", "day", "hour", "minute"];
  const toggle = `<input type="checkbox" name="${field}[enabled]" value="1"${value ? " checked" : ""}>`;
  const defaults = { year: "2026", month: "9", day: "6", hour: "8", minute: "20" };
  const selects = parts.map((part) => {
    const current = String((value || defaults)[part]);
    return selectControl(`${field}[${part}]`, current, [current]);
  }).join("");
  return `${toggle}${selects}`;
}

function scormForm(state, draftItem) {
  const manager = {
    target: "id_packagefile", itemid: draftItem, context: { id: 88 }, maxbytes: -1, areamaxbytes: -1,
    maxfiles: 1, subdirs: 0, accepted_types: [".zip", ".xml"], filepicker: { repositories: { 17: { id: "17", type: "upload" } } }, author: "Morrow",
  };
  return `<!doctype html><html><body class="path-course course-2">
    <form method="post" action="/course/modedit.php?update=99&amp;return=0">
      <input type="hidden" name="update" value="99"><input type="hidden" name="course" value="2"><input type="hidden" name="modulename" value="scorm">
      <input type="hidden" name="return" value="0"><input type="hidden" name="sesskey" value="${SESSION}"><input type="hidden" name="_qf__mod_scorm_mod_form" value="1">
      <input type="hidden" name="coursecontentnotification" value="1">
      <input name="name" value="${state.name}">
      <textarea name="introeditor[text]">${state.instructions}</textarea><input type="hidden" name="introeditor[format]" value="1"><input type="hidden" name="introeditor[itemid]" value="777">
      ${selectControl("scormtype", state.scormtype, ["local", "external"])}
      ${selectControl("updatefreq", state.updatefreq, ["0", "1", "2"])}
      ${selectControl("popup", state.popup, ["0", "1"])}
      ${selectControl("skipview", state.skipview, ["0", "1", "2"])}
      ${selectControl("displaycoursestructure", state.displaycoursestructure, ["0", "1"])}
      ${selectControl("hidebrowse", state.hidebrowse, ["0", "1"])}
      ${selectControl("maxattempt", state.maxattempt, ["0", "1", "2", "3", "4", "5", "6"])}
      ${selectControl("whatgrade", state.whatgrade, ["0", "1", "2", "3"])}
      ${selectControl("grademethod", state.grademethod, ["0", "1", "2", "3", "4"])}
      ${dateControls("timeopen", state.timeopen)}${dateControls("timeclose", state.timeclose)}
      ${selectControl("visible", state.visible ? "1" : "0", ["0", "1"])}
      <input type="hidden" name="grade" value="${state.grade}"><input type="hidden" name="forcenewattempt" value="0"><input type="hidden" name="lastattemptlock" value="0">
      <input type="hidden" name="width" value="100"><input type="hidden" name="height" value="500"><input type="hidden" name="cmidnumber" value="">
      <div data-fieldtype="filemanager"><input type="hidden" id="id_packagefile" name="packagefile" value="${draftItem}"></div>
      <input type="submit" name="submitbutton" value="Save and display">
      <input type="submit" name="submitbutton2" value="Save changes and return to course">
    </form>
    <script>M.form_filemanager.init(Y, ${JSON.stringify(manager)});</script>
  </body></html>`;
}

function listing(file) {
  return file
    ? { filecount: 1, list: [{ filename: file.filename, filepath: "/", type: "zip", size: file.bytes.length, sortorder: 1, mimetype: "application/zip" }], tree: { children: [] } }
    : { filecount: 0, list: [], tree: { children: [] } };
}

test("Moodle SCORM executor edits bounded settings and replaces one package without launching it", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morrow-moodle-scorm-"));
  const key = join(directory, "key.pem");
  const certificate = join(directory, "certificate.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", certificate], { stdio: "ignore" });

  const firstBytes = zipPackage("imsmanifest.xml");
  const secondBytes = Buffer.concat([zipPackage("imsmanifest.xml"), Buffer.alloc(0)]);
  const withoutManifest = zipPackage("index.html");
  const first = manifestOf("course.zip", firstBytes);
  const second = manifestOf("updated-course.zip", secondBytes);
  const unusable = manifestOf("broken.zip", withoutManifest);

  const state = {
    name: "SCORM package", instructions: "<p>Original</p>", scormtype: "local", updatefreq: "0",
    popup: "0", skipview: "1", displaycoursestructure: "1", hidebrowse: "0", maxattempt: "0", whatgrade: "0", grademethod: "0",
    timeopen: null, timeclose: null, visible: false, grade: "100",
    package: { filename: first.filename, bytes: firstBytes },
  };
  const options = { saveUnknown: false, rejectSave: false, driftProtectedOnSave: false, keepName: "" };
  const drafts = new Map([["777", null]]);
  const posts = [];
  const requests = [];
  let nextDraft = 100;
  let lastIssuedDraft = "";
  const staleDraftPosts = [];
  let origin = "";

  const server = createServer({ key: readFileSync(key), cert: readFileSync(certificate) }, async (request, response) => {
    const url = new URL(request.url || "/", origin || "https://127.0.0.1");
    requests.push(`${request.method} ${url.pathname}${url.search}`);
    if (url.pathname === "/course/view.php") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end('<!doctype html><html><body class="path-course course-2"><h1>SCORM course</h1></body></html>');
      return;
    }
    if (request.method === "GET" && url.pathname === "/course/modedit.php" && url.search === "?update=99&return=0") {
      const item = String(nextDraft);
      nextDraft += 1;
      drafts.set(item, { filename: state.package.filename, bytes: state.package.bytes });
      lastIssuedDraft = item;
      response.writeHead(200, { "content-type": "text/html" });
      response.end(scormForm(state, item));
      return;
    }
    if (request.method === "POST" && url.pathname === "/repository/draftfiles_ajax.php") {
      const values = new URLSearchParams((await readBody(request)).toString("utf8"));
      assert.equal(values.get("sesskey"), SESSION);
      const item = values.get("itemid") || "";
      response.setHeader("content-type", "application/json");
      if (url.searchParams.get("action") === "delete") {
        const current = drafts.get(item);
        if (!current || current.filename !== values.get("filename") || values.get("filepath") !== "/") return response.end("false");
        drafts.set(item, null);
        return response.end(JSON.stringify({ filepath: "/" }));
      }
      return response.end(JSON.stringify(listing(drafts.get(item) || null)));
    }
    if (request.method === "POST" && url.pathname === "/repository/repository_ajax.php") {
      const fields = multipartFields(await readBody(request), request.headers["content-type"]);
      const item = String(fields.itemid || "");
      const uploaded = fields.repo_upload_file;
      response.setHeader("content-type", "application/json");
      if (!Buffer.isBuffer(uploaded) || drafts.get(item)) return response.end(JSON.stringify({ error: "refused" }));
      drafts.set(item, { filename: String(fields.title || ""), bytes: uploaded });
      return response.end(JSON.stringify({ id: Number(item), file: String(fields.title || ""), url: `${origin}/draftfile.php/3/user/draft/${item}/${fields.title}` }));
    }
    if (request.method === "GET" && url.pathname.startsWith("/draftfile.php/")) {
      const draft = drafts.get(url.pathname.split("/")[5]);
      if (!draft) return response.writeHead(404).end();
      response.writeHead(200, { "content-length": draft.bytes.length });
      return response.end(draft.bytes);
    }
    if (request.method === "GET" && url.pathname === `/pluginfile.php/88/mod_scorm/package/${state.package.filename}`) {
      response.writeHead(200, { "content-length": state.package.bytes.length });
      return response.end(state.package.bytes);
    }
    if (request.method === "POST" && url.pathname === "/course/modedit.php") {
      const values = new URLSearchParams((await readBody(request)).toString("utf8"));
      posts.push(values);
      if (values.get("packagefile") !== lastIssuedDraft) staleDraftPosts.push(values.get("packagefile"));
      if (options.saveUnknown) return response.writeHead(500).end("unknown");
      if (options.rejectSave) {
        response.writeHead(200, { "content-type": "text/html" });
        return response.end(scormForm(state, lastIssuedDraft));
      }
      state.name = options.keepName || values.get("name") || "";
      state.instructions = values.get("introeditor[text]") || "";
      for (const field of ["popup", "skipview", "displaycoursestructure", "hidebrowse", "maxattempt", "whatgrade", "grademethod"]) {
        state[field] = values.get(field) || "0";
      }
      for (const field of ["timeopen", "timeclose"]) {
        state[field] = values.get(`${field}[enabled]`) === "1"
          ? Object.fromEntries(["year", "month", "day", "hour", "minute"].map((part) => [part, values.get(`${field}[${part}]`) || ""]))
          : null;
      }
      if (options.driftProtectedOnSave) state.grade = "90";
      const saved = drafts.get(values.get("packagefile") || "");
      if (saved) state.package = { filename: saved.filename, bytes: saved.bytes };
      response.writeHead(303, { location: "/course/view.php?id=2" });
      return response.end();
    }
    response.writeHead(404).end();
  });

  let browser;
  let context;
  try {
    await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", (error) => error ? reject(error) : resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("SCORM test server did not bind");
    origin = `https://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
    context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    await page.goto(`${origin}/course/view.php?id=2`);
    await page.evaluate((wwwroot) => { globalThis.M = { cfg: { wwwroot, sesskey: "synthetic-session", userId: 3, courseId: 2 } }; }, origin);
    const binding = { origin, siteUrl: `${origin}/`, principalId: "3", courseId: "2" };
    const base = { mode: "execute", binding, expiresAt: Date.now() + 60_000 };
    const read = () => page.evaluate(executeMoodleInPage, JSON.stringify({ ...base, operation: scormRead, arguments: { course_id: 2, module_id: 99 } }));
    const run = (operation, argumentsValue, privateAttachment) => page.evaluate(
      executeMoodleScormInPage,
      JSON.stringify({ ...base, operation, arguments: argumentsValue, ...(privateAttachment ? { privateAttachment } : {}) }),
    );
    const attachment = (handle, manifest, bytes) => ({ schema: "morrow.private-file-attachment.v1", handle, manifest, bytes_base64: bytes.toString("base64") });
    const scormRoutes = () => requests.filter((entry) => /\/mod\/scorm\/(?:view|player|report)\.php/.test(entry));

    // The review read of moodle-executor.js is the digest source for both writes.
    const prepared = await read();
    assert.equal(prepared.ok, true, JSON.stringify(prepared));
    assert.equal(prepared.data.package_type, "local");

    assert.deepEqual(await run(scormUpdate, { course_id: 2, module_id: 99, name: "Must not save", expected_digest: "0".repeat(64) }),
      { ok: false, sent: false, status: 200, error: "moodle_expected_digest_mismatch" });
    assert.equal(posts.length, 0);

    assert.deepEqual(await run(scormUpdate, { course_id: 2, module_id: 99, expected_digest: prepared.snapshot_digest }),
      { ok: false, sent: false, error: "moodle_scorm_arguments_invalid" });
    assert.deepEqual(await run(scormUpdate, { course_id: 2, module_id: 99, name: "Attachment refused", expected_digest: prepared.snapshot_digest }, attachment("file:scorm-refused", first, firstBytes)),
      { ok: false, sent: false, error: "moodle_scorm_arguments_invalid" });
    assert.equal(posts.length, 0);

    // A value the native control does not offer is refused before anything is sent.
    assert.deepEqual(await run(scormUpdate, { course_id: 2, module_id: 99, grademethod: "9", expected_digest: prepared.snapshot_digest }),
      { ok: false, sent: false, status: 200, error: "moodle_scorm_setting_not_writable" });
    assert.equal(posts.length, 0);

    const settings = {
      course_id: 2, module_id: 99, name: "Reviewed SCORM", instructions: "<p>Start with unit one.</p>",
      popup: "1", skipview: "2", displaycoursestructure: "0", hidebrowse: "1", maxattempt: "3", whatgrade: "1", grademethod: "2",
      open_at: { year: 2026, month: 10, day: 1, hour: 9, minute: 0 }, close_at: null, expected_digest: prepared.snapshot_digest,
    };
    const updated = await run(scormUpdate, settings);
    assert.equal(updated.ok, true, JSON.stringify(updated));
    assert.equal(updated.verification.status, "verified");
    assert.equal(posts.length, 1);
    assert.equal(posts[0].get("name"), "Reviewed SCORM");
    assert.equal(posts[0].get("popup"), "1");
    assert.equal(posts[0].get("maxattempt"), "3");
    assert.equal(posts[0].get("timeopen[enabled]"), "1");
    assert.equal(posts[0].get("timeopen[year]"), "2026");
    assert.equal(posts[0].get("timeclose[enabled]"), null);
    // Every control outside the stated scope travels unchanged, and the native
    // Save and display button and the learner notification never travel at all.
    assert.equal(posts[0].get("scormtype"), "local");
    assert.equal(posts[0].get("updatefreq"), "0");
    assert.equal(posts[0].get("visible"), "0");
    assert.equal(posts[0].get("grade"), "100");
    assert.equal(posts[0].get("width"), "100");
    assert.equal(posts[0].get("forcenewattempt"), "0");
    assert.equal(posts[0].get("submitbutton2"), "Save changes and return to course");
    assert.equal(posts[0].get("submitbutton"), null);
    assert.equal(posts[0].get("coursecontentnotification"), null);
    assert.equal(updated.data.name, "Reviewed SCORM");
    assert.equal(updated.data.grademethod, "2");
    assert.equal(updated.data.package_type, "local");
    assert.equal(updated.data.update_frequency, "0");
    assert.deepEqual(updated.data.open_at, { year: 2026, month: 10, day: 1, hour: 9, minute: 0 });
    assert.equal(updated.data.close_at, null);
    assert.deepEqual(updated.data.package, { filename: "course.zip", size_bytes: firstBytes.length });
    assert.equal(JSON.stringify(updated).includes(SESSION), false);
    assert.deepEqual(scormRoutes(), []);

    // A protected control the site changes during the save is reported, not hidden.
    const beforeDrift = await read();
    options.driftProtectedOnSave = true;
    const drifted = await run(scormUpdate, { course_id: 2, module_id: 99, name: "Drifted SCORM", expected_digest: beforeDrift.snapshot_digest });
    options.driftProtectedOnSave = false;
    assert.equal(drifted.ok, false, JSON.stringify(drifted));
    assert.equal(drifted.error, "moodle_write_not_verified");
    assert.deepEqual(drifted.verification, { schema: "morrow.browser-verification.v1", status: "mismatch", reason: "moodle_scorm_readback_mismatch" });
    assert.equal(posts.length, 2);
    state.grade = "100";

    // A name the site keeps instead of the requested one is a mismatch, not a success.
    const beforeKeep = await read();
    options.keepName = "Name the site kept";
    const kept = await run(scormUpdate, { course_id: 2, module_id: 99, name: "Requested name", expected_digest: beforeKeep.snapshot_digest });
    options.keepName = "";
    assert.equal(kept.ok, false, JSON.stringify(kept));
    assert.equal(kept.error, "moodle_write_not_verified");
    assert.equal(posts.length, 3);

    // A non-local package or an automatic update frequency is refused before any request is sent.
    const postsBeforeRefusals = posts.length;
    for (const [field, value] of [["scormtype", "external"], ["updatefreq", "1"]]) {
      const original = state[field];
      state[field] = value;
      const refused = await run(scormUpdate, { course_id: 2, module_id: 99, name: "Must not save", expected_digest: "0".repeat(64) });
      assert.deepEqual(refused, { ok: false, sent: false, status: 200, error: "moodle_scorm_package_type_refused" });
      state[field] = original;
    }
    assert.equal(posts.length, postsBeforeRefusals);

    // A visible activity refuses a package replacement.
    const beforeVisible = await read();
    state.visible = true;
    const visibleDigest = (await read()).snapshot_digest;
    assert.deepEqual(await run(scormReplace, { course_id: 2, module_id: 99, ...second, expected_digest: visibleDigest }, attachment("file:scorm-visible", second, secondBytes)),
      { ok: false, sent: false, status: 200, error: "moodle_scorm_activity_visible_refused" });
    state.visible = false;
    assert.equal(posts.length, postsBeforeRefusals);
    assert.notEqual(beforeVisible.snapshot_digest, visibleDigest);

    // A ZIP without one root imsmanifest.xml never reaches the draft area.
    const beforeUnusable = await read();
    const uploadsBeforeUnusable = requests.filter((entry) => entry.startsWith("POST /repository/repository_ajax.php")).length;
    assert.deepEqual(await run(scormReplace, { course_id: 2, module_id: 99, ...unusable, expected_digest: beforeUnusable.snapshot_digest }, attachment("file:scorm-unusable", unusable, withoutManifest)),
      { ok: false, sent: false, status: 200, error: "moodle_scorm_package_manifest_invalid" });
    assert.equal(posts.length, postsBeforeRefusals);
    assert.equal(requests.filter((entry) => entry.startsWith("POST /repository/repository_ajax.php")).length, uploadsBeforeUnusable);

    // The replacement itself: one POST, saved bytes read back from the SCORM package area.
    const beforeReplace = await read();
    const replaced = await run(scormReplace, { course_id: 2, module_id: 99, ...second, expected_digest: beforeReplace.snapshot_digest }, attachment("file:scorm-2", second, secondBytes));
    assert.equal(replaced.ok, true, JSON.stringify(replaced));
    assert.equal(replaced.verification.status, "verified");
    assert.equal(posts.length, postsBeforeRefusals + 1);
    assert.deepEqual(replaced.data.package, { filename: "updated-course.zip", size_bytes: secondBytes.length });
    assert.equal(replaced.data.name, "Name the site kept");
    assert.equal(replaced.data.grademethod, "2");
    assert.equal(state.package.filename, "updated-course.zip");
    assert.equal(createHash("sha256").update(state.package.bytes).digest("hex"), second.sha256);
    assert.ok(requests.includes("POST /repository/draftfiles_ajax.php?action=delete"));
    assert.ok(requests.includes(`GET /pluginfile.php/88/mod_scorm/package/updated-course.zip?forcedownload=1`));
    assert.equal(JSON.stringify(replaced).includes(SESSION), false);
    assert.deepEqual(scormRoutes(), []);

    // A native form redisplay is a refusal that saved nothing, not an unknown outcome.
    const beforeReject = await read();
    options.rejectSave = true;
    const rejected = await run(scormUpdate, { course_id: 2, module_id: 99, name: "Rejected by Moodle", expected_digest: beforeReject.snapshot_digest });
    options.rejectSave = false;
    assert.deepEqual(rejected, {
      ok: false,
      sent: true,
      status: 200,
      verification: { schema: "morrow.browser-verification.v1", status: "mismatch", reason: "moodle_scorm_save_not_sent" },
      error: "moodle_scorm_save_not_sent",
    });
    assert.equal(state.name, "Name the site kept");
    assert.equal(posts.length, postsBeforeRefusals + 2);

    // A lost save response is applied-or-unknown, never a retryable failure.
    const beforeUnknown = await read();
    options.saveUnknown = true;
    const unknown = await run(scormUpdate, { course_id: 2, module_id: 99, name: "Uncertain SCORM", expected_digest: beforeUnknown.snapshot_digest });
    options.saveUnknown = false;
    assert.equal(unknown.ok, false, JSON.stringify(unknown));
    assert.equal(unknown.sent, true);
    assert.equal(unknown.outcomeUnknown, true);
    assert.equal(unknown.error, "moodle_scorm_save_unknown");
    assert.equal(unknown.verification.status, "unconfirmed");
    assert.equal(posts.length, postsBeforeRefusals + 3);
    assert.deepEqual(scormRoutes(), []);

    // Every POST carried the draft area of the form reloaded immediately before dispatch.
    assert.deepEqual(staleDraftPosts, []);
  } finally {
    await context?.close();
    await browser?.close();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the Moodle SCORM catalog and worker expose exactly the two guarded SCORM writes", () => {
  const root = new URL("../..", import.meta.url);
  const catalog = JSON.parse(readFileSync(new URL("connector/extension/generated/moodle-browser-catalog.json", root), "utf8"));
  const entries = catalog.operations.filter((entry) => ["moodle_update_scorm", "moodle_replace_scorm_package"].includes(entry.toolName));
  assert.deepEqual(entries.map((entry) => entry.key).sort(), [
    "moodle.form.course.modedit.scorm.package.replace.write.v1",
    "moodle.form.course.modedit.scorm.write.v1",
  ]);
  for (const entry of entries) {
    assert.equal(entry.readOnly, false);
    assert.equal(entry.reviewTool, "moodle_get_scorm");
    assert.ok(entry.description.includes("never opens a SCORM launch, player, attempt, or report"), `${entry.toolName} must state the route limit`);
  }
  const replace = entries.find((entry) => entry.toolName === "moodle_replace_scorm_package");
  assert.equal(replace.destructive, true);
  assert.equal(replace.irreversible, true);
  assert.ok(replace.description.includes("can invalidate the existing learner attempts and tracking data"), "the replacement approval text must state the attempt and tracking risk");
  assert.ok(replace.description.includes("refuses an activity that is visible to learners"));
  assert.ok(replace.description.includes("do not establish SCORM package validity or learner access"));
  assert.ok(replace.description.includes("no signed-in Moodle site has run it"));

  const worker = readFileSync(new URL("connector/extension/src/service-worker.js", root), "utf8");
  assert.match(worker, /import \{ executeMoodleScormInPage \} from "\.\/moodle-scorm-executor\.js";/);
  for (const entry of entries) assert.match(worker, new RegExp(`"${entry.key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));

  const documentation = readFileSync(new URL("docs/implementation/MOODLE-FULL-FUNCTIONALITY.md", root), "utf8");
  assert.ok(documentation.includes("moodle_replace_scorm_package"), "the SCORM documentation row must name the replacement operation");
  assert.ok(documentation.includes("Byte equality does not establish package validity or learner access."));
});
