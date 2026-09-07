import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { executeMoodleBackupInPage } from "../../connector/extension/src/moodle-backup-executor.js";

const ANCHOR_SESSION = "moodle-session-a";
const FOREIGN_SESSION = "moodle-session-b";
const COURSE_CONTEXT_ID = "45";
const PATHNAME_HASH = "aaaa1111bbbb2222";
const CONTENT_HASH = "cccc3333dddd4444";
const LEARNER_NAME = "Ada Lovelace";
const LEARNER_GRADE = "87.5";

const operations = Object.freeze({
  files: { key: "moodle.form.backup.restorefile.index.read.v1", toolName: "moodle_list_backup_files", provider: "moodle", readOnly: true },
  backupProgress: { key: "moodle.ajax.core_backup.async_progress.backup.read.v1", toolName: "moodle_get_backup_progress", provider: "moodle", readOnly: true },
  restoreProgress: { key: "moodle.ajax.core_backup.async_progress.restore.read.v1", toolName: "moodle_get_restore_progress", provider: "moodle", readOnly: true },
  backup: { key: "moodle.form.backup.backup.course.write.v1", toolName: "moodle_start_course_backup", provider: "moodle", readOnly: false },
  restore: { key: "moodle.form.backup.restore.course.write.v1", toolName: "moodle_start_course_restore", provider: "moodle", readOnly: false },
  import: { key: "moodle.form.backup.import.course.write.v1", toolName: "moodle_start_course_import", provider: "moodle", readOnly: false },
  copy: { key: "moodle.form.backup.copy.course.write.v1", toolName: "moodle_copy_course", provider: "moodle", readOnly: false },
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

function readBody(request) {
  return new Promise((resolve) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

function hidden(name, value) {
  return `<input type="hidden" name="${name}" value="${value}">`;
}

function progressCell(id, extra = "") {
  return `<td><div class="progress"><div id="${id}_bar" class="progress-bar" data-backupid="${id}"${extra}></div></div></td>`;
}

// Moodle's own backup file table. The Status column exists only while the site
// runs backups and restores as scheduled tasks.
function fileTable(title, rows, asynchronous) {
  const head = ["File name", "Time", "Size", "Download", "Restore", ...(asynchronous ? ["Status"] : [])]
    .map((label) => `<th class="header">${label}</th>`).join("");
  const body = rows.map((row) => {
    if (row.inProgress) {
      return `<tr><td>${row.name}</td><td>${row.time}</td><td>-</td><td>-</td><td>-</td>${progressCell(row.operationId, ' data-operation="backup"')}</tr>`;
    }
    const chooser = new URLSearchParams({
      action: "choosebackupfile",
      filename: row.name,
      filepath: "/",
      component: row.component,
      filearea: row.filearea,
      filecontextid: row.filecontextid,
      contextid: COURSE_CONTEXT_ID,
      itemid: "0",
    });
    const restore = row.restorable ? `<a href="/backup/restorefile.php?${chooser}">Restore</a>` : "";
    const download = `<a href="/pluginfile.php/${row.filecontextid}/${row.component}/${row.filearea}/${row.name}?forcedownload=1">Download</a>`;
    return `<tr><td>${row.name}</td><td>${row.time}</td><td>${row.size}</td><td>${download}</td><td>${restore}</td>`
      + `${asynchronous ? '<td><span class="action-icon">Successful</span></td>' : ""}</tr>`;
  }).join("");
  return `<h3>${title}</h3><table class="backup-files-table table generaltable table-hover">`
    + `<thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function restoreProgressTable(rows) {
  const body = rows.map((row) => `<tr><td>${row.course}</td><td>${row.time}</td>${progressCell(row.operationId, ` data-restoreid="${row.operationId}"`)}</tr>`).join("");
  return `<table class="backup-files-table table generaltable table-hover">`
    + `<thead><tr><th class="header">Course</th><th class="header">Time</th><th class="header">Status</th></tr></thead>`
    + `<tbody>${body}</tbody></table>`;
}

function page(body) {
  return `<!doctype html><html><body class="path-backup course-2">${body}
    <table class="generaltable"><tbody><tr><td>${LEARNER_NAME}</td><td>${LEARNER_GRADE}</td></tr></tbody></table>
  </body></html>`;
}

test("Moodle backup executor runs each native course-reuse step once and never repeats one it could not confirm", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morrow-moodle-backup-"));
  const key = join(directory, "key.pem");
  const certificate = join(directory, "certificate.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", certificate], { stdio: "ignore" });

  const state = {
    session: ANCHOR_SESSION,
    sessionQueue: [],
    asynchronous: true,
    files: [
      { area: "course", name: "backup-moodle2-course-2-nurs101-20260901.mbz", time: "1 September 2026, 9:00 AM", size: "12.3 MB", component: "backup", filearea: "course", filecontextid: COURSE_CONTEXT_ID, restorable: true },
      { area: "backup", name: "backup-moodle2-course-2-nurs101-20260815.mbz", time: "15 August 2026, 4:10 PM", size: "11.9 MB", component: "user", filearea: "backup", filecontextid: "9", restorable: true },
      { area: "automated", name: "backup-auto-course-2-20260907.mbz", time: "7 September 2026, 1:00 AM", size: "12.4 MB", component: "backup", filearea: "automated", filecontextid: COURSE_CONTEXT_ID, restorable: false },
    ],
    backupsInProgress: [],
    restoresInProgress: [],
    copies: [],
    shortNamesInUse: new Set(["NURS-101", "NURS-201"]),
    activities: [{ id: 21, name: "Orientation page" }, { id: 22, name: "Skills lab" }],
    restoreWorkflow: null,
    restoreStageOverride: "",
    copyRoleChecked: false,
    backupCreatesFile: true,
    changeCourseOnNextRead: false,
    progress: { b1: { status: 800, progress: 0.42, operation: "backup" }, r1: { status: 700, progress: 0, operation: "restore" } },
  };
  const requests = [];
  const posts = [];
  let origin = "";
  let workflowCounter = 0;

  const stageForm = (stage, restoreId, action) => `<form method="post" action="${action}" class="mform">
      ${hidden("stage", stage)}${hidden("restore", restoreId)}${hidden("contextid", COURSE_CONTEXT_ID)}
      ${hidden("sesskey", state.session)}${hidden("_qf__restore_form", "1")}
      ${hidden(`setting_root_stage_${stage}`, "1")}
      <input type="submit" name="previous" value="Previous">
      <input type="submit" name="cancel" value="Cancel">
      <input type="submit" name="submitbutton" value="Next">
    </form>`;

  const listingPage = () => page([
    fileTable("Course backup area", [
      ...state.backupsInProgress.map((entry) => ({ ...entry, inProgress: true })),
      ...state.files.filter((file) => file.area === "course"),
    ], state.asynchronous),
    fileTable("User private backup area", state.files.filter((file) => file.area === "backup"), state.asynchronous),
    fileTable("Automated backups", state.files.filter((file) => file.area === "automated"), state.asynchronous),
    ...(state.asynchronous
      ? [restoreProgressTable(state.restoresInProgress.map((entry) => ({ course: "Nursing Fundamentals", time: "7 September 2026, 12:05 PM", operationId: entry.operationId })))]
      : []),
  ].join(""));

  const server = createServer({ key: readFileSync(key), cert: readFileSync(certificate) }, async (request, response) => {
    const url = new URL(request.url || "/", origin || "https://127.0.0.1");
    requests.push(`${request.method} ${url.pathname}${url.search}`);
    const sesskey = () => state.sessionQueue.shift() || state.session;
    const html = (body) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(body);
    };

    if (url.pathname === "/course/view.php") {
      html(`<!doctype html><body class="path-course course-2"><script>var M = {}; M.cfg = ${JSON.stringify({
        wwwroot: origin, sesskey: ANCHOR_SESSION, userId: 3, courseId: 2, courseContextId: Number(COURSE_CONTEXT_ID),
      })};</script></body>`);
      return;
    }

    if (request.method === "GET" && url.pathname === "/backup/restorefile.php" && url.searchParams.get("action") === "choosebackupfile") {
      const name = url.searchParams.get("filename") || "";
      const file = state.files.find((entry) => entry.name === name && entry.restorable);
      if (!file) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(303, { location: `/backup/restore.php?contextid=${COURSE_CONTEXT_ID}&pathnamehash=${PATHNAME_HASH}&contenthash=${CONTENT_HASH}` });
      response.end();
      return;
    }
    if (request.method === "GET" && url.pathname === "/backup/restorefile.php") {
      if (url.searchParams.get("contextid") !== COURSE_CONTEXT_ID) {
        response.writeHead(404).end();
        return;
      }
      html(listingPage());
      return;
    }

    if (request.method === "GET" && url.pathname === "/backup/restore.php" && url.searchParams.get("pathnamehash")) {
      // The confirmation stage: Moodle reads the archive and links to the
      // destination stage of that exact extracted archive.
      html(page(`<div class="backup-details"><a href="/backup/restore.php?contextid=${COURSE_CONTEXT_ID}&filepath=fp1&stage=2">Continue</a></div>`));
      return;
    }
    if (request.method === "GET" && url.pathname === "/backup/restore.php" && url.searchParams.get("stage") === "2") {
      const common = `${hidden("contextid", COURSE_CONTEXT_ID)}${hidden("filepath", url.searchParams.get("filepath") || "")}${hidden("stage", "4")}${hidden("sesskey", sesskey())}`;
      html(page(`<div class="backup-course-selector backup-restore">
        <form method="post" action="${origin}/backup/restore.php" class="mform">${common}
          <div class="bcs-new-course backup-section">
            <input type="radio" name="target" value="2" checked>
            <select name="catid"><option value="3">Nursing</option></select>
            <input type="submit" value="Continue">
          </div>
        </form>
        <form method="post" action="${origin}/backup/restore.php" class="mform">${common}${hidden("targetid", "2")}
          <div class="bcs-current-course backup-section">
            <input type="radio" name="target" value="1" checked>
            <input type="radio" name="target" value="0">
            <input type="submit" value="Continue">
          </div>
        </form>
        <form method="post" action="${origin}/backup/restore.php" class="mform">${common}
          <div class="bcs-existing-course backup-section">
            <input type="radio" name="target" value="4" checked>
            <input type="radio" name="target" value="3">
            <select name="targetid"><option value="8">Nursing Fundamentals II</option></select>
            <input type="submit" value="Continue">
          </div>
        </form>
      </div>`));
      return;
    }
    if (request.method === "POST" && url.pathname === "/backup/restore.php") {
      const values = new URLSearchParams(await readBody(request));
      posts.push({ path: url.pathname, search: url.search, values });
      if (values.get("cancel")) {
        state.restoreWorkflow = null;
        response.writeHead(303, { location: "/course/view.php?id=2" });
        response.end();
        return;
      }
      const stage = values.get("stage");
      if (stage === "4" && values.get("targetid") && !values.get("restore")) {
        // The destination stage creates the restore and answers with the
        // settings stage of that restore.
        state.restoreWorkflow = { id: `r${++workflowCounter}`, target: values.get("target"), filepath: values.get("filepath") };
        html(page(stageForm("4", state.restoreWorkflow.id, `${origin}/backup/restore.php?contextid=${COURSE_CONTEXT_ID}`)));
        return;
      }
      if (!state.restoreWorkflow || values.get("restore") !== state.restoreWorkflow.id || !values.get("submitbutton")) {
        response.writeHead(400).end();
        return;
      }
      const next = { 4: "8", 8: "16", 16: "32" }[stage];
      if (!next) {
        response.writeHead(400).end();
        return;
      }
      if (next === "32") {
        state.restoresInProgress.push({ operationId: state.restoreWorkflow.id, target: state.restoreWorkflow.target });
        html(page(`<div class="progressbar_container" id="${state.restoreWorkflow.id}">
          <h3 id="${state.restoreWorkflow.id}_status">Restore pending</h3>
          <div class="progress"><div id="${state.restoreWorkflow.id}_bar" data-backupid="${state.restoreWorkflow.id}"></div></div>
        </div>`));
        return;
      }
      const shown = state.restoreStageOverride || next;
      html(page(stageForm(shown, state.restoreWorkflow.id, `${origin}/backup/restore.php?contextid=${COURSE_CONTEXT_ID}`)));
      return;
    }

    if (request.method === "GET" && url.pathname === "/backup/backup.php") {
      if (url.searchParams.get("id") !== "2") {
        response.writeHead(404).end();
        return;
      }
      html(page(`<form method="post" action="${origin}/backup/backup.php?id=2" class="mform">
        ${hidden("stage", "1")}${hidden("backup", "b1")}${hidden("sesskey", sesskey())}${hidden("_qf__backup_initial_form", "1")}
        ${hidden("setting_root_users", "1")}${hidden("setting_root_anonymize", "0")}${hidden("setting_root_files", "1")}
        <input type="submit" name="oneclickbackup" value="Jump to final step">
        <input type="submit" name="cancel" value="Cancel">
        <input type="submit" name="submitbutton" value="Next">
      </form>`));
      return;
    }
    if (request.method === "POST" && url.pathname === "/backup/backup.php") {
      const values = new URLSearchParams(await readBody(request));
      posts.push({ path: url.pathname, search: url.search, values });
      if (!values.get("oneclickbackup")) {
        response.writeHead(400).end();
        return;
      }
      if (state.backupCreatesFile) {
        state.backupsInProgress.push({ name: "backup-moodle2-course-2-nurs101-20260907-1200.mbz", time: "7 September 2026, 12:00 PM", operationId: "b1" });
      }
      html(page(`<div class="progressbar_container" id="b1"><div class="progress"><div id="b1_bar" data-backupid="b1"></div></div></div>`));
      return;
    }

    if (request.method === "GET" && url.pathname === "/backup/import.php") {
      if (url.searchParams.get("id") !== "2" || url.searchParams.get("importid") !== "7") {
        html(page("<div class='import-course-selector'>Choose a course</div>"));
        return;
      }
      html(page(`<form method="post" action="${origin}/backup/import.php?id=2" class="mform">
        ${hidden("stage", "1")}${hidden("backup", "i1")}${hidden("importid", "7")}${hidden("target", "1")}
        ${hidden("sesskey", sesskey())}${hidden("_qf__backup_initial_form", "1")}${hidden("setting_root_activities", "1")}
        <input type="submit" name="oneclickbackup" value="Jump to final step">
        <input type="submit" name="cancel" value="Cancel">
        <input type="submit" name="submitbutton" value="Next">
      </form>`));
      return;
    }
    if (request.method === "POST" && url.pathname === "/backup/import.php") {
      const values = new URLSearchParams(await readBody(request));
      posts.push({ path: url.pathname, search: url.search, values });
      if (values.get("cancel")) {
        response.writeHead(303, { location: "/course/view.php?id=2" });
        response.end();
        return;
      }
      if (!values.get("oneclickbackup")) {
        response.writeHead(400).end();
        return;
      }
      state.activities.push({ id: 41, name: "Imported pharmacology page" });
      html(page("<div class='import-complete'>Import complete</div>"));
      return;
    }

    if (request.method === "GET" && url.pathname === "/backup/copy.php") {
      html(page(`<form method="post" action="${origin}/backup/copy.php?id=2" class="mform">
        ${hidden("courseid", "2")}${hidden("sesskey", sesskey())}${hidden("returnto", "course")}
        ${hidden("returnurl", "/course/view.php?id=2")}${hidden("_qf__copy_form", "1")}
        <input type="text" name="fullname" value="Nursing Fundamentals">
        <input type="text" name="shortname" value="NURS-101">
        <select name="category"><option value="3" selected>Nursing</option><option value="4">Allied health</option></select>
        <select name="visible"><option value="0">Hide</option><option value="1" selected>Show</option></select>
        ${hidden("startdate[day]", "8")}${hidden("startdate[month]", "9")}${hidden("startdate[year]", "2026")}
        <input type="text" name="idnumber" value="NURS-101-ID">
        <select name="userdata"><option value="0" selected>No</option><option value="1">Yes</option></select>
        <input type="checkbox" name="role_5" value="5"${state.copyRoleChecked ? " checked" : ""}>
        <input type="submit" name="submitreturn" value="Copy and return">
        <input type="submit" name="submitdisplay" value="Copy and view">
        <input type="submit" name="cancel" value="Cancel">
      </form>`));
      return;
    }
    if (request.method === "POST" && url.pathname === "/backup/copy.php") {
      const values = new URLSearchParams(await readBody(request));
      posts.push({ path: url.pathname, search: url.search, values });
      const shortName = values.get("shortname") || "";
      if (state.shortNamesInUse.has(shortName)) {
        // Moodle re-renders the form with an error and creates nothing.
        html(page(`<form method="post" action="${origin}/backup/copy.php?id=2" class="mform">
          ${hidden("courseid", "2")}${hidden("sesskey", state.session)}<span class="error">Short name is already used</span>
        </form>`));
        return;
      }
      state.shortNamesInUse.add(shortName);
      state.copies.push({
        source: "Nursing Fundamentals",
        destination: values.get("fullname") || "",
        started: "7 September 2026, 12:10 PM",
        operation: "backup",
        operationId: "c1",
      });
      response.writeHead(303, { location: "/course/view.php?id=2" });
      response.end();
      return;
    }
    if (request.method === "GET" && url.pathname === "/backup/copyprogress.php") {
      const rows = state.copies.map((copy) => `<tr><td><a href="/course/view.php?id=2">${copy.source}</a></td><td>${copy.destination}</td>`
        + `<td>${copy.started}</td><td>${copy.operation}</td>${progressCell(copy.operationId, ` data-operation="${copy.operation}"`)}</tr>`).join("");
      html(page(`<table class="backup-files-table table generaltable">`
        + `<thead><tr><th>Source</th><th>Destination</th><th>Time</th><th>Operation</th><th>Status</th></tr></thead>`
        + `<tbody>${rows}</tbody></table>`));
      return;
    }

    if (request.method === "POST" && url.pathname === "/lib/ajax/service.php") {
      const call = JSON.parse(await readBody(request))[0];
      assert.equal(url.searchParams.get("info"), call.methodname);
      if (call.methodname === "core_courseformat_get_state") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify([{
          data: JSON.stringify({
            course: { id: 2, fullname: "Nursing Fundamentals", sesskey: ANCHOR_SESSION },
            section: [{ id: 10, number: 0, title: "General" }],
            cm: state.activities.map((activity) => ({ id: activity.id, sectionid: 10, name: activity.name, visible: 1 })),
          }),
        }]));
        if (state.changeCourseOnNextRead) {
          // Someone else changes the course between the two reads of it.
          state.changeCourseOnNextRead = false;
          state.activities.push({ id: 55, name: "Added by someone else" });
        }
        return;
      }
      assert.equal(call.methodname, "core_backup_get_async_backup_progress");
      const wanted = call.args.backupids[0];
      const known = state.progress[wanted];
      response.writeHead(200, { "content-type": "application/json" });
      response.end(known
        ? JSON.stringify([{ data: [{ status: known.status, progress: known.progress, backupid: wanted, operation: known.operation }] }])
        : JSON.stringify([{ exception: { errorcode: "invalidbackupid" } }]));
      return;
    }
    response.writeHead(404).end();
  });

  let browser;
  let context;
  try {
    await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", (error) => error ? reject(error) : resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("backup test server did not bind");
    origin = `https://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
    context = await browser.newContext({ ignoreHTTPSErrors: true });
    const pageHandle = await context.newPage();
    await pageHandle.goto(`${origin}/course/view.php?id=2`);
    const binding = { origin, siteUrl: `${origin}/`, principalId: "3", courseId: "2" };
    const execute = (operation, argumentsValue) => pageHandle.evaluate(
      executeMoodleBackupInPage,
      JSON.stringify({ mode: "execute", operation, arguments: argumentsValue, binding, expiresAt: Date.now() + 120_000 }),
    );
    const loseNextPost = (pathname, marker) => pageHandle.evaluate(([path, needle]) => {
      const nativeFetch = globalThis.fetch;
      globalThis.fetch = async (...parameters) => {
        const response = await nativeFetch(...parameters);
        const target = new URL(parameters[0], globalThis.location.href);
        const body = String(parameters[1]?.body ?? "");
        if (String(parameters[1]?.method || "GET").toUpperCase() === "POST" && target.pathname === path && body.includes(needle)) {
          globalThis.fetch = nativeFetch;
          throw new TypeError("response lost after dispatch");
        }
        return response;
      };
    }, [pathname, marker]);
    const ajaxCount = () => requests.filter((entry) => entry.startsWith("POST /lib/ajax/service.php")).length;

    const listing = await execute(operations.files, { course_id: 2 });
    assert.equal(listing.ok, true, JSON.stringify(listing));
    assert.equal(posts.length, 0);

    // ---- The reviewed state ----
    assert.equal(listing.data.asynchronous, true);
    assert.deepEqual(listing.data.proof, {
      method: "native_form_read", route: "/backup/restorefile.php",
      required_capability: "moodle/restore:restorecourse", scope: "course_backup_file_areas_only",
    });
    assert.deepEqual(listing.data.files.map((file) => [file.area, file.file_name, file.restorable, file.in_progress]), [
      ["course", "backup-moodle2-course-2-nurs101-20260901.mbz", true, false],
      ["backup", "backup-moodle2-course-2-nurs101-20260815.mbz", true, false],
      ["", "backup-auto-course-2-20260907.mbz", false, false],
    ]);
    assert.equal(listing.data.files[0].size, "12.3 MB");
    assert.equal(listing.data.files[0].saved_at, "1 September 2026, 9:00 AM");
    assert.equal(listing.data.restores_in_progress, 0);
    assert.equal(listing.data.backups_in_progress, 0);
    for (const file of listing.data.files) assert.match(file.file_digest, /^[a-f0-9]{64}$/);
    assert.equal(new Set(listing.data.files.map((file) => file.file_digest)).size, 3);
    assert.equal(listing.snapshot_digest, digestOf({
      courseId: "2",
      asynchronous: true,
      restoresInProgress: 0,
      files: listing.data.files.map((file) => [file.area, file.file_name, file.saved_at, file.size, file.restorable, file.in_progress]),
    }));
    // The session key, the file hashes, the download addresses and the learner-shaped
    // page noise never leave the browser.
    const listingText = JSON.stringify(listing);
    for (const secret of [ANCHOR_SESSION, PATHNAME_HASH, CONTENT_HASH, LEARNER_NAME, LEARNER_GRADE, "pluginfile.php", "choosebackupfile"]) {
      assert.equal(listingText.includes(secret), false, secret);
    }

    // ---- Progress is read once per call, and never waited on ----
    const beforePolls = ajaxCount();
    const backupProgress = await execute(operations.backupProgress, { course_id: 2, operation_id: "b1" });
    assert.equal(backupProgress.ok, true, JSON.stringify(backupProgress));
    assert.deepEqual(backupProgress.data, {
      operation_id: "b1", operation: "backup", status_code: 800, state: "running", progress: 0.42, finished: false, polled_once: true,
      proof: {
        method: "native_ajax_read",
        route: "/lib/ajax/service.php?info=core_backup_get_async_backup_progress",
        required_capability: "moodle/backup:backupcourse",
        scope: "one_operation_id_one_request",
      },
    });
    assert.equal(ajaxCount() - beforePolls, 1, "one progress read makes exactly one request");
    await execute(operations.backupProgress, { course_id: 2, operation_id: "b1" });
    assert.equal(ajaxCount() - beforePolls, 2, "a second read polls again, and neither call loops");
    assert.equal(posts.length, 0, "a progress read sends no native form");
    // A backup id is not a restore id, and each read refuses the other operation.
    assert.deepEqual(await execute(operations.restoreProgress, { course_id: 2, operation_id: "b1" }), {
      ok: false, sent: false, status: 200, error: "moodle_backup_progress_operation_mismatch",
    });
    assert.deepEqual(await execute(operations.backupProgress, { course_id: 2, operation_id: "nosuchid" }), {
      ok: false, sent: false, status: 200, error: "moodle_backup_progress_unavailable",
    });
    state.progress.r1.status = 1000;
    state.progress.r1.progress = 1;
    const restoreProgress = await execute(operations.restoreProgress, { course_id: 2, operation_id: "r1" });
    assert.equal(restoreProgress.data.state, "complete");
    assert.equal(restoreProgress.data.finished, true);

    // ---- One backup, one step ----
    assert.deepEqual(await execute(operations.backup, { course_id: 2, expected_digest: "0".repeat(64) }), {
      ok: false, sent: false, status: 200, error: "moodle_expected_digest_mismatch",
    });
    // A native form that does not carry the signed-in session key is refused before anything is sent.
    state.sessionQueue.push(FOREIGN_SESSION);
    assert.deepEqual(await execute(operations.backup, { course_id: 2, expected_digest: listing.snapshot_digest }), {
      ok: false, sent: false, status: 200, error: "moodle_backup_form_invalid",
    });
    assert.equal(posts.length, 0);
    state.asynchronous = false;
    const synchronous = await execute(operations.files, { course_id: 2 });
    assert.equal(synchronous.data.asynchronous, false);
    assert.deepEqual(await execute(operations.backup, { course_id: 2, expected_digest: synchronous.snapshot_digest }), {
      ok: false, sent: false, status: 200, error: "moodle_backup_asynchronous_required",
    });
    state.asynchronous = true;
    assert.equal(posts.length, 0);

    const started = await execute(operations.backup, { course_id: 2, expected_digest: listing.snapshot_digest });
    assert.equal(started.ok, true, JSON.stringify(started));
    assert.equal(started.verification.status, "verified");
    assert.equal(posts.length, 1);
    assert.equal(posts[0].path, "/backup/backup.php");
    assert.equal(posts[0].values.get("oneclickbackup"), "Jump to final step");
    assert.equal(posts[0].values.get("submitbutton"), null);
    assert.equal(posts[0].values.get("setting_root_users"), "1");
    assert.equal(posts[0].values.get("backup"), "b1");
    assert.equal(started.data.backup_file_name, "backup-moodle2-course-2-nurs101-20260907-1200.mbz");
    assert.equal(started.data.backup_area, "course");
    assert.equal(started.data.in_progress, true);
    assert.equal(started.data.operation_id, "b1");
    assert.deepEqual(started.data.settings_sent, [
      { name: "stage", value: "1" },
      { name: "setting_root_users", value: "1" },
      { name: "setting_root_anonymize", value: "0" },
      { name: "setting_root_files", value: "1" },
    ]);
    assert.deepEqual(started.data.steps.map((step) => `${step.step}:${step.method}`), [
      "read_backup_files_before:GET", "load_backup_form:GET", "start_backup:POST", "read_backup_files_after:GET",
    ]);
    assert.equal(JSON.stringify(started).includes(ANCHOR_SESSION), false);

    // A backup Moodle is already running is not started again.
    const afterBackup = await execute(operations.files, { course_id: 2 });
    assert.equal(afterBackup.data.backups_in_progress, 1);
    assert.deepEqual(await execute(operations.backup, { course_id: 2, expected_digest: afterBackup.snapshot_digest }), {
      ok: false, sent: false, status: 200, error: "moodle_backup_already_in_progress",
    });
    assert.equal(posts.length, 1);
    state.backupsInProgress = [];

    // A backup that leaves no new entry in the file areas is not reported as a success.
    state.backupCreatesFile = false;
    const unproven = await execute(operations.files, { course_id: 2 });
    assert.deepEqual(await execute(operations.backup, { course_id: 2, expected_digest: unproven.snapshot_digest }), {
      ok: false, sent: true, status: 200, outcomeUnknown: true,
      verification: { schema: "morrow.browser-verification.v1", status: "unconfirmed", reason: "moodle_backup_start_not_verified" },
      error: "moodle_backup_start_not_verified",
    });
    assert.equal(posts.length, 2);
    state.backupCreatesFile = true;

    // ---- The restore, step by step ----
    const reviewed = await execute(operations.files, { course_id: 2 });
    const source = reviewed.data.files[0];
    const restoreArguments = {
      course_id: 2,
      source_file_name: source.file_name,
      source_file_digest: source.file_digest,
      restore_mode: "merge",
      expected_digest: reviewed.snapshot_digest,
      acknowledge_course_change: true,
    };
    // A delete-and-restore removes the whole course, so it needs its own approval,
    // and it is refused before anything is read.
    assert.deepEqual(await execute(operations.restore, { ...restoreArguments, restore_mode: "delete_and_restore" }), {
      ok: false, sent: false, error: "moodle_backup_arguments_invalid",
    });
    assert.deepEqual(await execute(operations.restore, {
      ...restoreArguments, restore_mode: "delete_and_restore", acknowledge_delete_and_restore: false,
    }), { ok: false, sent: false, error: "moodle_backup_arguments_invalid" });
    // A merge cannot carry the delete approval, and no approval at all is refused.
    assert.deepEqual(await execute(operations.restore, { ...restoreArguments, acknowledge_delete_and_restore: true }), {
      ok: false, sent: false, error: "moodle_backup_arguments_invalid",
    });
    assert.deepEqual(await execute(operations.restore, { ...restoreArguments, acknowledge_course_change: false }), {
      ok: false, sent: false, error: "moodle_backup_arguments_invalid",
    });
    // The approval names one exact file, so a name without its digest is refused.
    assert.deepEqual(await execute(operations.restore, { ...restoreArguments, source_file_digest: "1".repeat(64) }), {
      ok: false, sent: false, status: 200, error: "moodle_restore_source_file_unavailable",
    });
    assert.deepEqual(await execute(operations.restore, {
      ...restoreArguments, source_file_name: "backup-auto-course-2-20260907.mbz", source_file_digest: reviewed.data.files[2].file_digest,
    }), { ok: false, sent: false, status: 200, error: "moodle_restore_source_file_unavailable" });
    assert.equal(posts.length, 2, "no restore refusal reaches a native form");

    const restored = await execute(operations.restore, restoreArguments);
    assert.equal(restored.ok, true, JSON.stringify(restored));
    assert.equal(restored.verification.status, "verified");
    assert.deepEqual(restored.data.steps.map((step) => `${step.step}:${step.method}`), [
      "read_backup_files_before:GET",
      "read_course_state_before:POST",
      "choose_backup_file:GET",
      "open_restore_destination:GET",
      "commit_restore_destination:POST",
      "restore_settings_stage:POST",
      "restore_schema_stage:POST",
      "restore_review_stage:POST",
      "read_backup_files_after:GET",
    ]);
    const restorePosts = posts.filter((entry) => entry.path === "/backup/restore.php");
    assert.equal(restorePosts.length, 4, "each restore stage is dispatched exactly once");
    assert.deepEqual(restorePosts.map((entry) => entry.values.get("stage")), ["4", "4", "8", "16"]);
    assert.equal(restorePosts[0].values.get("target"), "1");
    assert.equal(restorePosts[0].values.get("targetid"), "2");
    assert.equal(restorePosts[0].values.get("filepath"), "fp1");
    for (const entry of restorePosts.slice(1)) assert.equal(entry.values.get("restore"), "r1");
    assert.equal(restorePosts[3].values.get("submitbutton"), "Next");
    assert.equal(restorePosts.some((entry) => entry.values.get("cancel")), false);
    assert.equal(restored.data.restore_mode, "merge");
    assert.equal(restored.data.removes_existing_course_content, false);
    assert.equal(restored.data.operation_id, "r1");
    assert.equal(restored.data.state, "queued");
    assert.equal(restored.data.course_changed_yet, false);
    assert.equal(restored.data.restores_in_progress, 1);
    assert.deepEqual(restored.data.course_state_before.activities.map((activity) => activity.name), ["Orientation page", "Skills lab"]);
    assert.equal(JSON.stringify(restored).includes(PATHNAME_HASH), false);
    assert.equal(JSON.stringify(restored).includes(ANCHOR_SESSION), false);

    // Moodle is already restoring into this course, so a second restore is refused.
    const busy = await execute(operations.files, { course_id: 2 });
    assert.equal(busy.data.restores_in_progress, 1);
    assert.deepEqual(await execute(operations.restore, { ...restoreArguments, expected_digest: busy.snapshot_digest }), {
      ok: false, sent: false, status: 200, error: "moodle_restore_already_in_progress",
    });
    state.restoresInProgress = [];
    state.restoreWorkflow = null;

    // A delete-and-restore that carries its approval reaches the native deleting target.
    const deleting = await execute(operations.files, { course_id: 2 });
    const cleared = await execute(operations.restore, {
      ...restoreArguments,
      restore_mode: "delete_and_restore",
      acknowledge_delete_and_restore: true,
      expected_digest: deleting.snapshot_digest,
      source_file_digest: deleting.data.files[0].file_digest,
    });
    assert.equal(cleared.ok, true, JSON.stringify(cleared));
    assert.equal(cleared.data.removes_existing_course_content, true);
    assert.equal(cleared.data.proof.scope, "replaces_the_approved_course");
    const deletingPost = posts.filter((entry) => entry.path === "/backup/restore.php").at(-4);
    assert.equal(deletingPost.values.get("target"), "0");
    state.restoresInProgress = [];
    state.restoreWorkflow = null;

    // ---- A stage Moodle does not answer as promised is cancelled, once ----
    const beforeCancel = await execute(operations.files, { course_id: 2 });
    const postsBeforeCancel = posts.length;
    state.restoreStageOverride = "16";
    const cancelled = await execute(operations.restore, {
      ...restoreArguments, expected_digest: beforeCancel.snapshot_digest, source_file_digest: beforeCancel.data.files[0].file_digest,
    });
    state.restoreStageOverride = "";
    assert.equal(cancelled.ok, false);
    assert.equal(cancelled.sent, false);
    assert.equal(cancelled.error, "moodle_restore_stage_unexpected");
    assert.equal(cancelled.workflow_cancelled, true);
    assert.equal(state.restoreWorkflow, null, "the native workflow is not left half built");
    const cancelSequence = posts.slice(postsBeforeCancel);
    assert.deepEqual(cancelSequence.map((entry) => entry.values.get("stage")), ["4", "4", "16"]);
    assert.equal(cancelSequence.at(-1).values.get("cancel"), "Cancel");
    assert.equal(cancelSequence.filter((entry) => entry.values.get("cancel")).length, 1, "cancel is sent once");
    assert.equal(state.restoresInProgress.length, 0);

    // ---- A step whose answer is lost stays unconfirmed, and nothing after it is sent ----
    const beforeLoss = await execute(operations.files, { course_id: 2 });
    const postsBeforeLoss = posts.length;
    await loseNextPost("/backup/restore.php", "stage=8");
    const lost = await execute(operations.restore, {
      ...restoreArguments, expected_digest: beforeLoss.snapshot_digest, source_file_digest: beforeLoss.data.files[0].file_digest,
    });
    assert.deepEqual(lost, {
      ok: false, sent: true, outcomeUnknown: true,
      verification: { schema: "morrow.browser-verification.v1", status: "unconfirmed", reason: "moodle_restore_unconfirmed" },
      error: "moodle_restore_unconfirmed",
    });
    const lostSequence = posts.slice(postsBeforeLoss);
    assert.deepEqual(lostSequence.map((entry) => entry.values.get("stage")), ["4", "4", "8"]);
    assert.equal(lostSequence.filter((entry) => entry.values.get("cancel")).length, 0, "an unknown step is never cancelled");
    assert.equal(state.restoresInProgress.length, 0, "the restore was never queued");
    assert.notEqual(state.restoreWorkflow, null);
    state.restoreWorkflow = null;

    // ---- The import: one step, with the target course read before and after ----
    assert.deepEqual(await execute(operations.import, { course_id: 2, source_course_id: 7 }), {
      ok: false, sent: false, error: "moodle_backup_arguments_invalid",
    });
    assert.deepEqual(await execute(operations.import, { course_id: 2, source_course_id: 2, acknowledge_course_change: true }), {
      ok: false, sent: false, error: "moodle_backup_arguments_invalid",
    });
    assert.deepEqual(await execute(operations.import, { course_id: 2, source_course_id: 9, acknowledge_course_change: true }), {
      ok: false, sent: false, status: 200, error: "moodle_import_form_invalid",
    });
    const postsBeforeImport = posts.length;
    const imported = await execute(operations.import, { course_id: 2, source_course_id: 7, acknowledge_course_change: true });
    assert.equal(imported.ok, true, JSON.stringify(imported));
    assert.equal(imported.verification.status, "verified");
    assert.equal(posts.length - postsBeforeImport, 1);
    assert.equal(posts.at(-1).path, "/backup/import.php");
    assert.equal(posts.at(-1).values.get("importid"), "7");
    assert.equal(posts.at(-1).values.get("target"), "1");
    assert.equal(posts.at(-1).values.get("oneclickbackup"), "Jump to final step");
    assert.deepEqual(imported.data.activities_added, [{ id: "41", name: "Imported pharmacology page" }]);
    assert.deepEqual(imported.data.course_state_before.activities.map((activity) => activity.name), ["Orientation page", "Skills lab"]);
    assert.deepEqual(imported.data.course_state_after.activities.map((activity) => activity.name), [
      "Orientation page", "Skills lab", "Imported pharmacology page",
    ]);
    assert.equal(imported.data.restore_mode, "merge");
    assert.equal(JSON.stringify(imported).includes(ANCHOR_SESSION), false);
    assert.deepEqual(imported.data.steps.map((step) => step.step), [
      "read_course_state_before", "load_import_form", "read_course_state_fresh", "run_import", "read_course_state_after",
    ]);

    // A course someone else changed between the two reads is not imported into, and the
    // native workflow Morrow opened is ended with its own Cancel.
    const postsBeforeChange = posts.length;
    state.changeCourseOnNextRead = true;
    const changed = await execute(operations.import, { course_id: 2, source_course_id: 7, acknowledge_course_change: true });
    assert.equal(changed.ok, false);
    assert.equal(changed.sent, false);
    assert.equal(changed.error, "moodle_import_course_changed");
    assert.equal(changed.workflow_cancelled, true);
    const changeSequence = posts.slice(postsBeforeChange);
    assert.equal(changeSequence.length, 1);
    assert.equal(changeSequence[0].path, "/backup/import.php");
    assert.equal(changeSequence[0].values.get("cancel"), "Cancel");
    assert.equal(changeSequence[0].values.get("oneclickbackup"), null);

    // ---- The copy: hidden, with no learner data and no enrolments ----
    assert.deepEqual(await execute(operations.copy, { course_id: 2, new_full_name: "Copy", new_short_name: "COPY-1" }), {
      ok: false, sent: false, error: "moodle_backup_arguments_invalid",
    });
    state.copyRoleChecked = true;
    assert.deepEqual(await execute(operations.copy, {
      course_id: 2, new_full_name: "Nursing Fundamentals 2027", new_short_name: "NURS-101-2027", acknowledge_new_course: true,
    }), { ok: false, sent: false, status: 200, error: "moodle_course_copy_enrolments_refused" });
    state.copyRoleChecked = false;
    // A category the native control does not offer is refused before anything is sent.
    assert.deepEqual(await execute(operations.copy, {
      course_id: 2, new_full_name: "Nursing Fundamentals 2027", new_short_name: "NURS-101-2027", category_id: 9, acknowledge_new_course: true,
    }), { ok: false, sent: false, status: 200, error: "moodle_course_copy_category_refused" });
    const postsBeforeCopy = posts.length;
    const copied = await execute(operations.copy, {
      course_id: 2, new_full_name: "Nursing Fundamentals 2027", new_short_name: "NURS-101-2027", acknowledge_new_course: true,
    });
    assert.equal(copied.ok, true, JSON.stringify(copied));
    assert.equal(copied.verification.status, "verified");
    assert.equal(posts.length - postsBeforeCopy, 1);
    const copyPost = posts.at(-1);
    assert.equal(copyPost.path, "/backup/copy.php");
    assert.equal(copyPost.values.get("fullname"), "Nursing Fundamentals 2027");
    assert.equal(copyPost.values.get("shortname"), "NURS-101-2027");
    assert.equal(copyPost.values.get("visible"), "0");
    assert.equal(copyPost.values.get("userdata"), "0");
    assert.equal(copyPost.values.get("idnumber"), "");
    assert.equal(copyPost.values.get("category"), "3");
    assert.equal(copyPost.values.get("startdate[day]"), "8");
    assert.equal(copyPost.values.get("submitreturn"), "Copy and return");
    assert.equal(copyPost.values.get("submitdisplay"), null);
    assert.equal(copied.data.visible, false);
    assert.equal(copied.data.learner_data_copied, false);
    assert.equal(copied.data.enrolments_kept, false);
    assert.equal(copied.data.new_id_number, "");
    assert.deepEqual(copied.data.copy, {
      source: "Nursing Fundamentals", destination: "Nursing Fundamentals 2027",
      started_at: "7 September 2026, 12:10 PM", operation: "backup", operation_id: "c1",
    });
    // A copy Moodle is already making under that name is not started again.
    assert.deepEqual(await execute(operations.copy, {
      course_id: 2, new_full_name: "Nursing Fundamentals 2027", new_short_name: "NURS-101-2028", acknowledge_new_course: true,
    }), { ok: false, sent: false, status: 200, error: "moodle_course_copy_already_in_progress" });
    // A named category and a named ID number are both sent to the native controls.
    state.copies = [];
    const placed = await execute(operations.copy, {
      course_id: 2,
      new_full_name: "Nursing Fundamentals 2029",
      new_short_name: "NURS-101-2029",
      category_id: 4,
      new_id_number: "NURS-101-2029-ID",
      acknowledge_new_course: true,
    });
    assert.equal(placed.ok, true, JSON.stringify(placed));
    assert.equal(posts.at(-1).values.get("category"), "4");
    assert.equal(posts.at(-1).values.get("idnumber"), "NURS-101-2029-ID");
    assert.equal(placed.data.category_id, "4");
    assert.equal(placed.data.new_id_number, "NURS-101-2029-ID");

    // A short name Moodle already uses is refused by the native form, and the copy
    // stays unconfirmed rather than being sent again.
    state.copies = [];
    const refused = await execute(operations.copy, {
      course_id: 2, new_full_name: "Nursing Fundamentals 2028", new_short_name: "NURS-201", acknowledge_new_course: true,
    });
    assert.deepEqual(refused, {
      ok: false, sent: true, status: 200, outcomeUnknown: true,
      verification: { schema: "morrow.browser-verification.v1", status: "unconfirmed", reason: "moodle_course_copy_refused" },
      error: "moodle_course_copy_refused",
    });

    // ---- The bound course is the only target ----
    assert.deepEqual(await execute(operations.files, { course_id: 3 }), { ok: false, sent: false, error: "moodle_backup_arguments_invalid" });
    assert.deepEqual(await execute({ ...operations.files, readOnly: false }, { course_id: 2 }), { ok: false, sent: false, error: "moodle_operation_refused" });
    assert.deepEqual(await execute(operations.files, { course_id: 2, contextid: 45 }), { ok: false, sent: false, error: "moodle_backup_arguments_invalid" });

    // Every backup route addresses the course by its context id, so a page that states
    // none of it starts nothing.
    await pageHandle.evaluate(() => { delete globalThis.M.cfg.courseContextId; });
    assert.deepEqual(await execute(operations.files, { course_id: 2 }), {
      ok: false, sent: false, error: "moodle_course_context_unavailable",
    });
    await pageHandle.evaluate((value) => { globalThis.M.cfg.courseContextId = value; }, Number(COURSE_CONTEXT_ID));

    // Nothing here loads a course page, an activity page or a backup file.
    assert.deepEqual(requests.filter((entry) => entry.startsWith("GET /course/view.php")), ["GET /course/view.php?id=2"]);
    assert.deepEqual(requests.filter((entry) => entry.includes("/pluginfile.php")), []);
    assert.deepEqual(requests.filter((entry) => /GET \/mod\//.test(entry)), []);
  } finally {
    if (context) await context.close();
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the Moodle backup, restore, import and copy routes are wired and published exactly once", () => {
  const root = new URL("../..", import.meta.url);
  const catalog = JSON.parse(readFileSync(new URL("connector/extension/generated/moodle-browser-catalog.json", root), "utf8"));
  const worker = readFileSync(new URL("connector/extension/src/service-worker.js", root), "utf8");
  const policy = readFileSync(new URL("connector/extension/src/edit-policy.js", root), "utf8");

  const keys = Object.values(operations).map((operation) => operation.key);
  const entries = keys.map((key) => catalog.operations.find((operation) => operation.key === key));
  assert.equal(entries.filter(Boolean).length, keys.length, "every routed backup key needs a catalog entry");
  assert.match(worker, /import \{ executeMoodleBackupInPage \} from "\.\/moodle-backup-executor\.js";/);
  for (const key of keys) assert.ok(worker.includes(`"${key}"`), `${key} needs a service-worker route`);
  for (const [name, operation] of Object.entries(operations)) {
    const entry = entries[keys.indexOf(operation.key)];
    assert.equal(entry.toolName, operation.toolName, name);
    assert.equal(entry.readOnly, operation.readOnly, name);
    assert.match(entry.documentation, /^https:\/\/github\.com\/moodle\/moodle\/blob\/v5\.2\.2\/public\/backup\//, name);
    if (!entry.readOnly) assert.ok(catalog.operations.some((candidate) => candidate.toolName === entry.reviewTool && candidate.readOnly), name);
  }

  const files = entries[keys.indexOf(operations.files.key)];
  assert.deepEqual(Object.keys(files.inputSchema.properties), ["course_id"]);
  assert.match(files.description, /moodle\/restore:restorecourse capability at that exact course context/);

  const progress = entries[keys.indexOf(operations.backupProgress.key)];
  assert.deepEqual(Object.keys(progress.inputSchema.properties), ["course_id", "operation_id"]);
  assert.match(progress.description, /one request/);
  assert.match(progress.description, /does not wait/);

  const backup = entries[keys.indexOf(operations.backup.key)];
  assert.equal(backup.reviewTool, "moodle_list_backup_files");
  assert.deepEqual(backup.inputSchema.required, ["course_id", "expected_digest"]);
  assert.match(backup.description, /Jump to final step/);
  assert.match(backup.description, /applied but unconfirmed/);

  const restore = entries[keys.indexOf(operations.restore.key)];
  assert.equal(restore.reviewTool, "moodle_list_backup_files");
  assert.equal(restore.destructive, true);
  assert.equal(restore.irreversible, true);
  assert.deepEqual(restore.inputSchema.required, [
    "course_id", "source_file_name", "source_file_digest", "restore_mode", "expected_digest", "acknowledge_course_change",
  ]);
  assert.deepEqual(restore.inputSchema.properties.restore_mode.enum, ["merge", "delete_and_restore"]);
  assert.deepEqual(restore.inputSchema.properties.acknowledge_delete_and_restore.enum, [true]);
  assert.match(restore.description, /restore_mode delete_and_restore, Moodle removes everything the course holds first/);
  assert.match(restore.description, /Morrow cannot undo either mode/);

  const importEntry = entries[keys.indexOf(operations.import.key)];
  assert.equal(importEntry.reviewTool, "moodle_get_contents");
  assert.deepEqual(importEntry.inputSchema.required, ["course_id", "source_course_id", "acknowledge_course_change"]);
  assert.match(importEntry.description, /does not delete anything/);

  const copy = entries[keys.indexOf(operations.copy.key)];
  assert.equal(copy.reviewTool, "moodle_get_course_settings");
  assert.deepEqual(copy.inputSchema.required, ["course_id", "new_full_name", "new_short_name", "acknowledge_new_course"]);
  assert.match(copy.description, /hidden/);
  assert.match(copy.description, /no learner data/);

  // A restore and a copy reach past the one activity they name, so both are grouped
  // and described as whole-course actions before they are granted.
  assert.match(policy, /const MOODLE_COURSE_REUSE_TOOLS = new Set\(\[/);
  assert.match(policy, /"moodle_start_course_restore"/);
  assert.match(policy, /"moodle_start_course_import"/);
  assert.match(policy, /"moodle_copy_course"/);
});
