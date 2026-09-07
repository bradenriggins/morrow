/**
 * Reads SCORM attempt and tracking state for one exact Moodle SCORM activity.
 *
 * Both readers bind the activity through the native course/modedit.php SCORM
 * form and then use Moodle's read-only mod_scorm services. Neither one opens
 * /mod/scorm/view.php, player.php, loadSCO.php, or report.php, so neither can
 * start a launch, record a learner attempt, or write a report_viewed event.
 *
 * Route limit, read from Moodle v5.2.2 source:
 * public/mod/scorm/db/services.php registers every mod_scorm_* external
 * function without 'ajax' => true, and
 * public/lib/external/classes/external_api.php:211 refuses a function whose
 * allowed_from_ajax is false when lib/ajax/service.php calls it. On a site that
 * has not enabled those functions for the AJAX endpoint, both readers stop at
 * the first mod_scorm call and return moodle_scorm_attempt_summary_service_unavailable
 * or moodle_scorm_learner_report_service_unavailable. They return no counts and
 * no partial result in that case.
 *
 * Source: https://github.com/moodle/moodle/blob/v5.2.2/public/mod/scorm/classes/external.php
 * Report semantics: https://github.com/moodle/moodle/blob/v5.2.2/public/mod/scorm/report/basic/classes/report.php
 * Required capability: mod/scorm:viewreport at the exact module context.
 */

/**
 * Aggregates SCORM tracking for every permitted participant of one exact
 * activity. Moodle's track rows carry the learner ID, the SCO ID, and every raw
 * SCORM element the package wrote. This function keeps all of them in the page
 * world and returns bounded counts only.
 */
