/**
 * Reads the submission record and the feedback record of one exact learner in
 * one exact Moodle Assignment.
 *
 * Both reads use the native mod_assign_get_submission_status function through
 * the same-site AJAX endpoint. Route limit: Moodle v5.2.2 registers that
 * function in public/mod/assign/db/services.php without the AJAX flag, and
 * public/lib/ajax/service.php refuses a function that is not enabled for AJAX,
 * so on a site that has not enabled it both reads stop at that call and return
 * moodle_assignment_submission_service_unavailable or
 * moodle_assignment_feedback_service_unavailable with no record.
 *
 * The page world sees the learner ID because the native function requires it.
 * The result carries it only inside `learner`, which the MCP runtime projects
 * to a stable token through the complete course roster and refuses when the
 * identity is not on that roster. No submission text, feedback text, file byte,
 * file URL, grader identity, or session key ever leaves the page.
 */
export async function executeMoodleAssignmentSubmissionInPage(rawInput) {
  const PROVIDER = "moodle";
  const OPERATION = "moodle.form.assign.submission.read.v1";
  const TOOL = "moodle_get_assignment_submission";
  const SCHEMA = "morrow.moodle-assignment-submission.v1";
  const STATUS_METHOD = "mod_assign_get_submission_status";
  const REQUIRED_CAPABILITY = "mod/assign:viewgrades";
  const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
  const MAX_PLUGINS = 20;
  const MAX_FILES = 200;
  const STATUSES = Object.freeze(["new", "reopened", "draft", "submitted"]);
  const GRADING_STATUSES = Object.freeze(["graded", "notgraded", "notmarked", "inmarking", "readyforreview", "inreview", "readyforrelease", "released"]);
  const STATUS_SET = new Set(STATUSES);
  const GRADING_STATUS_SET = new Set(GRADING_STATUSES);
  const ID = /^[1-9][0-9]{0,18}$/;
  const object = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
  const id = (value) => Number.isSafeInteger(value) && value > 0 ? String(value)
    : typeof value === "string" && ID.test(value) ? value : "";
  const fail = (error) => ({ ok: false, sent: false, error });
  const incomplete = () => ({ ok: false, sent: false, complete: false, error: "moodle_assignment_submission_incomplete" });
  const input = (() => { try { return typeof rawInput === "string" ? JSON.parse(rawInput) : rawInput; } catch { return null; } })();
  const cfg = globalThis.M?.cfg;
  if (!object(input) || !object(cfg) || typeof cfg.wwwroot !== "string" || typeof cfg.sesskey !== "string" || !cfg.sesskey) {
    return fail("moodle_assignment_submission_context_invalid");
  }
  let site;
  try { site = new URL(cfg.wwwroot); } catch { return fail("moodle_assignment_submission_context_invalid"); }
  const basePath = site.pathname.replace(/\/$/, "");
  const bodyCourse = String(globalThis.document?.body?.className || "").match(/(?:^|\s)course-([1-9][0-9]*)(?:\s|$)/)?.[1] || "";
  const courseId = id(cfg.courseId) || bodyCourse;
  const principalId = id(cfg.userId);
  const currentPath = String(globalThis.location?.pathname || "");
  if (site.protocol !== "https:" || site.search || site.hash || site.username || site.password
    || site.origin !== globalThis.location?.origin || !(currentPath === basePath || currentPath.startsWith(`${basePath}/`))
    || !courseId || !principalId) return fail("moodle_assignment_submission_context_invalid");
  const operation = input.operation;
  const args = input.arguments;
  const binding = input.binding;
  if (!object(operation) || operation.key !== OPERATION || operation.toolName !== TOOL || operation.provider !== PROVIDER || operation.readOnly !== true
    || !object(args) || Object.keys(args).length !== 3 || id(args.course_id) !== courseId || !id(args.module_id) || !id(args.user_id)
    || !object(binding) || binding.origin !== site.origin || binding.siteUrl !== site.href
    || id(binding.principalId) !== principalId || id(binding.courseId) !== courseId
    || !Number.isSafeInteger(input.expiresAt) || input.expiresAt <= Date.now()) return fail("moodle_assignment_submission_arguments_invalid");
  const moduleId = id(args.module_id);
  const learnerId = id(args.user_id);
  const sameContext = () => globalThis.M?.cfg?.sesskey === cfg.sesskey && id(globalThis.M?.cfg?.userId) === principalId
    && (id(globalThis.M?.cfg?.courseId) || bodyCourse) === courseId;
  const url = (path, query = {}) => {
    const result = new URL(site.href);
    result.pathname = `${basePath}${path}`;
    result.search = new URLSearchParams(query).toString();
    result.hash = "";
    return result;
  };
  const sameRoute = (actual, expected) => {
    try {
      const received = new URL(actual);
      return received.origin === expected.origin && received.pathname === expected.pathname
        && received.search === expected.search && !received.hash && !received.username && !received.password;
    } catch { return false; }
  };
  const boundedText = async (response, endpoint) => {
    const declared = response?.headers?.get?.("content-length");
    if (declared !== null && (!/^(?:0|[1-9][0-9]*)$/.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) return "limit";
    if (!response?.ok || !sameRoute(response.url, endpoint) || !sameContext() || !response.body
      || typeof response.body.getReader !== "function" || typeof globalThis.TextDecoder !== "function") return null;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    let result = "";
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        if (!(next.value instanceof Uint8Array) || (bytes += next.value.byteLength) > MAX_RESPONSE_BYTES) {
          await reader.cancel();
          return "limit";
        }
        result += decoder.decode(next.value, { stream: true });
      }
      return result + decoder.decode();
    } catch {
      try { await reader.cancel(); } catch {}
      return null;
    }
  };
  const hidden = (form, name) => {
    const values = [...form.querySelectorAll(`input[type="hidden"][name="${name}"]`)];
    return values.length === 1 ? values[0].value : "";
  };
  const assignmentInstance = async () => {
    const endpoint = url("/course/modedit.php", { update: moduleId, return: "0" });
    let response;
    try {
      response = await fetch(endpoint, {
        method: "GET", credentials: "include", cache: "no-store", redirect: "error", headers: { Accept: "text/html" },
      });
    } catch { return null; }
    const html = await boundedText(response, endpoint);
    if (html === "limit") return "limit";
    if (typeof html !== "string" || typeof globalThis.DOMParser !== "function") return null;
    let documentValue;
    try { documentValue = new DOMParser().parseFromString(html, "text/html"); } catch { return null; }
    const forms = [...documentValue.querySelectorAll("form")].filter((form) => {
      if (String(form.getAttribute("method") || "").toLowerCase() !== "post") return false;
      const action = form.getAttribute("action") || endpoint.href;
      try {
        const actionUrl = new URL(action, endpoint);
        return actionUrl.origin === endpoint.origin && actionUrl.pathname === endpoint.pathname && !actionUrl.hash
          && !actionUrl.username && !actionUrl.password && (actionUrl.search === "" || actionUrl.search === endpoint.search)
          && hidden(form, "course") === courseId && hidden(form, "coursemodule") === moduleId && hidden(form, "update") === moduleId
          && hidden(form, "modulename") === "assign" && Boolean(id(hidden(form, "instance")));
      } catch { return false; }
    });
    return forms.length === 1 ? id(hidden(forms[0], "instance")) || null : null;
  };
  const ajax = async (method, methodArgs) => {
    if (Date.now() >= input.expiresAt || !sameContext()) return { error: "moodle_assignment_submission_context_changed" };
    const endpoint = url("/lib/ajax/service.php", { sesskey: cfg.sesskey, info: method });
    let response;
    try {
      response = await fetch(endpoint, {
        method: "POST", credentials: "include", cache: "no-store", redirect: "error",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify([{ index: 0, methodname: method, args: methodArgs }]),
      });
    } catch { return { error: "moodle_assignment_submission_request_failed" }; }
    const raw = await boundedText(response, endpoint);
    if (raw === "limit") return { incomplete: true };
    if (typeof raw !== "string") return { error: "moodle_assignment_submission_response_unavailable" };
    try {
      const payload = JSON.parse(raw);
      if (!Array.isArray(payload) || payload.length !== 1 || !object(payload[0]) || payload[0].index !== 0) {
        return { error: "moodle_assignment_submission_response_invalid" };
      }
      const code = object(payload[0].exception) ? payload[0].exception.errorcode : "";
      if (code === "servicenotavailable") return { error: "moodle_assignment_submission_service_unavailable" };
      if (code === "nopermission" || code === "nopermissions") return { error: "moodle_assignment_submission_permission_unavailable" };
      if (payload[0].error || payload[0].exception || !("data" in payload[0])) {
        return { error: "moodle_assignment_submission_response_invalid" };
      }
      const data = typeof payload[0].data === "string" ? JSON.parse(payload[0].data) : payload[0].data;
      return object(data) ? { data } : { error: "moodle_assignment_submission_response_invalid" };
    } catch { return { error: "moodle_assignment_submission_response_invalid" }; }
  };
  const timestamp = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
  const bounded = (value, maximum) => typeof value === "string" && value.length > 0 && value.length <= maximum
    && !/[\u0000-\u001f\u007f]/.test(value) ? value : "";
  /** Keeps file metadata only. A file URL is a credentialed page route and no byte is ever read. */
  const fileList = (plugin, pluginType) => {
    const areas = plugin.fileareas === undefined ? [] : plugin.fileareas;
    if (!Array.isArray(areas)) return null;
    const files = [];
    for (const areaValue of areas) {
      if (!object(areaValue)) return null;
      const area = bounded(areaValue.area, 100);
      if (!area) return null;
      const entries = areaValue.files === undefined ? [] : areaValue.files;
      if (!Array.isArray(entries)) return null;
      for (const entry of entries) {
        if (!object(entry)) return null;
        const fileName = bounded(entry.filename, 255);
        const filePath = entry.filepath === undefined ? "/" : bounded(entry.filepath, 255);
        const modified = timestamp(entry.timemodified);
        const size = entry.filesize === undefined || entry.filesize === null ? null : timestamp(entry.filesize);
        const mime = entry.mimetype === undefined || entry.mimetype === null ? null : bounded(entry.mimetype, 255) || null;
        if (!fileName || !filePath || modified === null || (entry.filesize !== undefined && entry.filesize !== null && size === null)) return null;
        files.push({ plugin_type: pluginType, area, file_name: fileName, file_path: filePath, file_size: size, mime_type: mime, time_modified: modified });
      }
    }
    return files;
  };
  const editorContent = (plugin) => {
    const fields = plugin.editorfields === undefined ? [] : plugin.editorfields;
    if (!Array.isArray(fields)) return null;
    let present = false;
    for (const field of fields) {
      if (!object(field) || typeof field.text !== "string") return null;
      if (field.text.trim().length > 0) present = true;
    }
    return { present };
  };
  const stable = (value) => {
    if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
    if (object(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
    return JSON.stringify(value === undefined ? null : value);
  };
  const digest = async (value) => {
    if (!globalThis.crypto?.subtle || typeof globalThis.TextEncoder !== "function") return "";
    const bytes = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(stable(value)));
    return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
  };
  const assignmentId = await assignmentInstance();
  if (assignmentId === "limit") return incomplete();
  if (!assignmentId) return fail("moodle_assignment_submission_target_unavailable");
  const statusResult = await ajax(STATUS_METHOD, { assignid: Number(assignmentId), userid: Number(learnerId), groupid: 0 });
  if (statusResult.incomplete) return incomplete();
  if (!statusResult.data) return fail(statusResult.error || "moodle_assignment_submission_unavailable");
  const lastAttempt = statusResult.data.lastattempt;
  if (!object(lastAttempt)) return fail("moodle_assignment_submission_detail_unavailable");
  // A group submission is not one learner's record, so this read refuses it
  // rather than reporting a shared attempt as a personal one.
  if (lastAttempt.teamsubmission !== undefined) return fail("moodle_assignment_submission_team_unsupported");
  const gradingStatus = bounded(lastAttempt.gradingstatus, 40);
  if (!GRADING_STATUS_SET.has(gradingStatus) || typeof lastAttempt.locked !== "boolean"
    || typeof lastAttempt.graded !== "boolean" || typeof lastAttempt.blindmarking !== "boolean"
    || timestamp(lastAttempt.extensionduedate) === null) {
    return fail("moodle_assignment_submission_response_invalid");
  }
  const source = lastAttempt.submission;
  if (source !== undefined && !object(source)) return fail("moodle_assignment_submission_response_invalid");
  let attempt = null;
  const submissionTypes = [];
  const files = [];
  if (object(source)) {
    const status = bounded(source.status, 40);
    const created = timestamp(source.timecreated);
    const modified = timestamp(source.timemodified);
    const started = source.timestarted === undefined || source.timestarted === null ? null : timestamp(source.timestarted);
    if (!STATUS_SET.has(status) || !Number.isSafeInteger(source.attemptnumber) || source.attemptnumber < 0
      || created === null || modified === null || (source.timestarted !== undefined && source.timestarted !== null && started === null)
      || id(source.assignment ?? assignmentId) !== assignmentId) {
      return fail("moodle_assignment_submission_response_invalid");
    }
    const plugins = source.plugins === undefined ? [] : source.plugins;
    if (!Array.isArray(plugins)) return fail("moodle_assignment_submission_response_invalid");
    if (plugins.length > MAX_PLUGINS) return incomplete();
    const seen = new Set();
    for (const plugin of plugins) {
      if (!object(plugin)) return fail("moodle_assignment_submission_response_invalid");
      const type = bounded(plugin.type, 100);
      if (!type || seen.has(type)) return fail("moodle_assignment_submission_response_invalid");
      seen.add(type);
      const pluginFiles = fileList(plugin, type);
      const editor = editorContent(plugin);
      if (!pluginFiles || !editor) return fail("moodle_assignment_submission_response_invalid");
      if (files.length + pluginFiles.length > MAX_FILES) return incomplete();
      files.push(...pluginFiles);
      submissionTypes.push({ type, has_content: editor.present || pluginFiles.length > 0, file_count: pluginFiles.length });
    }
    submissionTypes.sort((left, right) => left.type < right.type ? -1 : left.type > right.type ? 1 : 0);
    attempt = {
      attempt_number: source.attemptnumber,
      status,
      time_created: created,
      time_modified: modified,
      time_started: started,
    };
  }
  if (!sameContext() || Date.now() > input.expiresAt) return fail("moodle_assignment_submission_context_changed");
  const data = {
    schema: SCHEMA,
    provider: PROVIDER,
    course_id: Number(courseId),
    module_id: Number(moduleId),
    assignment_id: Number(assignmentId),
    learner: { user_id: learnerId },
    attempt,
    grading_status: gradingStatus,
    locked: lastAttempt.locked,
    graded: lastAttempt.graded,
    blind_marking: lastAttempt.blindmarking,
    extension_due_date: lastAttempt.extensionduedate === 0 ? null : lastAttempt.extensionduedate,
    submission_types: submissionTypes,
    files,
    proof: {
      method: STATUS_METHOD,
      complete: true,
      exact_module_binding: "course_modedit_form",
      required_capability: REQUIRED_CAPABILITY,
      submission_type_limit: MAX_PLUGINS,
      file_limit: MAX_FILES,
      file_count: files.length,
      includes_file_bytes: false,
    },
  };
  const snapshotDigest = await digest(data);
  if (!snapshotDigest) return fail("moodle_assignment_submission_digest_unavailable");
  return { ok: true, sent: false, complete: true, data, snapshot_digest: snapshotDigest };
}

