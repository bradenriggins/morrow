/**
 * Reads aggregate-only attempt states for one exact Moodle Quiz.
 *
 * Moodle's per-user attempt API returns IDs, marks, feedback, and other private
 * fields. This function keeps all source rows in the page world and returns
 * only bounded aggregate counts.
 */
export async function executeMoodleQuizAttemptSummaryInPage(rawInput) {
  const PROVIDER = "moodle";
  const OPERATION = "moodle.form.quiz.attempt_summary.read.v1";
  const TOOL = "moodle_get_quiz_attempt_summary";
  const SCHEMA = "morrow.moodle-quiz-attempt-summary.v1";
  const ROSTER_METHOD = "core_table_get_dynamic_table_content";
  const ATTEMPTS_METHOD = "mod_quiz_get_user_quiz_attempts";
  const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
  const MAX_PARTICIPANTS = 50;
  const MAX_ATTEMPTS_PER_PARTICIPANT = 50;
  const MAX_TOTAL_ATTEMPTS = 500;
  const STATES = Object.freeze(["notstarted", "inprogress", "overdue", "submitted", "finished", "abandoned"]);
  const STATE_SET = new Set(STATES);
  const ID = /^[1-9][0-9]{0,18}$/;
  const object = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
  const id = (value) => Number.isSafeInteger(value) && value > 0 ? String(value)
    : typeof value === "string" && ID.test(value) ? value : "";
  const fail = (error) => ({ ok: false, sent: false, error });
  const incomplete = () => ({ ok: false, sent: false, complete: false, error: "moodle_quiz_attempt_summary_incomplete" });
  const input = (() => { try { return typeof rawInput === "string" ? JSON.parse(rawInput) : rawInput; } catch { return null; } })();
  const cfg = globalThis.M?.cfg;
  if (!object(input) || !object(cfg) || typeof cfg.wwwroot !== "string" || typeof cfg.sesskey !== "string" || !cfg.sesskey) {
    return fail("moodle_quiz_attempt_summary_context_invalid");
  }
  let site;
  try { site = new URL(cfg.wwwroot); } catch { return fail("moodle_quiz_attempt_summary_context_invalid"); }
  const basePath = site.pathname.replace(/\/$/, "");
  const bodyCourse = String(globalThis.document?.body?.className || "").match(/(?:^|\s)course-([1-9][0-9]*)(?:\s|$)/)?.[1] || "";
  const courseId = id(cfg.courseId) || bodyCourse;
  const principalId = id(cfg.userId);
  const currentPath = String(globalThis.location?.pathname || "");
  if (site.protocol !== "https:" || site.search || site.hash || site.username || site.password
    || site.origin !== globalThis.location?.origin || !(currentPath === basePath || currentPath.startsWith(`${basePath}/`))
    || !courseId || !principalId) return fail("moodle_quiz_attempt_summary_context_invalid");
  const operation = input.operation;
  const args = input.arguments;
  const binding = input.binding;
  if (!object(operation) || operation.key !== OPERATION || operation.toolName !== TOOL || operation.provider !== PROVIDER || operation.readOnly !== true
    || !object(args) || Object.keys(args).length !== 2 || id(args.course_id) !== courseId || !id(args.module_id)
    || !object(binding) || binding.origin !== site.origin || binding.siteUrl !== site.href
    || id(binding.principalId) !== principalId || id(binding.courseId) !== courseId
    || !Number.isSafeInteger(input.expiresAt) || input.expiresAt <= Date.now()) return fail("moodle_quiz_attempt_summary_arguments_invalid");
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
  const hidden = (form, name) => {
    const values = [...form.querySelectorAll(`input[type="hidden"][name="${name}"]`)];
    return values.length === 1 ? values[0].value : "";
  };
  const quizInstance = async () => {
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
          && hidden(form, "modulename") === "quiz" && Boolean(id(hidden(form, "instance")));
      } catch { return false; }
    });
    return forms.length === 1 ? id(hidden(forms[0], "instance")) || null : null;
  };
  const ajax = async (method, methodArgs) => {
    if (Date.now() >= input.expiresAt || !sameContext()) return { error: "moodle_quiz_attempt_summary_context_changed" };
    const endpoint = url("/lib/ajax/service.php", { sesskey: cfg.sesskey, info: method });
    let response;
    try {
      response = await fetch(endpoint, {
        method: "POST", credentials: "include", cache: "no-store", redirect: "error",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify([{ index: 0, methodname: method, args: methodArgs }]),
      });
    } catch { return { error: "moodle_quiz_attempt_summary_request_failed" }; }
    const raw = await boundedText(response, endpoint);
    if (raw === "limit") return { incomplete: true };
    if (typeof raw !== "string") return { error: "moodle_quiz_attempt_summary_response_unavailable" };
    try {
      const payload = JSON.parse(raw);
      if (!Array.isArray(payload) || payload.length !== 1 || !object(payload[0]) || payload[0].index !== 0
        || payload[0].error || payload[0].exception || !("data" in payload[0])) return { error: "moodle_quiz_attempt_summary_response_invalid" };
      const data = typeof payload[0].data === "string" ? JSON.parse(payload[0].data) : payload[0].data;
      return object(data) ? { data } : { error: "moodle_quiz_attempt_summary_response_invalid" };
    } catch { return { error: "moodle_quiz_attempt_summary_response_invalid" }; }
  };
  const roster = async () => {
    const result = await ajax(ROSTER_METHOD, {
      component: "core_user", handler: "participants", uniqueid: `user-index-participants-${courseId}`,
      sortdata: [{ sortby: "lastname", sortorder: 4 }], filters: [{ name: "courseid", jointype: 1, values: [Number(courseId)] }],
      jointype: 1, firstinitial: "", lastinitial: "", pagenumber: 1, pagesize: MAX_PARTICIPANTS,
      hiddencolumns: [], resetpreferences: false,
    });
    if (result.incomplete) return "limit";
    if (!result.data || typeof result.data.html !== "string") return null;
    if (result.data.html.length > MAX_RESPONSE_BYTES || typeof globalThis.DOMParser !== "function") return "limit";
    let documentValue;
    try { documentValue = new DOMParser().parseFromString(result.data.html, "text/html"); } catch { return null; }
    const wrappers = [...documentValue.querySelectorAll('div[data-region="core_table/dynamic"][data-table-component="core_user"][data-table-handler="participants"]')]
      .filter((entry) => entry.getAttribute("data-table-uniqueid") === `user-index-participants-${courseId}`);
    if (wrappers.length !== 1) return null;
    const totalText = wrappers[0].getAttribute("data-table-total-rows") || "";
    if (!/^(?:0|[1-9][0-9]{0,5})$/.test(totalText)) return null;
    const total = Number(totalText);
    if (!Number.isSafeInteger(total) || total > MAX_PARTICIPANTS) return "limit";
    const participantIds = [];
    const seen = new Set();
    for (const row of wrappers[0].querySelectorAll("tbody tr")) {
      const inputs = [...row.querySelectorAll("input.usercheckbox")];
      if (inputs.length !== 1) return null;
      const participantId = (inputs[0].getAttribute("name") || "").match(/^user([1-9][0-9]{0,18})$/)?.[1] || "";
      if (!participantId || seen.has(participantId)) return null;
      seen.add(participantId);
      participantIds.push(participantId);
    }
    return participantIds.length === total ? participantIds : null;
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
  const quizId = await quizInstance();
  if (quizId === "limit") return incomplete();
  if (!quizId) return fail("moodle_quiz_attempt_summary_target_unavailable");
  const participantIds = await roster();
  if (participantIds === "limit") return incomplete();
  if (!participantIds) return fail("moodle_quiz_attempt_summary_roster_unavailable");
  const statusCounts = Object.fromEntries(STATES.map((state) => [state, 0]));
  const seenAttempts = new Set();
  for (const participantId of participantIds) {
    const result = await ajax(ATTEMPTS_METHOD, {
      quizid: Number(quizId), userid: Number(participantId), status: "all", includepreviews: false,
    });
    if (result.incomplete) return incomplete();
    if (!result.data || !Array.isArray(result.data.attempts)) return fail(result.error || "moodle_quiz_attempt_summary_attempts_unavailable");
    if (result.data.attempts.length > MAX_ATTEMPTS_PER_PARTICIPANT) return incomplete();
    for (const attempt of result.data.attempts) {
      const attemptId = id(attempt?.id);
      const attemptQuiz = id(attempt?.quiz);
      const attemptUser = id(attempt?.userid);
      const state = attempt?.state;
      if (!attemptId || seenAttempts.has(attemptId) || attemptQuiz !== quizId || attemptUser !== participantId || !STATE_SET.has(state)) {
        return fail("moodle_quiz_attempt_summary_response_invalid");
      }
      seenAttempts.add(attemptId);
      statusCounts[state] += 1;
      if (seenAttempts.size > MAX_TOTAL_ATTEMPTS) return incomplete();
    }
  }
  if (!sameContext() || Date.now() > input.expiresAt) return fail("moodle_quiz_attempt_summary_context_changed");
  const data = {
    schema: SCHEMA,
    provider: PROVIDER,
    course_id: Number(courseId),
    module_id: Number(moduleId),
    quiz_id: Number(quizId),
    participant_count: participantIds.length,
    total_attempt_count: seenAttempts.size,
    attempt_state_counts: statusCounts,
    proof: {
      method: "core_table_get_dynamic_table_content+mod_quiz_get_user_quiz_attempts",
      complete: true,
      exact_module_binding: "course_modedit_form",
      participant_page_size: MAX_PARTICIPANTS,
      participant_response_rows: participantIds.length,
      per_participant_attempt_limit: MAX_ATTEMPTS_PER_PARTICIPANT,
      total_attempt_limit: MAX_TOTAL_ATTEMPTS,
      attempt_response_rows: seenAttempts.size,
      attempt_request_count: participantIds.length,
    },
  };
  const snapshotDigest = await digest(data);
  if (!snapshotDigest) return fail("moodle_quiz_attempt_summary_digest_unavailable");
  return { ok: true, sent: false, complete: true, data, snapshot_digest: snapshotDigest };
}
