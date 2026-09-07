/**
 * Reads an aggregate-only submission summary for one exact Moodle Assignment.
 *
 * The native participant response can contain learner identities. This function
 * aggregates it in the page world and never returns a row, user ID, name,
 * grade, comment, URL, or raw response value.
 */
export async function executeMoodleAssignmentSubmissionSummaryInPage(rawInput) {
  const PROVIDER = "moodle";
  const OPERATION = "moodle.form.assign.submissions.read.v1";
  const TOOL = "moodle_get_assignment_submission_summary";
  const SCHEMA = "morrow.moodle-assignment-submission-summary.v1";
  const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
  const MAX_PARTICIPANTS = 10_000;
  const ID = /^[1-9][0-9]{0,18}$/;
  const STATUSES = new Set(["new", "reopened", "draft", "submitted"]);
  const object = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
  const id = (value) => {
    const text = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : typeof value === "string" ? value : "";
    return ID.test(text) ? text : "";
  };
  const text = (value, maximum = 1_024) => typeof value === "string" && value.length > 0 && value.length <= maximum
    && !/[\u0000-\u001f\u007f]/.test(value);
  const fail = (error, status) => ({ ok: false, sent: false, ...(Number.isInteger(status) ? { status } : {}), error });
  const incomplete = () => ({ ok: false, sent: false, complete: false, error: "moodle_assignment_submission_summary_incomplete" });
  const input = (() => { try { return typeof rawInput === "string" ? JSON.parse(rawInput) : rawInput; } catch { return null; } })();
  const cfg = globalThis.M?.cfg;
  if (!object(input) || !object(cfg) || typeof cfg.wwwroot !== "string" || !text(cfg.sesskey, 1_024)) {
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
    || !object(args) || Object.keys(args).length !== 2 || id(args.course_id) !== courseId || !id(args.module_id)
    || !object(binding) || binding.origin !== site.origin || binding.siteUrl !== site.href
    || id(binding.principalId) !== principalId || id(binding.courseId) !== courseId
    || !Number.isSafeInteger(input.expiresAt) || input.expiresAt <= Date.now()) return fail("moodle_assignment_submission_arguments_invalid");
  const moduleId = id(args.module_id);
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
  const oneHidden = (form, name, expected) => {
    const matches = [...form.querySelectorAll(`input[type="hidden"][name="${name}"]`)];
    return matches.length === 1 && matches[0].value === expected;
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
        const exactAction = actionUrl.origin === endpoint.origin && actionUrl.pathname === endpoint.pathname && !actionUrl.hash
          && !actionUrl.username && !actionUrl.password
          && (actionUrl.search === "" || actionUrl.search === endpoint.search);
        return exactAction && oneHidden(form, "course", courseId) && oneHidden(form, "coursemodule", moduleId)
          && oneHidden(form, "update", moduleId) && oneHidden(form, "modulename", "assign") && oneHidden(form, "instance", form.querySelector('input[type="hidden"][name="instance"]')?.value || "");
      } catch { return false; }
    });
    if (forms.length !== 1) return null;
    const instance = forms[0].querySelector('input[type="hidden"][name="instance"]')?.value || "";
    return id(instance) || null;
  };
  const ajax = async (assignmentId) => {
    const endpoint = url("/lib/ajax/service.php", { sesskey: cfg.sesskey, info: "mod_assign_list_participants" });
    const argsValue = {
      assignid: Number(assignmentId), groupid: 0, filter: "", skip: 0, limit: 0,
      onlyids: true, includeenrolments: false, tablesort: false, marking: false,
    };
    let response;
    try {
      response = await fetch(endpoint, {
        method: "POST", credentials: "include", cache: "no-store", redirect: "error",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify([{ index: 0, methodname: "mod_assign_list_participants", args: argsValue }]),
      });
    } catch { return null; }
    const raw = await boundedText(response, endpoint);
    if (raw === "limit") return "limit";
    try {
      const payload = JSON.parse(raw);
      return Array.isArray(payload) && payload.length === 1 && payload[0]?.index === 0 && !object(payload[0]?.error)
        && typeof payload[0]?.data === "string" ? JSON.parse(payload[0].data) : null;
    } catch { return null; }
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
  const instance = await assignmentInstance();
  if (instance === "limit") return incomplete();
  if (!instance) return fail("moodle_assignment_submission_target_unavailable");
  if (Date.now() > input.expiresAt || !sameContext()) return fail("moodle_assignment_submission_context_changed");
  const rows = await ajax(instance);
  if (rows === "limit") return incomplete();
  if (!Array.isArray(rows)) return fail("moodle_assignment_submission_unavailable");
  if (rows.length > MAX_PARTICIPANTS) return incomplete();
  const statusCounts = { new: 0, reopened: 0, draft: 0, submitted: 0 };
  const participantIds = new Set();
  let submittedCount = 0;
  let requiresGradingCount = 0;
  let grantedExtensionCount = 0;
  for (const row of rows) {
    const participantId = id(row?.id);
    const status = row?.submissionstatus;
    if (!participantId || participantIds.has(participantId) || !STATUSES.has(status)
      || typeof row?.submitted !== "boolean" || typeof row?.requiregrading !== "boolean" || typeof row?.grantedextension !== "boolean") {
      return fail("moodle_assignment_submission_response_invalid");
    }
    participantIds.add(participantId);
    statusCounts[status] += 1;
    if (row.submitted) submittedCount += 1;
    if (row.requiregrading) requiresGradingCount += 1;
    if (row.grantedextension) grantedExtensionCount += 1;
  }
  if (!sameContext() || Date.now() > input.expiresAt) return fail("moodle_assignment_submission_context_changed");
  const data = {
    schema: SCHEMA,
    provider: PROVIDER,
    course_id: Number(courseId),
    module_id: Number(moduleId),
    assignment_id: Number(instance),
    participant_count: rows.length,
    submitted_count: submittedCount,
    requires_grading_count: requiresGradingCount,
    granted_extension_count: grantedExtensionCount,
    submission_status_counts: statusCounts,
    proof: {
      method: "mod_assign_list_participants",
      complete: true,
      exact_module_binding: "course_modedit_form",
      requested_limit: 0,
      response_row_count: rows.length,
    },
  };
  const snapshotDigest = await digest(data);
  if (!snapshotDigest) return fail("moodle_assignment_submission_digest_unavailable");
  return { ok: true, sent: false, complete: true, data, snapshot_digest: snapshotDigest };
}