/**
 * Reads the grade, the marking-workflow state, and the feedback record of one
 * exact learner in one exact Moodle Assignment. It reports whether a feedback
 * comment exists and the metadata of each feedback file; it never returns the
 * comment text, a file byte, a file URL, or the grader's identity.
 *
 * It uses the same native mod_assign_get_submission_status route and carries
 * the same route limit as the submission read above.
 */
export async function executeMoodleAssignmentFeedbackInPage(rawInput) {
  const PROVIDER = "moodle";
  const OPERATION = "moodle.form.assign.feedback.read.v1";
  const TOOL = "moodle_get_assignment_feedback";
  const SCHEMA = "morrow.moodle-assignment-feedback.v1";
  const STATUS_METHOD = "mod_assign_get_submission_status";
  const REQUIRED_CAPABILITY = "mod/assign:grade";
  const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
  const MAX_PLUGINS = 20;
  const MAX_FILES = 200;
  const GRADING_STATUSES = Object.freeze(["graded", "notgraded", "notmarked", "inmarking", "readyforreview", "inreview", "readyforrelease", "released"]);
  const WORKFLOW_STATES = Object.freeze(["notmarked", "inmarking", "readyforreview", "inreview", "readyforrelease", "released"]);
  const GRADING_STATUS_SET = new Set(GRADING_STATUSES);
  const WORKFLOW_STATE_SET = new Set(WORKFLOW_STATES);
  const ID = /^[1-9][0-9]{0,18}$/;
  const object = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
  const id = (value) => Number.isSafeInteger(value) && value > 0 ? String(value)
    : typeof value === "string" && ID.test(value) ? value : "";
  const fail = (error) => ({ ok: false, sent: false, error });
  const incomplete = () => ({ ok: false, sent: false, complete: false, error: "moodle_assignment_feedback_incomplete" });
  const input = (() => { try { return typeof rawInput === "string" ? JSON.parse(rawInput) : rawInput; } catch { return null; } })();
  const cfg = globalThis.M?.cfg;
  if (!object(input) || !object(cfg) || typeof cfg.wwwroot !== "string" || typeof cfg.sesskey !== "string" || !cfg.sesskey) {
    return fail("moodle_assignment_feedback_context_invalid");
  }
  let site;
  try { site = new URL(cfg.wwwroot); } catch { return fail("moodle_assignment_feedback_context_invalid"); }
  const basePath = site.pathname.replace(/\/$/, "");
  const bodyCourse = String(globalThis.document?.body?.className || "").match(/(?:^|\s)course-([1-9][0-9]*)(?:\s|$)/)?.[1] || "";
  const courseId = id(cfg.courseId) || bodyCourse;
  const principalId = id(cfg.userId);
  const currentPath = String(globalThis.location?.pathname || "");
  if (site.protocol !== "https:" || site.search || site.hash || site.username || site.password
    || site.origin !== globalThis.location?.origin || !(currentPath === basePath || currentPath.startsWith(`${basePath}/`))
    || !courseId || !principalId) return fail("moodle_assignment_feedback_context_invalid");
  const operation = input.operation;
  const args = input.arguments;
  const binding = input.binding;
  if (!object(operation) || operation.key !== OPERATION || operation.toolName !== TOOL || operation.provider !== PROVIDER || operation.readOnly !== true
    || !object(args) || Object.keys(args).length !== 3 || id(args.course_id) !== courseId || !id(args.module_id) || !id(args.user_id)
    || !object(binding) || binding.origin !== site.origin || binding.siteUrl !== site.href
    || id(binding.principalId) !== principalId || id(binding.courseId) !== courseId
    || !Number.isSafeInteger(input.expiresAt) || input.expiresAt <= Date.now()) return fail("moodle_assignment_feedback_arguments_invalid");
  const moduleId = id(args.module_id);
  const learnerId = id(args.user_id);
  const sameContext = () => globalThis.M?.cfg?.sesskey === cfg.sesskey && id(globalThis.M?.cfg?.userId) === principalId
    && (id(globalThis.M?.cfg?.courseId) || bodyCourse) === courseId;
  const url = (path, query = {}) => {
    const result = new URL(site.href);
    result.pathname = `${basePath}${path}`;
    result.search = new URLSearchParams(query).toString();
    result.hash = "";
    return result;
  };
  const sameRoute = (actual, expected) => {
    try {
      const received = new URL(actual);
      return received.origin === expected.origin && received.pathname === expected.pathname
        && received.search === expected.search && !received.hash && !received.username && !received.password;
    } catch { return false; }
  };
  const boundedText = async (response, endpoint) => {
    const declared = response?.headers?.get?.("content-length");
    if (declared !== null && (!/^(?:0|[1-9][0-9]*)$/.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) return "limit";
    if (!response?.ok || !sameRoute(response.url, endpoint) || !sameContext() || !response.body
      || typeof response.body.getReader !== "function" || typeof globalThis.TextDecoder !== "function") return null;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    let result = "";
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        if (!(next.value instanceof Uint8Array) || (bytes += next.value.byteLength) > MAX_RESPONSE_BYTES) {
          await reader.cancel();
          return "limit";
        }
        result += decoder.decode(next.value, { stream: true });
      }
      return result + decoder.decode();
    } catch {
      try { await reader.cancel(); } catch {}
      return null;
    }
  };
  const hidden = (form, name) => {
    const values = [...form.querySelectorAll(`input[type="hidden"][name="${name}"]`)];
    return values.length === 1 ? values[0].value : "";
  };
  const assignmentInstance = async () => {
    const endpoint = url("/course/modedit.php", { update: moduleId, return: "0" });
    let response;
    try {
      response = await fetch(endpoint, {
        method: "GET", credentials: "include", cache: "no-store", redirect: "error", headers: { Accept: "text/html" },
      });
    } catch { return null; }
    const html = await boundedText(response, endpoint);
    if (html === "limit") return "limit";
    if (typeof html !== "string" || typeof globalThis.DOMParser !== "function") return null;
    let documentValue;
    try { documentValue = new DOMParser().parseFromString(html, "text/html"); } catch { return null; }
    const forms = [...documentValue.querySelectorAll("form")].filter((form) => {
      if (String(form.getAttribute("method") || "").toLowerCase() !== "post") return false;
      const action = form.getAttribute("action") || endpoint.href;
      try {
        const actionUrl = new URL(action, endpoint);
        return actionUrl.origin === endpoint.origin && actionUrl.pathname === endpoint.pathname && !actionUrl.hash
          && !actionUrl.username && !actionUrl.password && (actionUrl.search === "" || actionUrl.search === endpoint.search)
          && hidden(form, "course") === courseId && hidden(form, "coursemodule") === moduleId && hidden(form, "update") === moduleId
          && hidden(form, "modulename") === "assign" && Boolean(id(hidden(form, "instance")));
      } catch { return false; }
    });
    return forms.length === 1 ? id(hidden(forms[0], "instance")) || null : null;
  };
  const ajax = async (method, methodArgs) => {
    if (Date.now() >= input.expiresAt || !sameContext()) return { error: "moodle_assignment_feedback_context_changed" };
    const endpoint = url("/lib/ajax/service.php", { sesskey: cfg.sesskey, info: method });
    let response;
    try {
      response = await fetch(endpoint, {
        method: "POST", credentials: "include", cache: "no-store", redirect: "error",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify([{ index: 0, methodname: method, args: methodArgs }]),
      });
    } catch { return { error: "moodle_assignment_feedback_request_failed" }; }
    const raw = await boundedText(response, endpoint);
    if (raw === "limit") return { incomplete: true };
    if (typeof raw !== "string") return { error: "moodle_assignment_feedback_response_unavailable" };
    try {
      const payload = JSON.parse(raw);
      if (!Array.isArray(payload) || payload.length !== 1 || !object(payload[0]) || payload[0].index !== 0) {
        return { error: "moodle_assignment_feedback_response_invalid" };
      }
      const code = object(payload[0].exception) ? payload[0].exception.errorcode : "";
      if (code === "servicenotavailable") return { error: "moodle_assignment_feedback_service_unavailable" };
      if (code === "nopermission" || code === "nopermissions") return { error: "moodle_assignment_feedback_permission_unavailable" };
      if (payload[0].error || payload[0].exception || !("data" in payload[0])) {
        return { error: "moodle_assignment_feedback_response_invalid" };
      }
      const data = typeof payload[0].data === "string" ? JSON.parse(payload[0].data) : payload[0].data;
      return object(data) ? { data } : { error: "moodle_assignment_feedback_response_invalid" };
    } catch { return { error: "moodle_assignment_feedback_response_invalid" }; }
  };
  const timestamp = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
  const bounded = (value, maximum) => typeof value === "string" && value.length > 0 && value.length <= maximum
    && !/[\u0000-\u001f\u007f]/.test(value) ? value : "";
  /** Moodle sends the stored grade as PARAM_TEXT, and a value below zero means the assignment is not graded. */
  const gradeValue = (value) => {
    const text = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
    if (!/^-?(?:[0-9]+|[0-9]*\.[0-9]+)$/.test(text)) return undefined;
    const parsed = Number(text);
    if (!Number.isFinite(parsed)) return undefined;
    return parsed < 0 ? null : Math.round(parsed * 100_000) / 100_000;
  };
  const fileList = (plugin, pluginType) => {
    const areas = plugin.fileareas === undefined ? [] : plugin.fileareas;
    if (!Array.isArray(areas)) return null;
    const files = [];
    for (const areaValue of areas) {
      if (!object(areaValue)) return null;
      const area = bounded(areaValue.area, 100);
      if (!area) return null;
      const entries = areaValue.files === undefined ? [] : areaValue.files;
      if (!Array.isArray(entries)) return null;
      for (const entry of entries) {
        if (!object(entry)) return null;
        const fileName = bounded(entry.filename, 255);
        const filePath = entry.filepath === undefined ? "/" : bounded(entry.filepath, 255);
        const modified = timestamp(entry.timemodified);
        const size = entry.filesize === undefined || entry.filesize === null ? null : timestamp(entry.filesize);
        const mime = entry.mimetype === undefined || entry.mimetype === null ? null : bounded(entry.mimetype, 255) || null;
        if (!fileName || !filePath || modified === null || (entry.filesize !== undefined && entry.filesize !== null && size === null)) return null;
        files.push({ plugin_type: pluginType, area, file_name: fileName, file_path: filePath, file_size: size, mime_type: mime, time_modified: modified });
      }
    }
    return files;
  };
  const editorContent = (plugin) => {
    const fields = plugin.editorfields === undefined ? [] : plugin.editorfields;
    if (!Array.isArray(fields)) return null;
    let present = false;
    for (const field of fields) {
      if (!object(field) || typeof field.text !== "string") return null;
      if (field.text.trim().length > 0) present = true;
    }
    return { present };
  };
  const stable = (value) => {
    if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
    if (object(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
    return JSON.stringify(value === undefined ? null : value);
  };
  const digest = async (value) => {
    if (!globalThis.crypto?.subtle || typeof globalThis.TextEncoder !== "function") return "";
    const bytes = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(stable(value)));
    return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
  };
  const assignmentId = await assignmentInstance();
  if (assignmentId === "limit") return incomplete();
  if (!assignmentId) return fail("moodle_assignment_feedback_target_unavailable");
  const statusResult = await ajax(STATUS_METHOD, { assignid: Number(assignmentId), userid: Number(learnerId), groupid: 0 });
  if (statusResult.incomplete) return incomplete();
  if (!statusResult.data) return fail(statusResult.error || "moodle_assignment_feedback_unavailable");
  const lastAttempt = statusResult.data.lastattempt;
  if (!object(lastAttempt)) return fail("moodle_assignment_feedback_detail_unavailable");
  if (lastAttempt.teamsubmission !== undefined) return fail("moodle_assignment_feedback_team_unsupported");
  const gradingStatus = bounded(lastAttempt.gradingstatus, 40);
  if (!GRADING_STATUS_SET.has(gradingStatus) || typeof lastAttempt.graded !== "boolean") {
    return fail("moodle_assignment_feedback_response_invalid");
  }
  const feedback = statusResult.data.feedback;
  if (feedback !== undefined && !object(feedback)) return fail("moodle_assignment_feedback_response_invalid");
  let gradeAttemptNumber = null;
  let grade = null;
  let gradedDate = null;
  const feedbackTypes = [];
  const files = [];
  if (object(feedback)) {
    const record = feedback.grade;
    if (record !== undefined && !object(record)) return fail("moodle_assignment_feedback_response_invalid");
    if (object(record)) {
      const parsed = gradeValue(record.grade);
      const graded = timestamp(feedback.gradeddate);
      if (parsed === undefined || !Number.isSafeInteger(record.attemptnumber) || record.attemptnumber < 0
        || graded === null || id(record.assignment ?? assignmentId) !== assignmentId) {
        return fail("moodle_assignment_feedback_response_invalid");
      }
      grade = parsed;
      gradeAttemptNumber = record.attemptnumber;
      gradedDate = graded === 0 ? null : graded;
      const plugins = feedback.plugins === undefined ? [] : feedback.plugins;
      if (!Array.isArray(plugins)) return fail("moodle_assignment_feedback_response_invalid");
      if (plugins.length > MAX_PLUGINS) return incomplete();
      const seen = new Set();
      for (const plugin of plugins) {
        if (!object(plugin)) return fail("moodle_assignment_feedback_response_invalid");
        const type = bounded(plugin.type, 100);
        if (!type || seen.has(type)) return fail("moodle_assignment_feedback_response_invalid");
        seen.add(type);
        const pluginFiles = fileList(plugin, type);
        const editor = editorContent(plugin);
        if (!pluginFiles || !editor) return fail("moodle_assignment_feedback_response_invalid");
        if (files.length + pluginFiles.length > MAX_FILES) return incomplete();
        files.push(...pluginFiles);
        feedbackTypes.push({ type, comment_present: editor.present, file_count: pluginFiles.length });
      }
      feedbackTypes.sort((left, right) => left.type < right.type ? -1 : left.type > right.type ? 1 : 0);
    }
  }
  if (!sameContext() || Date.now() > input.expiresAt) return fail("moodle_assignment_feedback_context_changed");
  const data = {
    schema: SCHEMA,
    provider: PROVIDER,
    course_id: Number(courseId),
    module_id: Number(moduleId),
    assignment_id: Number(assignmentId),
    learner: { user_id: learnerId },
    grading_status: gradingStatus,
    // Moodle answers with a marking-workflow state only when the Assignment has
    // marking workflow switched on; otherwise it answers graded or notgraded.
    marking_workflow_state: WORKFLOW_STATE_SET.has(gradingStatus) ? gradingStatus : null,
    graded: lastAttempt.graded,
    grade_value: grade,
    grade_attempt_number: gradeAttemptNumber,
    graded_date: gradedDate,
    feedback_types: feedbackTypes,
    files,
    proof: {
      method: STATUS_METHOD,
      complete: true,
      exact_module_binding: "course_modedit_form",
      required_capability: REQUIRED_CAPABILITY,
      feedback_type_limit: MAX_PLUGINS,
      file_limit: MAX_FILES,
      file_count: files.length,
      includes_feedback_text: false,
      includes_file_bytes: false,
    },
  };
  const snapshotDigest = await digest(data);
  if (!snapshotDigest) return fail("moodle_assignment_feedback_digest_unavailable");
  return { ok: true, sent: false, complete: true, data, snapshot_digest: snapshotDigest };
}