export async function executeMoodleScormAttemptSummaryInPage(rawInput) {
  const PROVIDER = "moodle";
  const OPERATION = "moodle.form.scorm.attempt_summary.read.v1";
  const TOOL = "moodle_get_scorm_attempt_summary";
  const SCHEMA = "morrow.moodle-scorm-attempt-summary.v1";
  const ROSTER_METHOD = "core_table_get_dynamic_table_content";
  const SCOES_METHOD = "mod_scorm_get_scorm_scoes";
  const ATTEMPT_COUNT_METHOD = "mod_scorm_get_scorm_attempt_count";
  const TRACKS_METHOD = "mod_scorm_get_scorm_sco_tracks";
  const METHOD_PROOF = "core_table_get_dynamic_table_content+mod_scorm_get_scorm_scoes+mod_scorm_get_scorm_attempt_count+mod_scorm_get_scorm_sco_tracks";
  const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
  const MAX_PARTICIPANTS = 10_000;
  const MAX_SCOES = 200;
  const MAX_ATTEMPTS_PER_PARTICIPANT = 50;
  const MAX_TOTAL_ATTEMPTS = 5_000;
  const MAX_TRACK_REQUESTS = 2_000;
  const STATUSES = Object.freeze(["passed", "completed", "failed", "incomplete", "browsed", "notattempted", "unknown"]);
  const BUCKETS = Object.freeze(["0-19", "20-39", "40-59", "60-79", "80-100", "unscored"]);
  const STATUS_SET = new Set(STATUSES);
  const ID = /^[1-9][0-9]{0,18}$/;
  const object = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
  const id = (value) => Number.isSafeInteger(value) && value > 0 ? String(value)
    : typeof value === "string" && ID.test(value) ? value : "";
  const fail = (error) => ({ ok: false, sent: false, error });
  const incomplete = () => ({ ok: false, sent: false, complete: false, error: "moodle_scorm_attempt_summary_incomplete" });
  const input = (() => { try { return typeof rawInput === "string" ? JSON.parse(rawInput) : rawInput; } catch { return null; } })();
  const cfg = globalThis.M?.cfg;
  if (!object(input) || !object(cfg) || typeof cfg.wwwroot !== "string" || typeof cfg.sesskey !== "string" || !cfg.sesskey) {
    return fail("moodle_scorm_attempt_summary_context_invalid");
  }
  let site;
  try { site = new URL(cfg.wwwroot); } catch { return fail("moodle_scorm_attempt_summary_context_invalid"); }
  const basePath = site.pathname.replace(/\/$/, "");
  const bodyCourse = String(globalThis.document?.body?.className || "").match(/(?:^|\s)course-([1-9][0-9]*)(?:\s|$)/)?.[1] || "";
  const courseId = id(cfg.courseId) || bodyCourse;
  const principalId = id(cfg.userId);
  const currentPath = String(globalThis.location?.pathname || "");
  if (site.protocol !== "https:" || site.search || site.hash || site.username || site.password
    || site.origin !== globalThis.location?.origin || !(currentPath === basePath || currentPath.startsWith(`${basePath}/`))
    || !courseId || !principalId) return fail("moodle_scorm_attempt_summary_context_invalid");
  const operation = input.operation;
  const args = input.arguments;
  const binding = input.binding;
  if (!object(operation) || operation.key !== OPERATION || operation.toolName !== TOOL || operation.provider !== PROVIDER || operation.readOnly !== true
    || !object(args) || Object.keys(args).length !== 2 || id(args.course_id) !== courseId || !id(args.module_id)
    || !object(binding) || binding.origin !== site.origin || binding.siteUrl !== site.href
    || id(binding.principalId) !== principalId || id(binding.courseId) !== courseId
    || !Number.isSafeInteger(input.expiresAt) || input.expiresAt <= Date.now()) return fail("moodle_scorm_attempt_summary_arguments_invalid");
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
  const scormInstance = async () => {
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
          && hidden(form, "modulename") === "scorm" && Boolean(id(hidden(form, "instance")));
      } catch { return false; }
    });
    return forms.length === 1 ? id(hidden(forms[0], "instance")) || null : null;
  };
  const ajax = async (method, methodArgs) => {
    if (Date.now() >= input.expiresAt || !sameContext()) return { error: "moodle_scorm_attempt_summary_context_changed" };
    const endpoint = url("/lib/ajax/service.php", { sesskey: cfg.sesskey, info: method });
    let response;
    try {
      response = await fetch(endpoint, {
        method: "POST", credentials: "include", cache: "no-store", redirect: "error",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify([{ index: 0, methodname: method, args: methodArgs }]),
      });
    } catch { return { error: "moodle_scorm_attempt_summary_request_failed" }; }
    const raw = await boundedText(response, endpoint);
    if (raw === "limit") return { incomplete: true };
    if (typeof raw !== "string") return { error: "moodle_scorm_attempt_summary_response_unavailable" };
    try {
      const payload = JSON.parse(raw);
      if (!Array.isArray(payload) || payload.length !== 1 || !object(payload[0]) || payload[0].index !== 0) {
        return { error: "moodle_scorm_attempt_summary_response_invalid" };
      }
      // Moodle refuses an external function that db/services.php did not enable
      // for the AJAX endpoint. Name that exact condition instead of reporting a
      // generic invalid response.
      if (object(payload[0].exception) && payload[0].exception.errorcode === "servicenotavailable") {
        return { error: "moodle_scorm_attempt_summary_service_unavailable" };
      }
      if (payload[0].error || payload[0].exception || !("data" in payload[0])) {
        return { error: "moodle_scorm_attempt_summary_response_invalid" };
      }
      const data = typeof payload[0].data === "string" ? JSON.parse(payload[0].data) : payload[0].data;
      return object(data) ? { data } : { error: "moodle_scorm_attempt_summary_response_invalid" };
    } catch { return { error: "moodle_scorm_attempt_summary_response_invalid" }; }
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
    if (!/^(?:0|[1-9][0-9]{0,6})$/.test(totalText)) return null;
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
  const number = (value) => {
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value !== "string" || !/^[+-]?(?:[0-9]+|[0-9]*\.[0-9]+)$/.test(value.trim())) return null;
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  };
  // Moodle derives `status` and `score_raw` from the raw SCORM 1.2 and 2004
  // elements in scorm_format_interactions(), and normalizes "not attempted"
  // to "notattempted" there. Any other reported status counts as "unknown".
  const trackStatus = (elements) => {
    const value = elements.get("status");
    return typeof value === "string" && STATUS_SET.has(value.trim()) ? value.trim() : "unknown";
  };
  const trackBucket = (elements) => {
    const scaled = number(elements.get("cmi.score.scaled"));
    const raw = number(elements.get("score_raw"));
    let percent = null;
    if (scaled !== null && scaled >= -1 && scaled <= 1) percent = scaled * 100;
    else if (raw !== null) {
      const minimum = number(elements.get("cmi.core.score.min")) ?? number(elements.get("cmi.score.min")) ?? 0;
      const maximum = number(elements.get("cmi.core.score.max")) ?? number(elements.get("cmi.score.max")) ?? 100;
      if (maximum > minimum) percent = ((raw - minimum) / (maximum - minimum)) * 100;
    }
    if (percent === null) return "unscored";
    const bounded = Math.round(Math.min(100, Math.max(0, percent)));
    return bounded < 20 ? "0-19" : bounded < 40 ? "20-39" : bounded < 60 ? "40-59" : bounded < 80 ? "60-79" : "80-100";
  };
  const trackElements = (tracks) => {
    if (!Array.isArray(tracks)) return null;
    const elements = new Map();
    for (const track of tracks) {
      const element = track?.element;
      const value = track?.value;
      if (typeof element !== "string" || !element || element.length > 255
        || (typeof value !== "string" && typeof value !== "number") || elements.has(element)) return null;
      elements.set(element, typeof value === "number" ? String(value) : value);
    }
    return elements;
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
  const scormId = await scormInstance();
  if (scormId === "limit") return incomplete();
  if (!scormId) return fail("moodle_scorm_attempt_summary_target_unavailable");
  const participantIds = await roster();
  if (participantIds === "limit") return incomplete();
  if (!participantIds) return fail("moodle_scorm_attempt_summary_roster_unavailable");
  const scoesResult = await ajax(SCOES_METHOD, { scormid: Number(scormId), organization: "" });
  if (scoesResult.incomplete) return incomplete();
  if (!scoesResult.data || !Array.isArray(scoesResult.data.scoes)) return fail(scoesResult.error || "moodle_scorm_attempt_summary_scoes_unavailable");
  if (scoesResult.data.scoes.length > MAX_SCOES) return incomplete();
  const trackedScoIds = [];
  const seenScoes = new Set();
  for (const sco of scoesResult.data.scoes) {
    const scoId = id(sco?.id);
    if (!scoId || seenScoes.has(scoId) || id(sco?.scorm) !== scormId || typeof sco?.scormtype !== "string") {
      return fail("moodle_scorm_attempt_summary_response_invalid");
    }
    seenScoes.add(scoId);
    // Only a launchable SCO carries tracking. An asset never does.
    if (sco.scormtype === "sco") trackedScoIds.push(scoId);
  }
  const statusCounts = Object.fromEntries(STATUSES.map((status) => [status, 0]));
  const bucketCounts = Object.fromEntries(BUCKETS.map((bucket) => [bucket, 0]));
  let totalAttempts = 0;
  let attemptedParticipants = 0;
  let trackRequests = 0;
  for (const participantId of participantIds) {
    const countResult = await ajax(ATTEMPT_COUNT_METHOD, {
      scormid: Number(scormId), userid: Number(participantId), ignoremissingcompletion: false,
    });
    if (countResult.incomplete) return incomplete();
    if (!countResult.data || !Number.isSafeInteger(countResult.data.attemptscount) || countResult.data.attemptscount < 0) {
      return fail(countResult.error || "moodle_scorm_attempt_summary_attempts_unavailable");
    }
    const attemptCount = countResult.data.attemptscount;
    if (attemptCount > MAX_ATTEMPTS_PER_PARTICIPANT) return incomplete();
    totalAttempts += attemptCount;
    if (totalAttempts > MAX_TOTAL_ATTEMPTS) return incomplete();
    if (attemptCount > 0) attemptedParticipants += 1;
    for (let attempt = 1; attempt <= attemptCount; attempt += 1) {
      for (const scoId of trackedScoIds) {
        if (trackRequests + 1 > MAX_TRACK_REQUESTS) return incomplete();
        trackRequests += 1;
        const trackResult = await ajax(TRACKS_METHOD, { scoid: Number(scoId), userid: Number(participantId), attempt });
        if (trackResult.incomplete) return incomplete();
        if (!trackResult.data || !object(trackResult.data.data)) return fail(trackResult.error || "moodle_scorm_attempt_summary_tracks_unavailable");
        const elements = trackResult.data.data.attempt === attempt ? trackElements(trackResult.data.data.tracks) : null;
        if (!elements) return fail("moodle_scorm_attempt_summary_response_invalid");
        statusCounts[elements.size === 0 ? "notattempted" : trackStatus(elements)] += 1;
        bucketCounts[elements.size === 0 ? "unscored" : trackBucket(elements)] += 1;
      }
    }
  }
  if (!sameContext() || Date.now() > input.expiresAt) return fail("moodle_scorm_attempt_summary_context_changed");
  const data = {
    schema: SCHEMA,
    provider: PROVIDER,
    course_id: Number(courseId),
    module_id: Number(moduleId),
    scorm_id: Number(scormId),
    participant_count: participantIds.length,
    attempted_participant_count: attemptedParticipants,
    total_attempt_count: totalAttempts,
    tracked_sco_count: trackedScoIds.length,
    tracked_record_count: trackRequests,
    sco_status_counts: statusCounts,
    score_bucket_counts: bucketCounts,
    proof: {
      method: METHOD_PROOF,
      complete: true,
      exact_module_binding: "course_modedit_form",
      required_capability: "mod/scorm:viewreport",
      participant_limit: MAX_PARTICIPANTS,
      participant_response_rows: participantIds.length,
      sco_limit: MAX_SCOES,
      per_participant_attempt_limit: MAX_ATTEMPTS_PER_PARTICIPANT,
      total_attempt_limit: MAX_TOTAL_ATTEMPTS,
      track_request_limit: MAX_TRACK_REQUESTS,
      track_request_count: trackRequests,
    },
  };
  const snapshotDigest = await digest(data);
  if (!snapshotDigest) return fail("moodle_scorm_attempt_summary_digest_unavailable");
  return { ok: true, sent: false, complete: true, data, snapshot_digest: snapshotDigest };
}

