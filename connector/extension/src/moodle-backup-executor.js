/**
 * Reads the Moodle backup and restore surface of one course, and runs the four
 * native course-reuse workflows: a course backup, a course restore, a course
 * import and a course copy.
 *
 * Each of these is a multi-step native workflow. Every step is one explicit
 * dispatch of one native route, in the order a browser takes them, and every
 * step is followed by a readback that proves which stage Moodle answered with.
 * A step whose answer is lost stays applied-or-unknown: nothing is repeated and
 * nothing later in the workflow is sent. A step Morrow refuses after a native
 * workflow already exists sends the native Cancel of that workflow once, so no
 * half-built workflow is left behind.
 *
 * Progress is read, never waited on. Each progress read makes exactly one
 * request for exactly one operation id and returns the status Moodle reports.
 *
 * A backup and a restore are only run through Moodle's asynchronous route. The
 * synchronous route runs the whole operation inside one request, and a browser
 * may resend a request whose connection drops, so Morrow refuses it.
 *
 * Chrome serializes this function for a MAIN-world injection. Keep every
 * dependency inside the function body.
 */
export async function executeMoodleBackupInPage(rawInput) {
  const PROVIDER = "moodle";
  const MAX_FORM_ENTRIES = 600;
  const MAX_FORM_BYTES = 512 * 1024;
  const MAX_VALUE_BYTES = 64 * 1024;
  const MAX_PAGE_BYTES = 4 * 1024 * 1024;
  const MAX_FILE_ROWS = 400;
  const MAX_TABLES = 12;
  const MAX_SETTING_ROWS = 200;
  const MAX_STATE_ROWS = 2_000;
  const MAX_FILE_AREAS = 20;
  const MAX_TEXT = 255;
  const ID = /^[1-9][0-9]{0,18}$/;
  const DIGEST = /^[a-f0-9]{64}$/;
  const WORKFLOW_ID = /^[a-z0-9]{1,64}$/i;
  // A session key, mform's own state fields and the per-load unique id of a
  // backup, restore or import workflow all change on every load of the same
  // page, so none of them is ever part of a digest or a result.
  const TRANSIENT_FIELD = /(?:sesskey|statekey|_qf__|csrf|token|secret|password|authorization|cookie|pathnamehash|contenthash)/i;
  const COURSE_SETTINGS_TRANSIENT_FIELD = /(?:sesskey|statekey|_qf__|csrf|token|secret|password|authorization|cookie|(?:^|[\[_-])(?:draft|itemid)(?:$|[\]_-]))/i;
  const DATE_COMPONENTS = ["year", "month", "day", "hour", "minute"];
  const WORKFLOW_FIELDS = new Set(["backup", "restore", "import"]);
  const RESTORE_FILE_PATH = "/backup/restorefile.php";
  const BACKUP_PATH = "/backup/backup.php";
  const RESTORE_PATH = "/backup/restore.php";
  const IMPORT_PATH = "/backup/import.php";
  const COPY_PATH = "/backup/copy.php";
  const COPY_PROGRESS_PATH = "/backup/copyprogress.php";
  const COURSE_VIEW_PATH = "/course/view.php";
  const COURSE_SETTINGS_PATH = "/course/edit.php";
  const AJAX_PATH = "/lib/ajax/service.php";
  const PROGRESS_METHOD = "core_backup_get_async_backup_progress";
  const STATE_METHOD = "core_courseformat_get_state";
  const ONE_CLICK_FIELD = "oneclickbackup";
  const SUBMIT_FIELD = "submitbutton";
  const CANCEL_FIELD = "cancel";
  const COPY_SUBMIT_FIELD = "submitreturn";
  const CURRENT_COURSE_SELECTOR = ".bcs-current-course";
  // Source: https://github.com/moodle/moodle/blob/v5.2.2/public/backup/backup.class.php
  const TARGET_CURRENT_DELETING = "0";
  const TARGET_CURRENT_ADDING = "1";
  const BACKUP_STAGE_INITIAL = "1";
  const RESTORE_STAGE_DESTINATION = "2";
  const RESTORE_STAGE_SETTINGS = "4";
  const RESTORE_STAGE_SCHEMA = "8";
  const RESTORE_STAGE_REVIEW = "16";
  // backup::STATUS_*, with the name Morrow reports for each one.
  const STATUS_STATES = new Map([
    [100, "preparing"], [200, "preparing"], [300, "preparing"], [400, "preparing"],
    [500, "preparing"], [600, "preparing"], [700, "queued"], [800, "running"],
    [900, "failed"], [1000, "complete"],
  ]);
  const RESTORE_MODES = new Map([
    ["merge", TARGET_CURRENT_ADDING],
    ["delete_and_restore", TARGET_CURRENT_DELETING],
  ]);
  const definitions = Object.freeze({
    "moodle.form.backup.restorefile.index.read.v1": { toolName: "moodle_list_backup_files", readOnly: true, kind: "files" },
    "moodle.ajax.core_backup.async_progress.backup.read.v1": { toolName: "moodle_get_backup_progress", readOnly: true, kind: "progress", operation: "backup" },
    "moodle.ajax.core_backup.async_progress.restore.read.v1": { toolName: "moodle_get_restore_progress", readOnly: true, kind: "progress", operation: "restore" },
    "moodle.form.backup.backup.course.write.v1": { toolName: "moodle_start_course_backup", readOnly: false, kind: "backup" },
    "moodle.form.backup.restore.course.write.v1": { toolName: "moodle_start_course_restore", readOnly: false, kind: "restore" },
    "moodle.form.backup.import.course.write.v1": { toolName: "moodle_start_course_import", readOnly: false, kind: "import" },
    "moodle.form.backup.copy.course.write.v1": { toolName: "moodle_copy_course", readOnly: false, kind: "copy" },
  });
  const CAPABILITIES = Object.freeze({
    files: "moodle/restore:restorecourse",
    progress: "moodle/backup:backupcourse",
    backup: "moodle/backup:backupcourse",
    restore: "moodle/restore:restorecourse",
    import: "moodle/restore:restoretargetimport at the target course with moodle/backup:backuptargetimport at the source course",
    copy: "moodle/backup:backupcourse with moodle/restore:restorecourse and moodle/course:create",
  });
  const parseInput = () => {
    if (typeof rawInput !== "string") return rawInput;
    try { return JSON.parse(rawInput); } catch { return null; }
  };
  const input = parseInput();
  const failure = (error, status) => ({ ok: false, sent: false, ...(Number.isInteger(status) ? { status } : {}), error });
  const unconfirmedWrite = (error, status) => ({
    ok: false,
    sent: true,
    ...(Number.isInteger(status) ? { status } : {}),
    outcomeUnknown: true,
    verification: { schema: "morrow.browser-verification.v1", status: "unconfirmed", reason: error },
    error,
  });
  const object = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
  const id = (value) => {
    const text = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : typeof value === "string" ? value : "";
    return ID.test(text) ? text : "";
  };
  const validText = (value, maximum = MAX_TEXT) => typeof value === "string" && value.length > 0 && value.length <= maximum
    && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
  const validOptionalText = (value, maximum = MAX_TEXT) => value === "" || validText(value, maximum);
  const collapsed = (value, maximum = MAX_TEXT) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, maximum);
  const stable = (value) => {
    if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
    if (object(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
    return JSON.stringify(value === undefined ? null : value);
  };
  const digest = async (value) => {
    if (!globalThis.crypto?.subtle || typeof globalThis.TextEncoder !== "function") throw new Error("moodle_backup_digest_unavailable");
    const bytes = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(stable(value)));
    return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
  };
  const redact = (value) => value.replace(/([?&](?:sesskey|token|csrf|password|secret|pathnamehash|contenthash)=)[^&#\s]+/gi, "$1[redacted]");
  const sanitize = (value, depth = 0) => {
    if (depth > 16) return null;
    if (Array.isArray(value)) return value.slice(0, MAX_STATE_ROWS).map((entry) => sanitize(entry, depth + 1));
    if (!object(value)) return typeof value === "string" ? redact(value.slice(0, MAX_VALUE_BYTES)) : value;
    const output = {};
    for (const [key, child] of Object.entries(value)) {
      if (TRANSIENT_FIELD.test(key)) continue;
      output[key] = sanitize(child, depth + 1);
    }
    return output;
  };
  const currentContext = () => {
    const cfg = globalThis.M?.cfg;
    if (!object(cfg) || typeof cfg.wwwroot !== "string" || !validText(cfg.sesskey, 1024)) return null;
    const principalId = id(cfg.userId);
    if (!principalId) return null;
    let site;
    try { site = new URL(cfg.wwwroot); } catch { return null; }
    if (site.protocol !== "https:" || site.search || site.hash || site.username || site.password) return null;
    const currentOrigin = String(globalThis.location?.origin || "");
    const currentPath = String(globalThis.location?.pathname || "");
    const basePath = site.pathname.replace(/\/$/, "");
    if (site.origin !== currentOrigin || !(currentPath === basePath || currentPath.startsWith(`${basePath}/`))) return null;
    const configuredCourse = id(cfg.courseId);
    const bodyCourse = String(globalThis.document?.body?.className || "").match(/(?:^|\s)course-([1-9][0-9]*)(?:\s|$)/)?.[1] || "";
    if (configuredCourse && bodyCourse && bodyCourse !== configuredCourse) return null;
    const anchorCourseId = configuredCourse || bodyCourse;
    if (!anchorCourseId) return null;
    return {
      origin: site.origin,
      siteUrl: site.href,
      basePath,
      principalId,
      anchorCourseId,
      sesskey: cfg.sesskey,
      // Every backup route addresses the course by its context id, not by its
      // course id. This is the page's own statement about itself.
      courseContextId: id(cfg.courseContextId),
    };
  };
  const sameContext = (left, right) => left?.origin === right?.origin && left?.siteUrl === right?.siteUrl
    && left?.basePath === right?.basePath && left?.principalId === right?.principalId
    && left?.anchorCourseId === right?.anchorCourseId && left?.sesskey === right?.sesskey
    && left?.courseContextId === right?.courseContextId;
  const bindingValid = (context, binding) => object(binding) && binding.origin === context.origin && binding.siteUrl === context.siteUrl
    && id(binding.principalId) === context.principalId && id(binding.courseId) === context.anchorCourseId;
  const expectedOperation = (operation) => {
    if (!object(operation) || typeof operation.key !== "string") return null;
    const definition = definitions[operation.key];
    return definition && operation.provider === PROVIDER && operation.toolName === definition.toolName
      && operation.readOnly === definition.readOnly ? definition : null;
  };
  const urlFor = (context, path, params) => {
    const url = new URL(context.siteUrl);
    url.pathname = `${context.basePath}${path}`;
    url.search = new URLSearchParams(params).toString();
    url.hash = "";
    return url;
  };
  const sortedParams = (url) => [...url.searchParams.entries()]
    .sort(([leftName, leftValue], [rightName, rightValue]) => leftName.localeCompare(rightName) || leftValue.localeCompare(rightValue));
  const sameRoute = (value, expected) => {
    let received;
    try { received = new URL(value); } catch { return false; }
    if (received.origin !== expected.origin || received.pathname !== expected.pathname || received.hash
      || received.username || received.password) return false;
    return stable(sortedParams(received)) === stable(sortedParams(expected));
  };
  const samePath = (value, context, path) => {
    let received;
    try { received = new URL(value); } catch { return null; }
    if (received.origin !== context.origin || received.pathname !== `${context.basePath}${path}`
      || received.hash || received.username || received.password) return null;
    return received;
  };

  /**
   * Every native request this executor makes is recorded here, in order, with
   * the route it addressed. The record is the evidence that each step of a
   * workflow was dispatched exactly once.
   */
  const steps = [];
  let writeAttempted = false;
  const record = (step, method, path, status) => {
    steps.push({ step, method, route: path, ...(Number.isInteger(status) ? { status } : {}) });
    return status;
  };
  const live = () => Number.isFinite(input?.expiresAt) && Date.now() < input.expiresAt;

  const readPage = async (context, endpoint, step, code) => {
    if (!live()) return { error: "moodle_execution_expired" };
    let response;
    try {
      response = await fetch(endpoint, { method: "GET", credentials: "include", cache: "no-store", redirect: "error", headers: { Accept: "text/html" } });
    } catch { record(step, "GET", endpoint.pathname); return { error: code }; }
    record(step, "GET", endpoint.pathname, response.status);
    if (!response.ok || !sameRoute(response.url, endpoint) || !sameContext(context, currentContext())) {
      return { error: code, status: response.status };
    }
    let html;
    try { html = await response.text(); } catch { return { error: code, status: response.status }; }
    if (typeof html !== "string" || html.length > MAX_PAGE_BYTES || typeof globalThis.DOMParser !== "function") {
      return { error: code, status: response.status };
    }
    try { return { status: response.status, document: new DOMParser().parseFromString(html, "text/html") }; }
    catch { return { error: code, status: response.status }; }
  };
  /**
   * A native link Moodle answers with a redirect to one other named route. The
   * browser follows that one redirect, exactly as it does when a person clicks
   * the link, and Morrow refuses any landing place other than `landingPath`.
   */
  const followLink = async (context, endpoint, landingPath, step, code) => {
    if (!live()) return { error: "moodle_execution_expired" };
    let response;
    try {
      response = await fetch(endpoint, { method: "GET", credentials: "include", cache: "no-store", redirect: "follow", headers: { Accept: "text/html" } });
    } catch { record(step, "GET", endpoint.pathname); return { error: code }; }
    record(step, "GET", endpoint.pathname, response.status);
    const landed = samePath(response.url, context, landingPath);
    if (!response.ok || !landed || !sameContext(context, currentContext())) return { error: code, status: response.status };
    let html;
    try { html = await response.text(); } catch { return { error: code, status: response.status }; }
    if (typeof html !== "string" || html.length > MAX_PAGE_BYTES || typeof globalThis.DOMParser !== "function") {
      return { error: code, status: response.status };
    }
    try { return { status: response.status, url: landed, document: new DOMParser().parseFromString(html, "text/html") }; }
    catch { return { error: code, status: response.status }; }
  };
  const one = (values, expected) => values.length === 1 && values[0] === expected;
  const valuesOf = (entries, name) => entries.filter(([field]) => field === name).map(([, value]) => value);
  const currentText = (entries, name) => {
    const values = valuesOf(entries, name);
    return values.length ? values[values.length - 1] : "";
  };
  const namedControls = (form, name) => [...form.querySelectorAll("[name]")].filter((control) => control.getAttribute("name") === name);
  const entriesFor = (form) => {
    let values;
    try { values = [...new FormData(form).entries()]; } catch { return null; }
    if (values.length > MAX_FORM_ENTRIES) return null;
    let size = 0;
    const entries = [];
    for (const [name, value] of values) {
      if (typeof name !== "string" || name.length < 1 || name.length > 255 || typeof value !== "string" || value.length > MAX_VALUE_BYTES) return null;
      size += name.length + value.length;
      if (size > MAX_FORM_BYTES) return null;
      entries.push([name, value]);
    }
    return entries;
  };
  const optionsOf = (form, name) => {
    const selects = namedControls(form, name).filter((control) => control.tagName === "SELECT");
    if (selects.length !== 1 || selects[0].disabled) return null;
    return [...selects[0].options].map((option) => String(option.value ?? ""));
  };
  const offersOption = (form, name, value) => Boolean(optionsOf(form, name)?.includes(value));
  const writableText = (form, name) => {
    const controls = namedControls(form, name);
    const editable = controls.filter((control) => control.tagName === "INPUT"
      && ["", "text", "number"].includes(String(control.getAttribute("type") || "").toLowerCase()));
    return controls.length === 1 && editable.length === 1 && !editable[0].disabled && !editable[0].readOnly;
  };
  const submitValue = (form, name) => {
    const controls = [...form.querySelectorAll(`input[type="submit"][name="${name}"]`)]
      .filter((control) => !control.disabled && typeof control.value === "string" && control.value && control.value.length <= 500);
    return controls.length === 1 ? controls[0].value : "";
  };
  const radioValues = (form, name) => namedControls(form, name)
    .filter((control) => control.tagName === "INPUT" && String(control.getAttribute("type") || "").toLowerCase() === "radio" && !control.disabled)
    .map((control) => String(control.value ?? ""));
  const postForms = (documentValue, context, path) => [...documentValue.querySelectorAll("form")].filter((form) => {
    if (String(form.getAttribute("method") || "").toLowerCase() !== "post") return false;
    const action = form.getAttribute("action");
    if (!action) return false;
    let resolved;
    try { resolved = new URL(action, context.siteUrl); } catch { return false; }
    return resolved.origin === context.origin && resolved.pathname === `${context.basePath}${path}`;
  });
  /**
   * The digest preimage of one native form: every control it carries except the
   * session key, mform's own state fields, and the per-load unique id of the
   * workflow, none of which is the same on two loads of the same page.
   */
  const snapshotEntries = (entries) => entries
    .filter(([name]) => !TRANSIENT_FIELD.test(name) && !WORKFLOW_FIELDS.has(name))
    .map(([name, value]) => [name, value]);

  /**
   * One native form, loaded and checked. `expect` names the exact hidden values
   * this stage of the workflow must carry, so a page that answered for another
   * stage or another workflow is refused before anything is sent. `endpoint`,
   * when given, is the exact address the form must post back to.
   */
  const formState = (documentValue, context, path, expect, endpoint) => {
    const forms = postForms(documentValue, context, path).filter((form) => {
      const entries = entriesFor(form);
      if (!entries) return false;
      return Object.entries(expect).every(([name, value]) => (value === null
        ? valuesOf(entries, name).length === 1 && WORKFLOW_ID.test(currentText(entries, name))
        : one(valuesOf(entries, name), value)));
    });
    if (forms.length !== 1) return null;
    const entries = entriesFor(forms[0]);
    if (!entries || !one(valuesOf(entries, "sesskey"), context.sesskey)) return null;
    let action;
    try { action = new URL(forms[0].getAttribute("action") || "", context.siteUrl); } catch { return null; }
    if (endpoint && !sameRoute(action.href, endpoint)) return null;
    return { form: forms[0], entries, action: action.href };
  };

  /**
   * One POST of one loaded native form. Every control the form carries is sent
   * back unchanged except the ones this step names. The dispatch is recorded
   * before the request leaves, so an answer that never arrives is still counted
   * as sent.
   */
  const postForm = async (context, state, changes, step, code, expectRedirect) => {
    const preflight = currentContext();
    if (!sameContext(context, preflight)) return { error: "moodle_form_session_mismatch" };
    if (!live()) return { error: "moodle_execution_expired" };
    const body = new URLSearchParams();
    const carried = new Set();
    for (const [field, value] of state.entries) {
      if (!changes.has(field)) { body.append(field, value); continue; }
      if (carried.has(field)) continue;
      carried.add(field);
      for (const replacement of changes.get(field) || []) body.append(field, replacement);
    }
    for (const [field, values] of changes) if (!carried.has(field)) for (const value of values || []) body.append(field, value);
    let response;
    let path;
    try { path = new URL(state.action).pathname; } catch { path = state.action; }
    try {
      writeAttempted = true;
      response = await fetch(state.action, {
        method: "POST",
        credentials: "include",
        cache: "no-store",
        redirect: expectRedirect ? "manual" : "error",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "text/html" },
        body,
      });
    } catch { record(step, "POST", path); return { unconfirmed: code }; }
    record(step, "POST", path, response.status);
    if (!sameContext(context, currentContext())) return { unconfirmed: code, status: response.status };
    if (expectRedirect) {
      // Chromium exposes a manual same-origin POST redirect as opaqueredirect.
      // The browser does not follow it, so Morrow never loads the page the
      // native form redirects to.
      if (response.type === "opaqueredirect") return { sent: true, redirected: true };
      if (![301, 302, 303, 307, 308].includes(response.status)) return { sent: true, redirected: false, status: response.status };
      let location;
      try { location = new URL(response.headers.get("location") || "", state.action); } catch { return { unconfirmed: code, status: response.status }; }
      return { sent: true, redirected: true, location, status: response.status };
    }
    if (!response.ok || !sameRoute(response.url, new URL(state.action))) return { unconfirmed: code, status: response.status };
    let html;
    try { html = await response.text(); } catch { return { unconfirmed: code, status: response.status }; }
    if (typeof html !== "string" || html.length > MAX_PAGE_BYTES || typeof globalThis.DOMParser !== "function") {
      return { unconfirmed: code, status: response.status };
    }
    try { return { sent: true, status: response.status, document: new DOMParser().parseFromString(html, "text/html") }; }
    catch { return { unconfirmed: code, status: response.status }; }
  };

  /**
   * The native Cancel of a workflow Morrow started and then refused to finish.
   * Moodle answers a cancelled workflow with a redirect to the course page, and
   * Morrow never follows it. Cancel changes no course, so it is safe after a
   * refusal; it is never sent after a step whose outcome is unknown.
   */
  const cancelWorkflow = async (context, state, courseId, step) => {
    const value = submitValue(state.form, CANCEL_FIELD);
    if (!value) return false;
    const posted = await postForm(context, state, new Map([[CANCEL_FIELD, [value]]]), step, "moodle_backup_cancel_unconfirmed", true);
    if (posted.unconfirmed || !posted.location) return posted.redirected === true;
    return sameRoute(posted.location.href, urlFor(context, COURSE_VIEW_PATH, { id: courseId }));
  };

  // ---- The backup file listing, which is also the reviewed state ----

  const tableRows = (table) => {
    const heads = [...table.querySelectorAll("thead th")].length;
    const rows = [...table.querySelectorAll("tbody tr")].map((row) => [...row.querySelectorAll("td")]);
    return { heads, rows };
  };
  const chooseParams = (cells, context) => {
    for (const cell of cells) {
      for (const anchor of cell.querySelectorAll("a[href]")) {
        let href;
        try { href = new URL(anchor.getAttribute("href") || "", context.siteUrl).href; } catch { continue; }
        const target = samePath(href, context, RESTORE_FILE_PATH);
        if (target && target.searchParams.get("action") === "choosebackupfile") return target;
      }
    }
    return null;
  };
  const asyncHandle = (cells) => {
    for (const cell of cells) {
      const marker = cell.querySelector("[data-backupid]");
      const value = String(marker?.getAttribute("data-backupid") || "");
      if (WORKFLOW_ID.test(value)) return value;
    }
    return "";
  };
  const readBackupFiles = async (context, courseId, step) => {
    const endpoint = urlFor(context, RESTORE_FILE_PATH, { contextid: context.courseContextId });
    const page = await readPage(context, endpoint, step, "moodle_backup_files_unavailable");
    if (page.error) return { error: page.error, status: page.status };
    const tables = [...page.document.querySelectorAll("table.backup-files-table")];
    if (tables.length === 0 || tables.length > MAX_TABLES) return { error: "moodle_backup_files_unavailable", status: page.status };
    const files = [];
    let restoresInProgress = 0;
    // Moodle adds the Status column to every backup file table, and the
    // in-progress restore table to this page, only while the site runs backups
    // and restores as scheduled tasks. That column is the page's own statement
    // that the asynchronous route is the one in use.
    let asynchronous = false;
    for (const table of tables) {
      const { heads, rows } = tableRows(table);
      if (heads < 5) { restoresInProgress += rows.length; continue; }
      if (heads >= 6) asynchronous = true;
      let area = "";
      const parsed = [];
      for (const cells of rows) {
        if (cells.length < 5) return { error: "moodle_backup_files_unavailable", status: page.status };
        const target = chooseParams(cells, context);
        if (target && !area) area = collapsed(target.searchParams.get("filearea") || "", 40);
        parsed.push({
          fileName: collapsed(cells[0]?.textContent, MAX_TEXT),
          savedAt: collapsed(cells[1]?.textContent, MAX_TEXT),
          size: collapsed(cells[2]?.textContent, 40),
          target,
          operationId: asyncHandle(cells.slice(5)),
        });
      }
      for (const row of parsed) {
        if (!row.fileName) return { error: "moodle_backup_files_unavailable", status: page.status };
        files.push({
          area,
          file_name: row.fileName,
          saved_at: row.savedAt,
          size: row.size,
          restorable: Boolean(row.target),
          in_progress: !row.target && Boolean(row.operationId),
          ...(row.operationId ? { operation_id: row.operationId } : {}),
          target: row.target,
        });
      }
      if (files.length > MAX_FILE_ROWS) return { error: "moodle_backup_files_too_many", status: page.status };
    }
    const listed = files.map((file) => {
      const { target, ...rest } = file;
      return rest;
    });
    for (const [index, file] of files.entries()) {
      listed[index].file_digest = await digest({
        courseId,
        contextId: context.courseContextId,
        area: file.area,
        fileName: file.file_name,
        // The exact native parameters of this file's own Restore link, which
        // are the only way to name it again on a later load. They stay in the
        // browser; what leaves is this digest.
        chooser: file.target ? sortedParams(file.target) : null,
      });
    }
    const data = {
      course_id: courseId,
      asynchronous,
      files: listed,
      restores_in_progress: restoresInProgress,
      backups_in_progress: listed.filter((file) => file.in_progress).length,
      proof: { method: "native_form_read", route: RESTORE_FILE_PATH, required_capability: CAPABILITIES.files, scope: "course_backup_file_areas_only" },
    };
    return {
      status: page.status,
      data,
      files,
      snapshotDigest: await digest({
        courseId,
        asynchronous,
        restoresInProgress,
        files: listed.map((file) => [file.area, file.file_name, file.saved_at, file.size, file.restorable, file.in_progress]),
      }),
    };
  };

  // ---- The complete course state, used as the before and after of an import ----

  /**
   * Source:
   * https://github.com/moodle/moodle/blob/v5.2.2/public/course/format/classes/external/get_state.php
   * It saves no course or learner state.
   */
  const courseState = async (context, courseId, step) => {
    if (!live()) return { error: "moodle_execution_expired" };
    const endpoint = urlFor(context, AJAX_PATH, { sesskey: context.sesskey, info: STATE_METHOD });
    let response;
    try {
      response = await fetch(endpoint, {
        method: "POST", credentials: "include", cache: "no-store",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify([{ index: 0, methodname: STATE_METHOD, args: { courseid: Number(courseId) } }]),
      });
    } catch { record(step, "POST", endpoint.pathname); return { error: "moodle_course_state_unavailable" }; }
    record(step, "POST", endpoint.pathname, response.status);
    let payload;
    try { payload = JSON.parse(await response.text()); } catch { return { error: "moodle_course_state_unavailable", status: response.status }; }
    const entry = Array.isArray(payload) && payload.length === 1 && object(payload[0]) ? payload[0] : null;
    if (!response.ok || !entry || entry.error || entry.exception || typeof entry.data !== "string") {
      return { error: "moodle_course_state_unavailable", status: response.status };
    }
    let value;
    try { value = JSON.parse(entry.data); } catch { return { error: "moodle_course_state_unavailable", status: response.status }; }
    if (!object(value) || !object(value.course) || id(value.course.id) !== courseId
      || !Array.isArray(value.section) || !Array.isArray(value.cm)) return { error: "moodle_course_state_unavailable", status: response.status };
    if (value.section.length > MAX_STATE_ROWS || value.cm.length > MAX_STATE_ROWS) return { error: "moodle_course_state_incomplete", status: response.status };
    const data = {
      course: sanitize(value.course),
      sections: value.section.map((section) => sanitize(section)),
      activities: value.cm.map((activity) => sanitize(activity)),
    };
    return { data, status: response.status, digest: await digest(data) };
  };

  /**
   * The exact digest preimage used by moodle_get_course_settings. Copy creates
   * a new course, but its approval still binds the complete source-course
   * settings form and every file area that form carries.
   */
  const courseSettingsDigest = async (context, courseId, step) => {
    const endpoint = urlFor(context, COURSE_SETTINGS_PATH, { id: courseId });
    const page = await readPage(context, endpoint, step, "moodle_course_settings_read_unavailable");
    if (page.error) return page;
    const forms = [...page.document.querySelectorAll("form")].filter((form) => {
      if (String(form.getAttribute("method") || "").toLowerCase() !== "post") return false;
      const action = form.getAttribute("action");
      if (!action) return false;
      try { return sameRoute(new URL(action, endpoint).href, endpoint); } catch { return false; }
    });
    if (forms.length !== 1) return { error: "moodle_course_settings_form_invalid", status: page.status };
    const form = forms[0];
    const entries = entriesFor(form);
    if (!entries || !one(valuesOf(entries, "id"), courseId) || !one(valuesOf(entries, "sesskey"), context.sesskey)) {
      return { error: "moodle_course_settings_form_invalid", status: page.status };
    }
    const draftItemId = (value) => typeof value === "string" && ID.test(value) ? value : "";
    const readDraftListing = async (itemId) => {
      let response;
      try {
        response = await fetch(urlFor(context, "/repository/draftfiles_ajax.php", { action: "list" }), {
          method: "POST", credentials: "include", cache: "no-store",
          headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
          body: new URLSearchParams({ sesskey: context.sesskey, itemid: itemId, filepath: "/" }),
        });
      } catch { return null; }
      if (!response.ok) return null;
      try {
        const payload = JSON.parse(await response.text());
        return object(payload) ? payload : null;
      } catch { return null; }
    };
    const names = new Set();
    for (const control of form.querySelectorAll('[data-fieldtype="filemanager"] input[type="hidden"][name]')) {
      const name = String(control.getAttribute("name") || "");
      if (name) names.add(name);
    }
    for (const [name] of entries) if (/\[itemid\]$/.test(name)) names.add(name);
    if (names.size > MAX_FILE_AREAS) return { error: "moodle_course_settings_form_invalid", status: page.status };
    const areas = new Map();
    for (const name of names) {
      const values = valuesOf(entries, name);
      const itemId = values.length === 1 ? draftItemId(values[0]) : "";
      const listing = itemId ? await readDraftListing(itemId) : null;
      const state = !listing || !Number.isSafeInteger(listing.filecount) || listing.filecount < 0 || !Array.isArray(listing.list)
        ? "unverified" : listing.filecount === 0 && listing.list.length === 0 ? "empty" : "nonempty";
      areas.set(name, state);
    }
    const ignored = new Set();
    const disabled = [];
    for (const control of form.querySelectorAll('input[type="checkbox"][name$="[enabled]"]')) {
      if (control.checked) continue;
      const name = String(control.getAttribute("name") || "");
      const prefix = name.slice(0, -"[enabled]".length);
      if (!prefix) continue;
      disabled.push(name);
      for (const component of DATE_COMPONENTS) ignored.add(`${prefix}[${component}]`);
      ignored.add(name);
    }
    const snapshot = [];
    for (const [name, value] of entries) {
      if (areas.has(name)) { snapshot.push([name, `file_area:${areas.get(name)}`]); continue; }
      if (ignored.has(name) || COURSE_SETTINGS_TRANSIENT_FIELD.test(name)) continue;
      snapshot.push([name, value]);
    }
    for (const name of disabled) snapshot.push([name, "0"]);
    return { status: page.status, digest: await digest({ courseId, entries: snapshot }) };
  };

  // ---- Progress, read once ----

  const readProgress = async (context, operationId, wanted) => {
    if (!live()) return failure("moodle_execution_expired");
    const endpoint = urlFor(context, AJAX_PATH, { sesskey: context.sesskey, info: PROGRESS_METHOD });
    let response;
    try {
      response = await fetch(endpoint, {
        method: "POST", credentials: "include", cache: "no-store",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify([{
          index: 0,
          methodname: PROGRESS_METHOD,
          args: { backupids: [operationId], contextid: Number(context.courseContextId) },
        }]),
      });
    } catch { record("progress", "POST", endpoint.pathname); return failure("moodle_backup_progress_unavailable"); }
    record("progress", "POST", endpoint.pathname, response.status);
    let payload;
    try { payload = JSON.parse(await response.text()); } catch { return failure("moodle_backup_progress_unavailable", response.status); }
    const entry = Array.isArray(payload) && payload.length === 1 && object(payload[0]) ? payload[0] : null;
    if (!response.ok || !entry || entry.error || entry.exception || !Array.isArray(entry.data) || entry.data.length !== 1) {
      return failure("moodle_backup_progress_unavailable", response.status);
    }
    const row = object(entry.data[0]) ? entry.data[0] : null;
    const state = row && Number.isInteger(row.status) ? STATUS_STATES.get(row.status) : undefined;
    if (!row || !state || String(row.backupid || "") !== operationId || typeof row.progress !== "number"
      || !Number.isFinite(row.progress) || row.progress < 0 || row.progress > 1) {
      return failure("moodle_backup_progress_invalid", response.status);
    }
    if (String(row.operation || "") !== wanted) return failure("moodle_backup_progress_operation_mismatch", response.status);
    return {
      ok: true,
      sent: true,
      status: response.status,
      data: {
        operation_id: operationId,
        operation: wanted,
        status_code: row.status,
        state,
        progress: row.progress,
        finished: state === "complete" || state === "failed",
        polled_once: true,
        proof: {
          method: "native_ajax_read",
          route: `${AJAX_PATH}?info=${PROGRESS_METHOD}`,
          required_capability: CAPABILITIES.progress,
          scope: "one_operation_id_one_request",
        },
      },
    };
  };

  // ---- Arguments ----

  const exactKeys = (args, keys) => object(args) && Object.keys(args).length === keys.length && keys.every((key) => Object.hasOwn(args, key));
  const argumentsFor = (definition, args, binding) => {
    const courseId = id(binding?.courseId);
    if (!courseId) return null;
    if (definition.kind === "files") {
      return exactKeys(args, ["course_id"]) && id(args.course_id) === courseId ? { courseId } : null;
    }
    if (definition.kind === "progress") {
      if (!exactKeys(args, ["course_id", "operation_id"]) || id(args.course_id) !== courseId) return null;
      return typeof args.operation_id === "string" && WORKFLOW_ID.test(args.operation_id)
        ? { courseId, operationId: args.operation_id } : null;
    }
    if (definition.kind === "backup") {
      if (!exactKeys(args, ["course_id", "expected_digest"]) || id(args.course_id) !== courseId) return null;
      return DIGEST.test(String(args.expected_digest || "")) ? { courseId, expectedDigest: args.expected_digest } : null;
    }
    if (definition.kind === "import") {
      if (!exactKeys(args, ["course_id", "source_course_id", "acknowledge_course_change", "expected_digest"]) || id(args.course_id) !== courseId) return null;
      const sourceCourseId = id(args.source_course_id);
      if (!sourceCourseId || sourceCourseId === courseId || args.acknowledge_course_change !== true
        || !DIGEST.test(String(args.expected_digest || ""))) return null;
      return { courseId, sourceCourseId, expectedDigest: args.expected_digest };
    }
    if (definition.kind === "copy") {
      const optional = ["category_id", "new_id_number"];
      const required = ["course_id", "new_full_name", "new_short_name", "acknowledge_new_course", "expected_digest"];
      const allowed = new Set([...required, ...optional]);
      if (!object(args) || Object.keys(args).some((key) => !allowed.has(key)) || required.some((key) => !Object.hasOwn(args, key))) return null;
      if (id(args.course_id) !== courseId || args.acknowledge_new_course !== true || !DIGEST.test(String(args.expected_digest || ""))) return null;
      if (!validText(args.new_full_name, 254) || !validText(args.new_short_name, 100)) return null;
      const categoryId = args.category_id === undefined ? "" : id(args.category_id);
      if (args.category_id !== undefined && !categoryId) return null;
      const idNumber = args.new_id_number === undefined ? "" : args.new_id_number;
      if (!validOptionalText(idNumber, 100)) return null;
      return { courseId, fullName: args.new_full_name, shortName: args.new_short_name, categoryId, idNumber, expectedDigest: args.expected_digest };
    }
    const modes = [...RESTORE_MODES.keys()];
    if (!object(args) || typeof args.restore_mode !== "string" || !modes.includes(args.restore_mode)) return null;
    const deleting = args.restore_mode === "delete_and_restore";
    const keys = ["course_id", "source_file_name", "source_file_digest", "restore_mode", "expected_digest", "acknowledge_course_change",
      ...(deleting ? ["acknowledge_delete_and_restore"] : [])];
    if (!exactKeys(args, keys) || id(args.course_id) !== courseId) return null;
    if (!validText(args.source_file_name, MAX_TEXT) || !DIGEST.test(String(args.source_file_digest || ""))
      || !DIGEST.test(String(args.expected_digest || "")) || args.acknowledge_course_change !== true) return null;
    if (deleting && args.acknowledge_delete_and_restore !== true) return null;
    return {
      courseId,
      sourceFileName: args.source_file_name,
      sourceFileDigest: args.source_file_digest,
      mode: args.restore_mode,
      target: RESTORE_MODES.get(args.restore_mode),
      expectedDigest: args.expected_digest,
    };
  };

  // ---- The four native workflows ----

  const settingsSent = (entries) => snapshotEntries(entries)
    .filter(([name]) => name !== ONE_CLICK_FIELD && name !== SUBMIT_FIELD && name !== CANCEL_FIELD)
    .slice(0, MAX_SETTING_ROWS)
    .map(([name, value]) => ({ name, value: collapsed(value, 200) }));
  const fileKey = (file) => `${file.area}\u0000${file.file_name}`;
  const addedFiles = (before, after) => {
    const known = new Set(before.map(fileKey));
    return after.filter((file) => !known.has(fileKey(file)));
  };

  const runCourseBackup = async (context, args) => {
    const before = await readBackupFiles(context, args.courseId, "read_backup_files_before");
    if (before.error) return failure(before.error, before.status);
    if (before.snapshotDigest !== args.expectedDigest) return failure("moodle_expected_digest_mismatch", before.status);
    if (!before.data.asynchronous) return failure("moodle_backup_asynchronous_required", before.status);
    if (before.data.backups_in_progress > 0) return failure("moodle_backup_already_in_progress", before.status);

    const endpoint = urlFor(context, BACKUP_PATH, { id: args.courseId });
    const page = await readPage(context, endpoint, "load_backup_form", "moodle_backup_form_unavailable");
    if (page.error) return failure(page.error, page.status);
    const state = formState(page.document, context, BACKUP_PATH, { stage: BACKUP_STAGE_INITIAL, backup: null }, endpoint);
    if (!state) return failure("moodle_backup_form_invalid", page.status);
    // Moodle's own Jump to final step, which runs the backup with the settings
    // this form already carries. It is the only step this operation sends.
    const jump = submitValue(state.form, ONE_CLICK_FIELD);
    if (!jump) return failure("moodle_backup_form_invalid", page.status);

    const posted = await postForm(context, state, new Map([[ONE_CLICK_FIELD, [jump]]]), "start_backup", "moodle_backup_start_unconfirmed", false);
    if (posted.error) return failure(posted.error, posted.status);
    if (posted.unconfirmed) return unconfirmedWrite(posted.unconfirmed, posted.status);

    const after = await readBackupFiles(context, args.courseId, "read_backup_files_after");
    if (after.error) return unconfirmedWrite("moodle_backup_readback_unconfirmed", posted.status);
    const added = addedFiles(before.data.files, after.data.files);
    const lost = addedFiles(after.data.files, before.data.files);
    if (added.length !== 1 || lost.length !== 0) return unconfirmedWrite("moodle_backup_start_not_verified", posted.status);
    return {
      ok: true,
      sent: true,
      status: posted.status ?? after.status,
      data: {
        course_id: args.courseId,
        backup_file_name: added[0].file_name,
        backup_area: added[0].area,
        in_progress: added[0].in_progress === true,
        ...(added[0].operation_id ? { operation_id: added[0].operation_id } : {}),
        settings_sent: settingsSent(state.entries),
        files: after.data.files,
        steps,
        proof: {
          method: "native_form_write",
          route: BACKUP_PATH,
          required_capability: CAPABILITIES.backup,
          scope: "one_course_backup_file",
          reversible_by_morrow: false,
        },
      },
      snapshot_digest: after.snapshotDigest,
      verification: { schema: "morrow.browser-verification.v1", status: "verified" },
    };
  };

  const runCourseImport = async (context, args) => {
    const before = await courseState(context, args.courseId, "read_course_state_before");
    if (before.error) return failure(before.error, before.status);
    if (before.digest !== args.expectedDigest) return failure("moodle_expected_digest_mismatch", before.status);

    const endpoint = urlFor(context, IMPORT_PATH, { id: args.courseId, importid: args.sourceCourseId });
    const page = await readPage(context, endpoint, "load_import_form", "moodle_import_form_unavailable");
    if (page.error) return failure(page.error, page.status);
    // The import form must name the exact source course and the merging target
    // Moodle uses by default, and it must post back to the exact target course.
    // Morrow has no import that deletes the target.
    const state = formState(page.document, context, IMPORT_PATH, {
      stage: BACKUP_STAGE_INITIAL, backup: null, importid: args.sourceCourseId, target: TARGET_CURRENT_ADDING,
    }, urlFor(context, IMPORT_PATH, { id: args.courseId }));
    if (!state) return failure("moodle_import_form_invalid", page.status);
    const jump = submitValue(state.form, ONE_CLICK_FIELD);
    if (!jump) return failure("moodle_import_form_invalid", page.status);

    // The target course is read once more immediately before the one step, so
    // an import never runs against a course that changed after it was reviewed.
    const fresh = await courseState(context, args.courseId, "read_course_state_fresh");
    if (fresh.error) return failure(fresh.error, fresh.status);
    if (fresh.digest !== args.expectedDigest || fresh.digest !== before.digest) {
      const cancelled = await cancelWorkflow(context, state, args.courseId, "cancel_import");
      return { ...failure("moodle_import_course_changed", fresh.status), workflow_cancelled: cancelled };
    }

    const posted = await postForm(context, state, new Map([[ONE_CLICK_FIELD, [jump]]]), "run_import", "moodle_import_unconfirmed", false);
    if (posted.error) return failure(posted.error, posted.status);
    if (posted.unconfirmed) return unconfirmedWrite(posted.unconfirmed, posted.status);

    const after = await courseState(context, args.courseId, "read_course_state_after");
    if (after.error) return unconfirmedWrite("moodle_import_readback_unconfirmed", posted.status);
    const known = new Set(before.data.activities.map((activity) => String(activity?.id ?? "")));
    const addedActivities = after.data.activities.filter((activity) => !known.has(String(activity?.id ?? "")));
    if (addedActivities.length === 0) return unconfirmedWrite("moodle_import_not_verified", posted.status);
    return {
      ok: true,
      sent: true,
      status: posted.status ?? after.status,
      data: {
        course_id: args.courseId,
        source_course_id: args.sourceCourseId,
        restore_mode: "merge",
        activities_added: addedActivities.map((activity) => ({ id: String(activity?.id ?? ""), name: collapsed(activity?.name) })),
        course_state_before: before.data,
        course_state_after: after.data,
        settings_sent: settingsSent(state.entries),
        steps,
        proof: {
          method: "native_form_write",
          route: IMPORT_PATH,
          required_capability: CAPABILITIES.import,
          scope: "adds_to_the_approved_course",
          reversible_by_morrow: false,
        },
      },
      snapshot_digest: after.digest,
      verification: { schema: "morrow.browser-verification.v1", status: "verified" },
    };
  };

  const copyRows = async (context, courseId, step) => {
    const endpoint = urlFor(context, COPY_PROGRESS_PATH, { id: courseId });
    const page = await readPage(context, endpoint, step, "moodle_course_copy_progress_unavailable");
    if (page.error) return { error: page.error, status: page.status };
    const tables = [...page.document.querySelectorAll("table.backup-files-table")];
    if (tables.length !== 1) return { error: "moodle_course_copy_progress_unavailable", status: page.status };
    const { rows } = tableRows(tables[0]);
    if (rows.length > MAX_FILE_ROWS) return { error: "moodle_course_copy_progress_unavailable", status: page.status };
    const copies = [];
    for (const cells of rows) {
      if (cells.length < 5) return { error: "moodle_course_copy_progress_unavailable", status: page.status };
      copies.push({
        source: collapsed(cells[0]?.textContent),
        destination: collapsed(cells[1]?.textContent),
        started_at: collapsed(cells[2]?.textContent),
        operation: collapsed(cells[3]?.textContent, 40),
        ...(asyncHandle(cells.slice(4)) ? { operation_id: asyncHandle(cells.slice(4)) } : {}),
      });
    }
    return { status: page.status, copies };
  };

  const runCourseCopy = async (context, args) => {
    const before = await copyRows(context, args.courseId, "read_copies_before");
    if (before.error) return failure(before.error, before.status);
    if (before.copies.some((copy) => copy.destination === args.fullName)) {
      return failure("moodle_course_copy_already_in_progress", before.status);
    }

    const endpoint = urlFor(context, COPY_PATH, { id: args.courseId });
    const page = await readPage(context, endpoint, "load_copy_form", "moodle_course_copy_form_unavailable");
    if (page.error) return failure(page.error, page.status);
    const state = formState(page.document, context, COPY_PATH, { courseid: args.courseId }, endpoint);
    if (!state) return failure("moodle_course_copy_form_invalid", page.status);
    const submit = submitValue(state.form, COPY_SUBMIT_FIELD);
    if (!submit || !writableText(state.form, "fullname") || !writableText(state.form, "shortname")
      || !writableText(state.form, "idnumber")) return failure("moodle_course_copy_form_invalid", page.status);
    // A copy Morrow makes is hidden and carries no learner data, so it cannot
    // reach a learner and cannot move a learner record. Both are native
    // controls of this form, and both must offer the value Morrow sends.
    if (!offersOption(state.form, "visible", "0") || !offersOption(state.form, "userdata", "0")) {
      return failure("moodle_course_copy_form_invalid", page.status);
    }
    const category = args.categoryId || currentText(state.entries, "category");
    if (!offersOption(state.form, "category", category)) return failure("moodle_course_copy_category_refused", page.status);
    // Moodle offers a checkbox for every role used in the course, and a checked
    // one keeps that role's manual enrolments in the copy. Morrow copies no
    // people, so a form that already has one checked is refused.
    const keptRoles = [...state.form.querySelectorAll('input[type="checkbox"][name^="role_"]')].filter((control) => control.checked);
    if (keptRoles.length > 0) return failure("moodle_course_copy_enrolments_refused", page.status);

    const changes = new Map([
      ["fullname", [args.fullName]],
      ["shortname", [args.shortName]],
      // Moodle refuses a course whose ID number is already in use, and the copy
      // form is seeded with the source course's own ID number, so a copy is
      // created without one unless the caller names a new one.
      ["idnumber", [args.idNumber]],
      ["category", [category]],
      ["visible", ["0"]],
      ["userdata", ["0"]],
      [COPY_SUBMIT_FIELD, [submit]],
    ]);
    const reviewed = await courseSettingsDigest(context, args.courseId, "read_course_settings_fresh");
    if (reviewed.error) return failure(reviewed.error, reviewed.status);
    if (reviewed.digest !== args.expectedDigest) return failure("moodle_expected_digest_mismatch", reviewed.status);
    const posted = await postForm(context, state, changes, "start_copy", "moodle_course_copy_unconfirmed", true);
    if (posted.error) return failure(posted.error, posted.status);
    if (posted.unconfirmed) return unconfirmedWrite(posted.unconfirmed, posted.status);

    const after = await copyRows(context, args.courseId, "read_copies_after");
    if (after.error) return unconfirmedWrite("moodle_course_copy_readback_unconfirmed", posted.status);
    const added = after.copies.filter((copy) => copy.destination === args.fullName);
    if (added.length !== 1) {
      // A copy is created only on the branch that redirects, so a form that
      // answered with a page instead of a redirect saved nothing. Morrow still
      // reports it as sent, because a Moodle status alone never proves that.
      return unconfirmedWrite(posted.redirected === false ? "moodle_course_copy_refused" : "moodle_course_copy_not_verified", posted.status);
    }
    return {
      ok: true,
      sent: true,
      status: posted.status ?? after.status,
      data: {
        course_id: args.courseId,
        new_full_name: args.fullName,
        new_short_name: args.shortName,
        new_id_number: args.idNumber,
        category_id: category,
        visible: false,
        learner_data_copied: false,
        enrolments_kept: false,
        copy: added[0],
        copies_in_progress: after.copies.length,
        settings_sent: settingsSent(state.entries),
        steps,
        proof: {
          method: "native_form_write",
          route: COPY_PATH,
          required_capability: CAPABILITIES.copy,
          scope: "creates_one_hidden_course",
          reversible_by_morrow: false,
        },
      },
      verification: { schema: "morrow.browser-verification.v1", status: "verified" },
    };
  };

  /**
   * The native restore, step by step, in the order a browser takes them:
   * choose the file, read what the archive holds, open the destination stage,
   * commit the destination, then the settings, the schema and the review stage.
   * Each of those is one dispatch. The last one queues the restore.
   */
  const runCourseRestore = async (context, args) => {
    const before = await readBackupFiles(context, args.courseId, "read_backup_files_before");
    if (before.error) return failure(before.error, before.status);
    if (before.snapshotDigest !== args.expectedDigest) return failure("moodle_expected_digest_mismatch", before.status);
    if (!before.data.asynchronous) return failure("moodle_backup_asynchronous_required", before.status);
    if (before.data.restores_in_progress > 0) return failure("moodle_restore_already_in_progress", before.status);

    const matches = [];
    for (const [index, file] of before.files.entries()) {
      if (file.file_name === args.sourceFileName && before.data.files[index].file_digest === args.sourceFileDigest) matches.push(file);
    }
    if (matches.length !== 1 || !matches[0].target) return failure("moodle_restore_source_file_unavailable", before.status);

    const stateBefore = await courseState(context, args.courseId, "read_course_state_before");
    if (stateBefore.error) return failure(stateBefore.error, stateBefore.status);

    // Moodle answers this file's own Restore link with the confirmation stage of
    // that exact archive, where it has read what the archive holds and links on
    // to the destination stage.
    const confirm = await followLink(context, matches[0].target, RESTORE_PATH, "choose_backup_file", "moodle_restore_source_file_unavailable");
    if (confirm.error) return failure(confirm.error, confirm.status);
    if (confirm.url.searchParams.get("contextid") !== context.courseContextId
      || !WORKFLOW_ID.test(confirm.url.searchParams.get("pathnamehash") || "")) {
      return failure("moodle_restore_source_file_unavailable", confirm.status);
    }
    let destinationUrl = null;
    for (const anchor of confirm.document.querySelectorAll("a[href]")) {
      let candidate;
      try { candidate = samePath(new URL(anchor.getAttribute("href"), context.siteUrl).href, context, RESTORE_PATH); } catch { candidate = null; }
      if (!candidate || candidate.searchParams.get("stage") !== RESTORE_STAGE_DESTINATION) continue;
      if (candidate.searchParams.get("contextid") !== context.courseContextId) continue;
      if (!WORKFLOW_ID.test(candidate.searchParams.get("filepath") || "")) continue;
      if (destinationUrl && destinationUrl.href !== candidate.href) return failure("moodle_restore_archive_unreadable", confirm.status);
      destinationUrl = candidate;
    }
    if (!destinationUrl) return failure("moodle_restore_archive_unreadable", confirm.status);

    const destinationPage = await readPage(context, destinationUrl, "open_restore_destination", "moodle_restore_destination_unavailable");
    if (destinationPage.error) return failure(destinationPage.error, destinationPage.status);
    // The one native form that restores into the course this operation is bound
    // to. The other forms on this page restore into a new or a different
    // course, and Morrow does not use them.
    const destinationForms = postForms(destinationPage.document, context, RESTORE_PATH)
      .filter((form) => form.querySelector(CURRENT_COURSE_SELECTOR));
    if (destinationForms.length !== 1) return failure("moodle_restore_destination_invalid", destinationPage.status);
    const destinationEntries = entriesFor(destinationForms[0]);
    if (!destinationEntries || !one(valuesOf(destinationEntries, "sesskey"), context.sesskey)
      || !one(valuesOf(destinationEntries, "targetid"), args.courseId)
      || !one(valuesOf(destinationEntries, "stage"), RESTORE_STAGE_SETTINGS)
      || !one(valuesOf(destinationEntries, "filepath"), destinationUrl.searchParams.get("filepath"))
      || !one(valuesOf(destinationEntries, "contextid"), context.courseContextId)) {
      return failure("moodle_restore_destination_invalid", destinationPage.status);
    }
    if (!radioValues(destinationForms[0], "target").includes(args.target)) {
      return failure("moodle_restore_mode_refused", destinationPage.status);
    }
    let action;
    try { action = new URL(destinationForms[0].getAttribute("action") || "", context.siteUrl).href; } catch { return failure("moodle_restore_destination_invalid", destinationPage.status); }
    const destination = { form: destinationForms[0], entries: destinationEntries, action };

    // Step one of four that Moodle records: it binds the archive to this course
    // and to the approved restore mode, and creates the restore.
    const committed = await postForm(context, destination, new Map([["target", [args.target]]]), "commit_restore_destination", "moodle_restore_unconfirmed", false);
    if (committed.error) return failure(committed.error, committed.status);
    if (committed.unconfirmed) return unconfirmedWrite(committed.unconfirmed, committed.status);

    let stagePage = committed.document;
    let stageStatus = committed.status;
    let restoreId = "";
    const walk = [
      { stage: RESTORE_STAGE_SETTINGS, step: "restore_settings_stage" },
      { stage: RESTORE_STAGE_SCHEMA, step: "restore_schema_stage" },
      { stage: RESTORE_STAGE_REVIEW, step: "restore_review_stage" },
    ];
    const stageEndpoint = urlFor(context, RESTORE_PATH, { contextid: context.courseContextId });
    for (const stage of walk) {
      const state = formState(stagePage, context, RESTORE_PATH, { stage: stage.stage, restore: null }, stageEndpoint);
      if (!state) {
        // The workflow is not where Moodle said it would be, so Morrow ends it
        // instead of leaving it half built, and never starts it again.
        const cancelState = formState(stagePage, context, RESTORE_PATH, { restore: null }, stageEndpoint);
        const cancelled = cancelState ? await cancelWorkflow(context, cancelState, args.courseId, "cancel_restore") : false;
        return { ...failure("moodle_restore_stage_unexpected", stageStatus), workflow_cancelled: cancelled };
      }
      restoreId = currentText(state.entries, "restore");
      const submit = submitValue(state.form, SUBMIT_FIELD);
      if (!submit) {
        const cancelled = await cancelWorkflow(context, state, args.courseId, "cancel_restore");
        return { ...failure("moodle_restore_stage_unexpected", stageStatus), workflow_cancelled: cancelled };
      }
      const posted = await postForm(context, state, new Map([[SUBMIT_FIELD, [submit]]]), stage.step, "moodle_restore_unconfirmed", false);
      if (posted.error) return failure(posted.error, posted.status);
      if (posted.unconfirmed) return unconfirmedWrite(posted.unconfirmed, posted.status);
      stagePage = posted.document;
      stageStatus = posted.status;
    }

    // Moodle queues the restore and answers with the status block of that exact
    // restore. Nothing in the course has changed yet.
    const queued = stagePage.querySelector("[data-backupid]");
    const operationId = String(queued?.getAttribute("data-backupid") || "");
    if (!WORKFLOW_ID.test(operationId) || !restoreId || operationId !== restoreId) {
      return unconfirmedWrite("moodle_restore_not_queued", stageStatus);
    }
    const after = await readBackupFiles(context, args.courseId, "read_backup_files_after");
    if (after.error) return unconfirmedWrite("moodle_restore_readback_unconfirmed", stageStatus);
    if (after.data.restores_in_progress !== before.data.restores_in_progress + 1) {
      return unconfirmedWrite("moodle_restore_not_queued", stageStatus);
    }
    return {
      ok: true,
      sent: true,
      status: stageStatus ?? after.status,
      data: {
        course_id: args.courseId,
        source_file_name: args.sourceFileName,
        source_area: matches[0].area,
        restore_mode: args.mode,
        removes_existing_course_content: args.mode === "delete_and_restore",
        operation_id: operationId,
        state: "queued",
        course_changed_yet: false,
        course_state_before: stateBefore.data,
        restores_in_progress: after.data.restores_in_progress,
        steps,
        proof: {
          method: "native_form_write",
          route: RESTORE_PATH,
          required_capability: CAPABILITIES.restore,
          scope: args.mode === "delete_and_restore" ? "replaces_the_approved_course" : "adds_to_the_approved_course",
          reversible_by_morrow: false,
        },
      },
      snapshot_digest: after.snapshotDigest,
      verification: { schema: "morrow.browser-verification.v1", status: "verified" },
    };
  };

  try {
    const context = currentContext();
    if (input?.mode !== "execute" || !context) return failure("moodle_session_unavailable");
    if (!live()) return failure("moodle_execution_expired");
    const definition = expectedOperation(input.operation);
    if (!definition) return failure("moodle_operation_refused");
    if (!bindingValid(context, input.binding)) return failure("moodle_binding_mismatch");
    const args = argumentsFor(definition, input.arguments, input.binding);
    if (!args) return failure("moodle_backup_arguments_invalid");
    // Every backup route addresses this course by its context id, so nothing
    // starts until the page has stated one.
    if (!context.courseContextId) return failure("moodle_course_context_unavailable");
    if (definition.kind === "files") {
      const listed = await readBackupFiles(context, args.courseId, "read_backup_files");
      return listed.error
        ? failure(listed.error, listed.status)
        : { ok: true, sent: true, status: listed.status, data: listed.data, snapshot_digest: listed.snapshotDigest };
    }
    if (definition.kind === "progress") return await readProgress(context, args.operationId, definition.operation);
    if (definition.kind === "backup") return await runCourseBackup(context, args);
    if (definition.kind === "import") return await runCourseImport(context, args);
    if (definition.kind === "copy") return await runCourseCopy(context, args);
    return await runCourseRestore(context, args);
  } catch (error) {
    if (writeAttempted) return unconfirmedWrite("moodle_backup_workflow_unconfirmed");
    return failure(String(error?.message || error).startsWith("moodle_") ? String(error.message) : "moodle_backup_execution_failed");
  }
}
