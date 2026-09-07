/**
 * Reads a single Moodle Forum export without entering a learner-view route.
 * The POST is Moodle's native CSV export download, not a course mutation.
 */
export async function executeMoodleForumReadInPage(rawInput) {
  const MAX_BYTES = 2_000_000;
  const MAX_RECORDS = 10_000;
  const ID = /^[1-9][0-9]{0,18}$/;
  const OPERATION = "moodle.form.mod.forum.export.read.v1";
  const object = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
  const id = (value) => {
    const text = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : typeof value === "string" ? value : "";
    return ID.test(text) ? text : "";
  };
  const text = (value, max = 500) => typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
  const failed = (error, status) => ({ ok: false, sent: false, ...(Number.isInteger(status) ? { status } : {}), error });
  const input = (() => { try { return typeof rawInput === "string" ? JSON.parse(rawInput) : rawInput; } catch { return null; } })();
  const cfg = globalThis.M?.cfg;
  if (!object(input) || !object(cfg) || typeof cfg.wwwroot !== "string" || !text(cfg.sesskey, 1024)) return failed("moodle_forum_context_invalid");
  let site;
  try { site = new URL(cfg.wwwroot); } catch { return failed("moodle_forum_context_invalid"); }
  const basePath = site.pathname.replace(/\/$/, "");
  const currentPath = String(globalThis.location?.pathname || "");
  const courseFromBody = String(globalThis.document?.body?.className || "").match(/(?:^|\s)course-([1-9][0-9]*)(?:\s|$)/)?.[1] || "";
  const anchorCourse = id(cfg.courseId) || courseFromBody;
  const principal = id(cfg.userId);
  if (site.protocol !== "https:" || site.search || site.hash || site.username || site.password || site.origin !== globalThis.location?.origin
    || !(currentPath === basePath || currentPath.startsWith(`${basePath}/`)) || !anchorCourse || !principal) return failed("moodle_forum_context_invalid");
  const operation = input.operation;
  const args = input.arguments;
  const binding = input.binding;
  if (!object(operation) || operation.key !== OPERATION || operation.toolName !== "moodle_get_forum_posts" || operation.provider !== "moodle" || operation.readOnly !== true
    || !object(args) || Object.keys(args).length !== 2 || !object(binding)
    || binding.origin !== site.origin || binding.siteUrl !== site.href || id(binding.principalId) !== principal || id(binding.courseId) !== anchorCourse
    || id(args.course_id) !== anchorCourse || !id(args.forum_module_id)
    || !Number.isSafeInteger(input.expiresAt) || input.expiresAt <= Date.now()) return failed("moodle_arguments_invalid");
  const courseId = anchorCourse;
  const moduleId = id(args.forum_module_id);
  const url = (path, query = {}) => {
    const result = new URL(site.href);
    result.pathname = `${basePath}${path}`;
    result.search = new URLSearchParams(query).toString();
    result.hash = "";
    return result;
  };
  const sameContext = () => globalThis.M?.cfg?.sesskey === cfg.sesskey && id(globalThis.M?.cfg?.userId) === principal
    && (id(globalThis.M?.cfg?.courseId) || courseFromBody) === courseId;
  const approved = () => Date.now() <= input.expiresAt && sameContext();
  const sameRoute = (actual, expected) => {
    try { const received = new URL(actual); return received.origin === expected.origin && received.pathname === expected.pathname && received.search === expected.search && !received.hash; } catch { return false; }
  };
  const ajax = async (methodname, argsValue) => {
    const endpoint = url("/lib/ajax/service.php", { sesskey: cfg.sesskey, info: methodname });
    let response;
    try {
      response = await fetch(endpoint, { method: "POST", credentials: "include", cache: "no-store", redirect: "error", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify([{ index: 0, methodname, args: argsValue }]) });
    } catch { return null; }
    if (!response.ok || !sameRoute(response.url, endpoint) || !sameContext()) return null;
    let payload;
    try { payload = await response.json(); } catch { return null; }
    if (!Array.isArray(payload) || payload.length !== 1 || object(payload[0]?.error)) return null;
    try { return JSON.parse(payload[0]?.data); } catch { return null; }
  };
  const forums = await ajax("mod_forum_get_forums_by_courses", { courseids: [Number(courseId)] });
  const candidates = Array.isArray(forums) ? forums.filter((forum) => id(forum?.course) === courseId && id(forum?.cmid) === moduleId && id(forum?.id)) : [];
  if (candidates.length !== 1) return failed("moodle_forum_target_unavailable");
  const forumId = id(candidates[0].id);
  const exportUrl = url("/mod/forum/export.php", { id: forumId });
  if (!approved()) return failed("moodle_forum_export_context_changed");
  let formResponse;
  try { formResponse = await fetch(exportUrl, { method: "GET", credentials: "include", cache: "no-store", redirect: "error", headers: { Accept: "text/html" } }); } catch { return failed("moodle_forum_export_unavailable"); }
  if (!formResponse.ok || !sameRoute(formResponse.url, exportUrl) || !sameContext()) return failed("moodle_forum_export_unavailable", formResponse.status);
  let formHtml;
  try { formHtml = await formResponse.text(); } catch { return failed("moodle_forum_export_unavailable", formResponse.status); }
  if (typeof globalThis.TextEncoder !== "function" || new TextEncoder().encode(formHtml).byteLength > MAX_BYTES || typeof globalThis.DOMParser !== "function") return failed("moodle_forum_export_unavailable", formResponse.status);
  const documentValue = new DOMParser().parseFromString(formHtml, "text/html");
  const forms = [...documentValue.querySelectorAll("form")].filter((form) => {
    if (String(form.method || "").toLowerCase() !== "post") return false;
    try { const action = new URL(form.getAttribute("action") || "", exportUrl); return action.origin === exportUrl.origin && action.pathname === exportUrl.pathname && !action.search && !action.hash; } catch { return false; }
  });
  if (forms.length !== 1) return failed("moodle_forum_export_form_invalid", formResponse.status);
  const form = forms[0];
  const action = new URL(form.getAttribute("action") || "", exportUrl);
  const allControls = [...form.querySelectorAll("input[name], select[name], textarea[name]")].filter((control) => !control.disabled);
  const allowed = new Set(["id", "sesskey", "format", "striphtml", "humandates", "submitbutton", "cancel", "useridsselected", "discussionids"]);
  const nativeField = (name) => allowed.has(name) || /^_qf__/.test(name) || /^mform_isexpanded_[A-Za-z0-9_]+$/.test(name)
    || /^(?:from|to)\[(?:enabled|year|month|day|hour|minute)\]$/.test(name);
  if (allControls.some((control) => !nativeField(control.name))) return failed("moodle_forum_export_form_invalid", formResponse.status);
  const values = new FormData();
  for (const control of allControls) {
    if (!/^_qf__/.test(control.name) && !/^mform_isexpanded_[A-Za-z0-9_]+$/.test(control.name) && control.name !== "id" && control.name !== "sesskey") continue;
    if (!(control instanceof HTMLInputElement) || !["checkbox", "radio"].includes(control.type) || control.checked) values.append(control.name, control.value);
  }
  const one = (name, expected) => [...values.entries()].filter(([key]) => key === name).length === 1 && values.get(name) === expected;
  if (!one("id", forumId) || !one("sesskey", cfg.sesskey)) return failed("moodle_forum_export_form_invalid", formResponse.status);
  const formats = [...form.querySelectorAll('select[name="format"]')];
  if (formats.length !== 1 || ![...formats[0].options].some((option) => option.value === "csv")) return failed("moodle_forum_export_format_unavailable", formResponse.status);
  values.append("format", "csv");
  const submit = [...form.querySelectorAll('input[type="submit"][name], button[type="submit"][name]')].filter((control) => !control.disabled && control.name === "submitbutton");
  if (submit.length !== 1 || !text(submit[0].value, 500)) return failed("moodle_forum_export_form_invalid", formResponse.status);
  values.append("submitbutton", submit[0].value);
  const readBounded = async (response) => {
    if (!response.body || typeof response.body.getReader !== "function" || typeof globalThis.TextDecoder !== "function") return null;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0; let output = "";
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) return { value: output + decoder.decode(), limited: false };
        if (!(chunk.value instanceof Uint8Array)) return null;
        bytes += chunk.value.byteLength;
        if (bytes > MAX_BYTES) { await reader.cancel(); return { value: "", limited: true }; }
        output += decoder.decode(chunk.value, { stream: true });
      }
    } catch { try { await reader.cancel(); } catch {} return null; }
  };
  if (!approved()) return failed("moodle_forum_export_context_changed");
  let data;
  try {
    const response = await fetch(action, { method: "POST", credentials: "include", cache: "no-store", redirect: "error", headers: { Accept: "text/csv" }, body: values });
    if (!response.ok || !sameRoute(response.url, action) || !sameContext()) return failed("moodle_forum_export_unavailable", response.status);
    // Content-Length can be absent or wrong. Count received bytes while decoding.
    const downloaded = await readBounded(response);
    if (!downloaded || downloaded.limited) return { ok: false, sent: false, complete: false, error: "moodle_forum_export_incomplete" };
    data = downloaded.value;
  } catch { return failed("moodle_forum_export_unavailable"); }
  const parseCsv = (raw) => {
    const rows = []; let row = []; let field = ""; let quoted = false;
    const source = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    for (let index = 0; index < source.length; index += 1) {
      const char = source[index];
      if (quoted) { if (char === '"' && source[index + 1] === '"') { field += char; index += 1; } else if (char === '"') quoted = false; else field += char; continue; }
      if (char === '"') { if (field) return null; quoted = true; } else if (char === ",") { row.push(field); field = ""; } else if (char === "\n") { if (field.endsWith("\r")) field = field.slice(0, -1); row.push(field); rows.push(row); if (rows.length > MAX_RECORDS + 1) return "limit"; row = []; field = ""; } else field += char;
    }
    if (quoted) return null;
    if (field || row.length) { row.push(field); rows.push(row); }
    return rows;
  };
  const rows = parseCsv(data);
  if (rows === "limit") return { ok: false, sent: false, complete: false, error: "moodle_forum_export_incomplete" };
  const expected = ["id", "discussion", "parent", "userid", "userfullname", "created", "modified", "subject", "message"];
  if (!Array.isArray(rows) || rows.length < 1 || rows[0].length < expected.length || expected.some((name, index) => rows[0][index] !== name)) return failed("moodle_forum_export_csv_invalid");
  const header = new Map(rows[0].map((name, index) => [name, index]));
  const posts = [];
  for (const row of rows.slice(1)) {
    if (row.length !== rows[0].length) return failed("moodle_forum_export_csv_invalid");
    const post = { id: id(row[header.get("id")]), discussion: id(row[header.get("discussion")]), parent: id(row[header.get("parent")]) || "0", author: { user_id: id(row[header.get("userid")]), name: row[header.get("userfullname")] }, created: Number(row[header.get("created")]), modified: Number(row[header.get("modified")]), subject: row[header.get("subject")], message: row[header.get("message")] };
    if (!post.id || !post.discussion || !/^(?:0|[1-9][0-9]{0,18})$/.test(post.parent) || !post.author.user_id || !Number.isSafeInteger(post.created) || !Number.isSafeInteger(post.modified) || post.created < 0 || post.modified < 0 || typeof post.author.name !== "string" || typeof post.subject !== "string" || typeof post.message !== "string") return failed("moodle_forum_export_csv_invalid");
    posts.push(post);
  }
  if (!approved()) return failed("moodle_forum_export_context_changed");
  return { ok: true, sent: false, complete: true, data: { course_id: courseId, forum_module_id: moduleId, forum_id: forumId, posts } };
}