/**
 * Reads the SCORM tracking of one exact learner in one exact activity. The page
 * world sees the learner ID because Moodle's service requires it; the result
 * carries it only inside `learner`, which the MCP runtime projects to a stable
 * token through the complete course roster and refuses when the identity is not
 * on that roster. No raw SCORM element value ever leaves the page.
 */
export async function executeMoodleScormLearnerReportInPage(rawInput) {
  const PROVIDER = "moodle";
  const OPERATION = "moodle.form.scorm.learner_report.read.v1";
  const TOOL = "moodle_get_scorm_learner_report";
  const SCHEMA = "morrow.moodle-scorm-learner-report.v1";
  const SCOES_METHOD = "mod_scorm_get_scorm_scoes";
  const ATTEMPT_COUNT_METHOD = "mod_scorm_get_scorm_attempt_count";
  const TRACKS_METHOD = "mod_scorm_get_scorm_sco_tracks";
  const METHOD_PROOF = "mod_scorm_get_scorm_scoes+mod_scorm_get_scorm_attempt_count+mod_scorm_get_scorm_sco_tracks";
  const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
  const MAX_SCOES = 200;
  const MAX_ATTEMPTS = 50;
  const MAX_TRACK_REQUESTS = 500;
  const STATUSES = Object.freeze(["passed", "completed", "failed", "incomplete", "browsed", "notattempted", "unknown"]);
  const STATUS_SET = new Set(STATUSES);
  const ID = /^[1-9][0-9]{0,18}$/;
  const object = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
  const id = (value) => Number.isSafeInteger(value) && value > 0 ? String(value)
    : typeof value === "string" && ID.test(value) ? value : "";
  const fail = (error) => ({ ok: false, sent: false, error });
  const incomplete = () => ({ ok: false, sent: false, complete: false, error: "moodle_scorm_learner_report_incomplete" });
  const input = (() => { try { return typeof rawInput === "string" ? JSON.parse(rawInput) : rawInput; } catch { return null; } })();
  const cfg = globalThis.M?.cfg;
  if (!object(input) || !object(cfg) || typeof cfg.wwwroot !== "string" || typeof cfg.sesskey !== "string" || !cfg.sesskey) {
    return fail("moodle_scorm_learner_report_context_invalid");
  }
  let site;
  try { site = new URL(cfg.wwwroot); } catch { return fail("moodle_scorm_learner_report_context_invalid"); }
  const basePath = site.pathname.replace(/\/$/, "");
  const bodyCourse = String(globalThis.document?.body?.className || "").match(/(?:^|\s)course-([1-9][0-9]*)(?:\s|$)/)?.[1] || "";
  const courseId = id(cfg.courseId) || bodyCourse;
  const principalId = id(cfg.userId);
  const currentPath = String(globalThis.location?.pathname || "");
  if (site.protocol !== "https:" || site.search || site.hash || site.username || site.password
    || site.origin !== globalThis.location?.origin || !(currentPath === basePath || currentPath.startsWith(`${basePath}/`))
    || !courseId || !principalId) return fail("moodle_scorm_learner_report_context_invalid");
  const operation = input.operation;
  const args = input.arguments;
  const binding = input.binding;
  if (!object(operation) || operation.key !== OPERATION || operation.toolName !== TOOL || operation.provider !== PROVIDER || operation.readOnly !== true
    || !object(args) || Object.keys(args).length !== 3 || id(args.course_id) !== courseId || !id(args.module_id) || !id(args.user_id)
    || !object(binding) || binding.origin !== site.origin || binding.siteUrl !== site.href
    || id(binding.principalId) !== principalId || id(binding.courseId) !== courseId
    || !Number.isSafeInteger(input.expiresAt) || input.expiresAt <= Date.now()) return fail("moodle_scorm_learner_report_arguments_invalid");
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
  const scormInstance = async () => {
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
          && hidden(form, "modulename") === "scorm" && Boolean(id(hidden(form, "instance")));
      } catch { return false; }
    });
    return forms.length === 1 ? id(hidden(forms[0], "instance")) || null : null;
  };
  const ajax = async (method, methodArgs) => {
    if (Date.now() >= input.expiresAt || !sameContext()) return { error: "moodle_scorm_learner_report_context_changed" };
    const endpoint = url("/lib/ajax/service.php", { sesskey: cfg.sesskey, info: method });
    let response;
    try {
      response = await fetch(endpoint, {
        method: "POST", credentials: "include", cache: "no-store", redirect: "error",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify([{ index: 0, methodname: method, args: methodArgs }]),
      });
    } catch { return { error: "moodle_scorm_learner_report_request_failed" }; }
    const raw = await boundedText(response, endpoint);
    if (raw === "limit") return { incomplete: true };
    if (typeof raw !== "string") return { error: "moodle_scorm_learner_report_response_unavailable" };
    try {
      const payload = JSON.parse(raw);
      if (!Array.isArray(payload) || payload.length !== 1 || !object(payload[0]) || payload[0].index !== 0) {
        return { error: "moodle_scorm_learner_report_response_invalid" };
      }
      if (object(payload[0].exception) && payload[0].exception.errorcode === "servicenotavailable") {
        return { error: "moodle_scorm_learner_report_service_unavailable" };
      }
      if (payload[0].error || payload[0].exception || !("data" in payload[0])) {
        return { error: "moodle_scorm_learner_report_response_invalid" };
      }
      const data = typeof payload[0].data === "string" ? JSON.parse(payload[0].data) : payload[0].data;
      return object(data) ? { data } : { error: "moodle_scorm_learner_report_response_invalid" };
    } catch { return { error: "moodle_scorm_learner_report_response_invalid" }; }
  };
  const number = (value) => {
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value !== "string" || !/^[+-]?(?:[0-9]+|[0-9]*\.[0-9]+)$/.test(value.trim())) return null;
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  };
  const trackStatus = (elements) => {
    const value = elements.get("status");
    return typeof value === "string" && STATUS_SET.has(value.trim()) ? value.trim() : "unknown";
  };
  const trackPercent = (elements) => {
    const scaled = number(elements.get("cmi.score.scaled"));
    const raw = number(elements.get("score_raw"));
    let percent = null;
    if (scaled !== null && scaled >= -1 && scaled <= 1) percent = scaled * 100;
    else if (raw !== null) {
      const minimum = number(elements.get("cmi.core.score.min")) ?? number(elements.get("cmi.score.min")) ?? 0;
      const maximum = number(elements.get("cmi.core.score.max")) ?? number(elements.get("cmi.score.max")) ?? 100;
      if (maximum > minimum) percent = ((raw - minimum) / (maximum - minimum)) * 100;
    }
    return percent === null ? null : Math.round(Math.min(100, Math.max(0, percent)));
  };
  const trackElements = (tracks) => {
    if (!Array.isArray(tracks)) return null;
    const elements = new Map();
    for (const track of tracks) {
      const element = track?.element;
      const value = track?.value;
      if (typeof element !== "string" || !element || element.length > 255
        || (typeof value !== "string" && typeof value !== "number") || elements.has(element)) return null;
      elements.set(element, typeof value === "number" ? String(value) : value);
    }
    return elements;
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
  const scormId = await scormInstance();
  if (scormId === "limit") return incomplete();
  if (!scormId) return fail("moodle_scorm_learner_report_target_unavailable");
  const scoesResult = await ajax(SCOES_METHOD, { scormid: Number(scormId), organization: "" });
  if (scoesResult.incomplete) return incomplete();
  if (!scoesResult.data || !Array.isArray(scoesResult.data.scoes)) return fail(scoesResult.error || "moodle_scorm_learner_report_scoes_unavailable");
  if (scoesResult.data.scoes.length > MAX_SCOES) return incomplete();
  const trackedScoIds = [];
  const seenScoes = new Set();
  for (const sco of scoesResult.data.scoes) {
    const scoId = id(sco?.id);
    if (!scoId || seenScoes.has(scoId) || id(sco?.scorm) !== scormId || typeof sco?.scormtype !== "string") {
      return fail("moodle_scorm_learner_report_response_invalid");
    }
    seenScoes.add(scoId);
    if (sco.scormtype === "sco") trackedScoIds.push(scoId);
  }
  const countResult = await ajax(ATTEMPT_COUNT_METHOD, {
    scormid: Number(scormId), userid: Number(learnerId), ignoremissingcompletion: false,
  });
  if (countResult.incomplete) return incomplete();
  if (!countResult.data || !Number.isSafeInteger(countResult.data.attemptscount) || countResult.data.attemptscount < 0) {
    return fail(countResult.error || "moodle_scorm_learner_report_attempts_unavailable");
  }
  const attemptCount = countResult.data.attemptscount;
  if (attemptCount > MAX_ATTEMPTS || attemptCount * trackedScoIds.length > MAX_TRACK_REQUESTS) return incomplete();
  const attempts = [];
  let trackRequests = 0;
  for (let attempt = 1; attempt <= attemptCount; attempt += 1) {
    const records = [];
    for (const scoId of trackedScoIds) {
      trackRequests += 1;
      const trackResult = await ajax(TRACKS_METHOD, { scoid: Number(scoId), userid: Number(learnerId), attempt });
      if (trackResult.incomplete) return incomplete();
      if (!trackResult.data || !object(trackResult.data.data)) return fail(trackResult.error || "moodle_scorm_learner_report_tracks_unavailable");
      const elements = trackResult.data.data.attempt === attempt ? trackElements(trackResult.data.data.tracks) : null;
      if (!elements) return fail("moodle_scorm_learner_report_response_invalid");
      records.push({
        sco_id: Number(scoId),
        status: elements.size === 0 ? "notattempted" : trackStatus(elements),
        score_percent: elements.size === 0 ? null : trackPercent(elements),
      });
    }
    attempts.push({ attempt, records });
  }
  if (!sameContext() || Date.now() > input.expiresAt) return fail("moodle_scorm_learner_report_context_changed");
  const data = {
    schema: SCHEMA,
    provider: PROVIDER,
    course_id: Number(courseId),
    module_id: Number(moduleId),
    scorm_id: Number(scormId),
    learner: { user_id: learnerId },
    attempt_count: attemptCount,
    tracked_sco_count: trackedScoIds.length,
    attempts,
    proof: {
      method: METHOD_PROOF,
      complete: true,
      exact_module_binding: "course_modedit_form",
      required_capability: "mod/scorm:viewreport",
      attempt_limit: MAX_ATTEMPTS,
      sco_limit: MAX_SCOES,
      track_request_limit: MAX_TRACK_REQUESTS,
      track_request_count: trackRequests,
    },
  };
  const snapshotDigest = await digest(data);
  if (!snapshotDigest) return fail("moodle_scorm_learner_report_digest_unavailable");
  return { ok: true, sent: false, complete: true, data, snapshot_digest: snapshotDigest };
}
