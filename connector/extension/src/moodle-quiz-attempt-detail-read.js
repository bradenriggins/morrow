/**
 * Reads Moodle Quiz attempt records, the manual grading queue, and the regrade
 * state of one exact Quiz through Moodle's own report routes.
 *
 * Route choice. Every read here fetches `/mod/quiz/report.php` with a fixed
 * `mode`, which is the entry point for the report plugins under
 * `public/mod/quiz/report/`. None of these reads opens `/mod/quiz/attempt.php`,
 * `/mod/quiz/review.php`, or `/mod/quiz/reviewquestion.php`, so none of them can
 * continue an attempt, record an attempt review, or write learner state. The
 * report route does record one `\mod_quiz\event\report_viewed` event for the
 * signed-in teacher; that is a teacher action in the course log, and it is
 * disclosed in every result proof block.
 *
 * The regrade actions live on the same route, and Moodle guards each one with
 * `confirm_sesskey()` and `mod/quiz:regrade`
 * (public/mod/quiz/report/overview/report.php `process_regrade_actions`). These
 * reads send no `sesskey` and no regrade parameter, so the route cannot start a
 * regrade.
 *
 * Capabilities. `mode=overview` is listed for a person who holds
 * `mod/quiz:viewreports`, and `quiz_grading_report::display()` calls
 * `require_capability('mod/quiz:grade')` before it renders the manual grading
 * index, so the site enforces both at the exact module context.
 *
 * Language limit. Moodle renders the attempt state, the started and completed
 * times, and the duration through the language pack and the reader's time zone.
 * The attempt read resolves the state key from the report page's own state
 * filter labels and refuses when it cannot; it returns the time values as the
 * exact text Moodle rendered and never parses them into an instant.
 *
 * Sources, read from Moodle v5.2.2:
 * https://github.com/moodle/moodle/blob/v5.2.2/public/mod/quiz/report.php
 * https://github.com/moodle/moodle/blob/v5.2.2/public/mod/quiz/report/overview/report.php
 * https://github.com/moodle/moodle/blob/v5.2.2/public/mod/quiz/report/overview/overview_table.php
 * https://github.com/moodle/moodle/blob/v5.2.2/public/mod/quiz/report/grading/report.php
 */

/**
 * Reads one exact Quiz attempt from the Grades (overview) report: its state,
 * the rendered start, finish, and duration text, and one record per question
 * slot with the question state class and the mark Moodle displayed. It returns
 * no response text and no learner name. The Moodle user ID survives only inside
 * `learner`, which the MCP runtime projects to a stable token through the
 * complete course roster and refuses when the identity is not on it.
 */
export async function executeMoodleQuizAttemptInPage(rawInput) {
  const PROVIDER = "moodle";
  const OPERATION = "moodle.form.quiz.attempt_detail.read.v1";
  const TOOL = "moodle_get_quiz_attempt";
  const SCHEMA = "morrow.moodle-quiz-attempt.v1";
  const METHOD_PROOF = "quiz_report_overview_page";
  const ROUTE_PROOF = "/mod/quiz/report.php?mode=overview";
  const AVOIDED_ROUTES = "/mod/quiz/attempt.php+/mod/quiz/review.php+/mod/quiz/reviewquestion.php";
  const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
  const PAGE_SIZE = 100;
  const MAX_PAGES = 10;
  const MAX_SLOTS = 100;
  const MAX_DISPLAY_LENGTH = 120;
  const STATES = Object.freeze(["notstarted", "inprogress", "overdue", "submitted", "finished", "abandoned"]);
  // question_state::get_state_class(true) in public/question/engine/states.php.
  const SLOT_STATES = Object.freeze([
    "notyetanswered", "invalidanswer", "answersaved", "requiresgrading", "complete",
    "correct", "partiallycorrect", "incorrect", "notanswered",
  ]);
  const SLOT_STATE_SET = new Set(SLOT_STATES);
  const ID = /^[1-9][0-9]{0,18}$/;
  const object = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
  const id = (value) => Number.isSafeInteger(value) && value > 0 ? String(value)
    : typeof value === "string" && ID.test(value) ? value : "";
  const fail = (error) => ({ ok: false, sent: false, error });
  const incomplete = () => ({ ok: false, sent: false, complete: false, error: "moodle_quiz_attempt_incomplete" });
  const input = (() => { try { return typeof rawInput === "string" ? JSON.parse(rawInput) : rawInput; } catch { return null; } })();
  const cfg = globalThis.M?.cfg;
  if (!object(input) || !object(cfg) || typeof cfg.wwwroot !== "string" || typeof cfg.sesskey !== "string" || !cfg.sesskey) {
    return fail("moodle_quiz_attempt_context_invalid");
  }
  let site;
  try { site = new URL(cfg.wwwroot); } catch { return fail("moodle_quiz_attempt_context_invalid"); }
  const basePath = site.pathname.replace(/\/$/, "");
  const bodyCourse = String(globalThis.document?.body?.className || "").match(/(?:^|\s)course-([1-9][0-9]*)(?:\s|$)/)?.[1] || "";
  const courseId = id(cfg.courseId) || bodyCourse;
  const principalId = id(cfg.userId);
  const currentPath = String(globalThis.location?.pathname || "");
  if (site.protocol !== "https:" || site.search || site.hash || site.username || site.password
    || site.origin !== globalThis.location?.origin || !(currentPath === basePath || currentPath.startsWith(`${basePath}/`))
    || !courseId || !principalId) return fail("moodle_quiz_attempt_context_invalid");
  const operation = input.operation;
  const args = input.arguments;
  const binding = input.binding;
  if (!object(operation) || operation.key !== OPERATION || operation.toolName !== TOOL || operation.provider !== PROVIDER || operation.readOnly !== true
    || !object(args) || Object.keys(args).length !== 3 || id(args.course_id) !== courseId || !id(args.module_id) || !id(args.attempt_id)
    || !object(binding) || binding.origin !== site.origin || binding.siteUrl !== site.href
    || id(binding.principalId) !== principalId || id(binding.courseId) !== courseId
    || !Number.isSafeInteger(input.expiresAt) || input.expiresAt <= Date.now()) return fail("moodle_quiz_attempt_arguments_invalid");
  const moduleId = id(args.module_id);
  const attemptId = id(args.attempt_id);
  const sameContext = () => globalThis.M?.cfg?.sesskey === cfg.sesskey && id(globalThis.M?.cfg?.userId) === principalId
    && (id(globalThis.M?.cfg?.courseId) || bodyCourse) === courseId;
  const url = (path, query) => {
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
  // Moodle's own report page for the exact course module. The body id proves the
  // page type and the body class proves the course, so no separate settings-form
  // read is needed to bind the module.
  const reportPage = async (page) => {
    if (Date.now() >= input.expiresAt || !sameContext()) return "context";
    const endpoint = url("/mod/quiz/report.php", {
      id: moduleId, mode: "overview", attempts: "all_with", onlygraded: "0", onlyregraded: "0",
      slotmarks: "1", states: STATES.join("-"), pagesize: String(PAGE_SIZE), page: String(page),
    });
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
    const body = documentValue.body;
    const bodyClass = String(body?.className || "");
    if (!body || body.getAttribute("id") !== "page-mod-quiz-report"
      || !new RegExp(`(?:^|\\s)course-${courseId}(?:\\s|$)`).test(bodyClass)) return null;
    return { endpoint, documentValue };
  };
  const text = (node) => String(node?.textContent || "").replace(/\s+/gu, " ").trim();
  const cellIndex = (cell) => {
    const match = String(cell?.className || "").match(/(?:^|\s)c([0-9]{1,3})(?:\s|$)/);
    return match ? Number(match[1]) : null;
  };
  const linkParam = (element, expectedPath, parameter, endpoint) => {
    const href = element?.getAttribute("href");
    if (typeof href !== "string" || !href) return "";
    try {
      const target = new URL(href, endpoint);
      return target.origin === site.origin && target.pathname === `${basePath}${expectedPath}`
        ? target.searchParams.get(parameter) || ""
        : "";
    } catch { return ""; }
  };
  // The report page renders its own state filter. Each checkbox name carries the
  // Moodle state key and its label carries the language string that the state
  // column shows, so the key is read from the page instead of guessed.
  const stateLabels = (documentValue) => {
    const labels = new Map();
    for (const state of STATES) {
      const control = documentValue.querySelector(`input[type="checkbox"][name="state${state}"]`);
      const controlId = control?.getAttribute("id") || "";
      const label = /^[A-Za-z0-9_-]{1,120}$/.test(controlId) ? documentValue.querySelector(`label[for="${controlId}"]`) : null;
      const value = text(label);
      if (!control || !value || labels.has(value)) return null;
      labels.set(value, state);
    }
    return labels;
  };
  const columnIndexes = (table, endpoint) => {
    const headers = [...table.querySelectorAll("thead th")];
    if (headers.length === 0) return null;
    const indexes = new Map();
    for (const header of headers) {
      const index = cellIndex(header);
      if (index === null) return null;
      for (const link of header.querySelectorAll("a[href]")) {
        const column = linkParam(link, "/mod/quiz/report.php", "tsort", endpoint);
        if (column && !indexes.has(column)) indexes.set(column, index);
      }
    }
    return indexes;
  };
  const cellAt = (row, index) => {
    if (index === null || index === undefined) return null;
    const cells = [...row.children].filter((cell) => cellIndex(cell) === index);
    return cells.length === 1 ? cells[0] : null;
  };
  const withoutControls = (cell) => {
    if (!cell) return "";
    const copy = cell.cloneNode(true);
    for (const control of copy.querySelectorAll("a, button, form, script, del, input, label")) control.remove();
    return text(copy);
  };
  const displayValue = (cell) => {
    const value = withoutControls(cell);
    return !value || value === "-" ? null : value.slice(0, MAX_DISPLAY_LENGTH);
  };
  // A regraded slot renders the old mark inside <del> before the new one, so the
  // old mark is dropped and the separator Moodle writes between them with it.
  const markText = (element) => {
    const copy = element.cloneNode(true);
    for (const previous of copy.querySelectorAll("del")) previous.remove();
    return text(copy).replace(/^\/\s*/u, "");
  };
  // quiz_rescale_grade() formats the mark with format_float(), which uses the
  // language pack decimal separator. Any other text, including the localized
  // "Requires grading", is reported as no mark; the slot state carries that.
  const mark = (value) => {
    if (!/^-?(?:[0-9]+|[0-9]*[.,][0-9]+)$/u.test(value)) return null;
    const parsed = Number(value.replace(",", "."));
    return Number.isFinite(parsed) ? parsed : null;
  };
  const rowAttempts = (row, endpoint) => {
    const found = new Set();
    for (const control of row.querySelectorAll('input[name="attemptid[]"]')) {
      const value = id(control.getAttribute("value") || "");
      if (value) found.add(value);
    }
    for (const link of row.querySelectorAll("a[href]")) {
      for (const path of ["/mod/quiz/review.php", "/mod/quiz/reviewquestion.php"]) {
        const value = id(linkParam(link, path, "attempt", endpoint));
        if (value) found.add(value);
      }
    }
    return found;
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

  let labels = null;
  let match = null;
  let pageCount = 0;
  let rowCount = 0;
  for (let page = 0; page < MAX_PAGES && !match; page += 1) {
    const loaded = await reportPage(page);
    if (loaded === "limit") return incomplete();
    if (loaded === "context") return fail("moodle_quiz_attempt_context_changed");
    if (!loaded) return fail("moodle_quiz_attempt_target_unavailable");
    pageCount += 1;
    if (!labels) {
      labels = stateLabels(loaded.documentValue);
      if (!labels) return fail("moodle_quiz_attempt_state_unresolved");
    }
    const table = loaded.documentValue.querySelector("table#attempts");
    if (!table) return fail("moodle_quiz_attempt_target_unavailable");
    const indexes = columnIndexes(table, loaded.endpoint);
    if (!indexes) return fail("moodle_quiz_attempt_response_invalid");
    let pageRows = 0;
    for (const row of table.querySelectorAll("tbody tr")) {
      const attempts = rowAttempts(row, loaded.endpoint);
      if (attempts.size === 0) continue;
      pageRows += 1;
      if (attempts.has(attemptId)) {
        if (attempts.size !== 1 || match) return fail("moodle_quiz_attempt_response_invalid");
        match = { row, indexes, endpoint: loaded.endpoint };
      }
    }
    rowCount += pageRows;
    if (!match && pageRows < PAGE_SIZE) return fail("moodle_quiz_attempt_not_found");
  }
  if (!match) return incomplete();

  const learnerIds = new Set();
  for (const link of match.row.querySelectorAll("a[href]")) {
    const learnerId = id(linkParam(link, "/user/view.php", "id", match.endpoint));
    if (learnerId && linkParam(link, "/user/view.php", "course", match.endpoint) === courseId) learnerIds.add(learnerId);
  }
  if (learnerIds.size !== 1) return fail("moodle_quiz_attempt_learner_unavailable");
  const [learnerId] = learnerIds;
  const stateCell = cellAt(match.row, match.indexes.get("state"));
  const state = labels.get(withoutControls(stateCell)) || "";
  if (!stateCell || !state) return fail("moodle_quiz_attempt_state_unresolved");
  const slots = [];
  for (const [column, index] of match.indexes) {
    const slotNumber = column.match(/^qsgrade([1-9][0-9]{0,4})$/u)?.[1];
    if (!slotNumber) continue;
    if (slots.length + 1 > MAX_SLOTS) return incomplete();
    const cell = cellAt(match.row, index);
    if (!cell) return fail("moodle_quiz_attempt_response_invalid");
    const links = [...cell.querySelectorAll("a[href]")]
      .filter((link) => linkParam(link, "/mod/quiz/reviewquestion.php", "attempt", match.endpoint) === attemptId);
    if (links.length > 1) return fail("moodle_quiz_attempt_response_invalid");
    const link = links[0];
    if (link && linkParam(link, "/mod/quiz/reviewquestion.php", "slot", match.endpoint) !== slotNumber) {
      return fail("moodle_quiz_attempt_response_invalid");
    }
    const markers = link
      ? [...link.querySelectorAll("span[class]")].filter((span) => [...span.classList].some((entry) => SLOT_STATE_SET.has(entry)))
      : [];
    if (markers.length > 1) return fail("moodle_quiz_attempt_response_invalid");
    const marker = markers[0] || null;
    const source = marker || link;
    slots.push({
      slot: Number(slotNumber),
      state: marker ? [...marker.classList].find((entry) => SLOT_STATE_SET.has(entry)) : null,
      mark: source ? mark(markText(source)) : null,
      regraded: Boolean(cell.querySelector("del")),
    });
  }
  slots.sort((left, right) => left.slot - right.slot);
  if (new Set(slots.map((slot) => slot.slot)).size !== slots.length) return fail("moodle_quiz_attempt_response_invalid");
  if (!sameContext() || Date.now() > input.expiresAt) return fail("moodle_quiz_attempt_context_changed");
  const data = {
    schema: SCHEMA,
    provider: PROVIDER,
    course_id: Number(courseId),
    module_id: Number(moduleId),
    attempt_id: Number(attemptId),
    state,
    started_display: displayValue(cellAt(match.row, match.indexes.get("timestart"))),
    completed_display: displayValue(cellAt(match.row, match.indexes.get("timefinish"))),
    duration_display: displayValue(cellAt(match.row, match.indexes.get("duration"))),
    slot_count: slots.length,
    slots,
    learner: { user_id: learnerId },
    proof: {
      method: METHOD_PROOF,
      route: ROUTE_PROOF,
      complete: true,
      exact_module_binding: "quiz_report_page",
      required_capability: "mod/quiz:viewreports",
      avoided_routes: AVOIDED_ROUTES,
      records_learner_state: false,
      records_report_viewed_event: true,
      sesskey_sent: false,
      page_size: PAGE_SIZE,
      page_count: pageCount,
      row_count: rowCount,
      slot_limit: MAX_SLOTS,
    },
  };
  const snapshotDigest = await digest(data);
  if (!snapshotDigest) return fail("moodle_quiz_attempt_digest_unavailable");
  return { ok: true, sent: false, complete: true, data, snapshot_digest: snapshotDigest };
}

/**
 * Reads the manual grading index of one exact Quiz: for each listed question,
 * the slot, the question ID, and the counts of responses that need grading, that
 * were graded by hand, and in total. The index names no learner and carries no
 * response text, so this result is aggregate only.
 */
export async function executeMoodleQuizManualGradingQueueInPage(rawInput) {
  const PROVIDER = "moodle";
  const OPERATION = "moodle.form.quiz.manual_grading_queue.read.v1";
  const TOOL = "moodle_get_quiz_manual_grading_queue";
  const SCHEMA = "morrow.moodle-quiz-manual-grading-queue.v1";
  const METHOD_PROOF = "quiz_report_grading_index";
  const ROUTE_PROOF = "/mod/quiz/report.php?mode=grading";
  const AVOIDED_ROUTES = "/mod/quiz/attempt.php+/mod/quiz/review.php+/mod/quiz/reviewquestion.php";
  const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
  const MAX_QUESTIONS = 200;
  // qno, question type, question name, to grade, already graded, total.
  const INDEX_COLUMNS = 6;
  const ID = /^[1-9][0-9]{0,18}$/;
  const object = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
  const id = (value) => Number.isSafeInteger(value) && value > 0 ? String(value)
    : typeof value === "string" && ID.test(value) ? value : "";
  const fail = (error) => ({ ok: false, sent: false, error });
  const incomplete = () => ({ ok: false, sent: false, complete: false, error: "moodle_quiz_manual_grading_queue_incomplete" });
  const input = (() => { try { return typeof rawInput === "string" ? JSON.parse(rawInput) : rawInput; } catch { return null; } })();
  const cfg = globalThis.M?.cfg;
  if (!object(input) || !object(cfg) || typeof cfg.wwwroot !== "string" || typeof cfg.sesskey !== "string" || !cfg.sesskey) {
    return fail("moodle_quiz_manual_grading_queue_context_invalid");
  }
  let site;
  try { site = new URL(cfg.wwwroot); } catch { return fail("moodle_quiz_manual_grading_queue_context_invalid"); }
  const basePath = site.pathname.replace(/\/$/, "");
  const bodyCourse = String(globalThis.document?.body?.className || "").match(/(?:^|\s)course-([1-9][0-9]*)(?:\s|$)/)?.[1] || "";
  const courseId = id(cfg.courseId) || bodyCourse;
  const principalId = id(cfg.userId);
  const currentPath = String(globalThis.location?.pathname || "");
  if (site.protocol !== "https:" || site.search || site.hash || site.username || site.password
    || site.origin !== globalThis.location?.origin || !(currentPath === basePath || currentPath.startsWith(`${basePath}/`))
    || !courseId || !principalId) return fail("moodle_quiz_manual_grading_queue_context_invalid");
  const operation = input.operation;
  const args = input.arguments;
  const binding = input.binding;
  if (!object(operation) || operation.key !== OPERATION || operation.toolName !== TOOL || operation.provider !== PROVIDER || operation.readOnly !== true
    || !object(args) || Object.keys(args).length !== 2 || id(args.course_id) !== courseId || !id(args.module_id)
    || !object(binding) || binding.origin !== site.origin || binding.siteUrl !== site.href
    || id(binding.principalId) !== principalId || id(binding.courseId) !== courseId
    || !Number.isSafeInteger(input.expiresAt) || input.expiresAt <= Date.now()) return fail("moodle_quiz_manual_grading_queue_arguments_invalid");
  const moduleId = id(args.module_id);
  const sameContext = () => globalThis.M?.cfg?.sesskey === cfg.sesskey && id(globalThis.M?.cfg?.userId) === principalId
    && (id(globalThis.M?.cfg?.courseId) || bodyCourse) === courseId;
  const url = (path, query) => {
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
  const text = (node) => String(node?.textContent || "").replace(/\s+/gu, " ").trim();
  const withoutLinks = (cell) => {
    if (!cell) return "";
    const copy = cell.cloneNode(true);
    for (const link of copy.querySelectorAll("a, button, form, script")) link.remove();
    return text(copy);
  };
  const count = (cell) => {
    const value = withoutLinks(cell);
    return /^(?:0|[1-9][0-9]{0,6})$/.test(value) ? Number(value) : null;
  };
  const linkParam = (element, parameter, endpoint) => {
    const href = element?.getAttribute("href");
    if (typeof href !== "string" || !href) return "";
    try {
      const target = new URL(href, endpoint);
      return target.origin === site.origin && target.pathname === `${basePath}/mod/quiz/report.php`
        ? target.searchParams.get(parameter) || ""
        : "";
    } catch { return ""; }
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
  if (Date.now() >= input.expiresAt || !sameContext()) return fail("moodle_quiz_manual_grading_queue_context_changed");
  const endpoint = url("/mod/quiz/report.php", { id: moduleId, mode: "grading" });
  let response;
  try {
    response = await fetch(endpoint, {
      method: "GET", credentials: "include", cache: "no-store", redirect: "error", headers: { Accept: "text/html" },
    });
  } catch { return fail("moodle_quiz_manual_grading_queue_request_failed"); }
  const html = await boundedText(response, endpoint);
  if (html === "limit") return incomplete();
  if (typeof html !== "string" || typeof globalThis.DOMParser !== "function") return fail("moodle_quiz_manual_grading_queue_response_unavailable");
  let documentValue;
  try { documentValue = new DOMParser().parseFromString(html, "text/html"); } catch { return fail("moodle_quiz_manual_grading_queue_response_unavailable"); }
  const body = documentValue.body;
  const bodyClass = String(body?.className || "");
  // The index heading is rendered only by quiz_grading_report::display_index(),
  // so its absence means this is not the manual grading index. Without it an
  // error page would read as an empty queue.
  if (!body || body.getAttribute("id") !== "page-mod-quiz-report"
    || !new RegExp(`(?:^|\\s)course-${courseId}(?:\\s|$)`).test(bodyClass)
    || !documentValue.querySelector("p.toggleincludeauto")) return fail("moodle_quiz_manual_grading_queue_target_unavailable");
  const questions = [];
  const table = documentValue.querySelector("table#questionstograde");
  if (table) {
    if ([...table.querySelectorAll("thead th")].length !== INDEX_COLUMNS) return fail("moodle_quiz_manual_grading_queue_response_invalid");
    for (const row of table.querySelectorAll("tbody tr")) {
      if (questions.length + 1 > MAX_QUESTIONS) return incomplete();
      const cells = [...row.children];
      if (cells.length !== INDEX_COLUMNS) return fail("moodle_quiz_manual_grading_queue_response_invalid");
      const links = [...row.querySelectorAll("a.gradetheselink")];
      const slots = new Set(links.map((link) => id(linkParam(link, "slot", endpoint))));
      const questionIds = new Set(links.map((link) => id(linkParam(link, "qid", endpoint))));
      const needsGrading = count(cells[3]);
      const manuallyGraded = count(cells[4]);
      const total = count(cells[5]);
      if (slots.size !== 1 || questionIds.size !== 1 || slots.has("") || questionIds.has("")
        || needsGrading === null || manuallyGraded === null || total === null
        || needsGrading + manuallyGraded > total) return fail("moodle_quiz_manual_grading_queue_response_invalid");
      questions.push({
        slot: Number([...slots][0]),
        question_id: Number([...questionIds][0]),
        needs_grading: needsGrading,
        manually_graded: manuallyGraded,
        total,
      });
    }
  }
  questions.sort((left, right) => left.slot - right.slot);
  if (new Set(questions.map((question) => question.slot)).size !== questions.length) {
    return fail("moodle_quiz_manual_grading_queue_response_invalid");
  }
  if (!sameContext() || Date.now() > input.expiresAt) return fail("moodle_quiz_manual_grading_queue_context_changed");
  const data = {
    schema: SCHEMA,
    provider: PROVIDER,
    course_id: Number(courseId),
    module_id: Number(moduleId),
    question_count: questions.length,
    needs_grading_count: questions.reduce((sum, question) => sum + question.needs_grading, 0),
    manually_graded_count: questions.reduce((sum, question) => sum + question.manually_graded, 0),
    response_count: questions.reduce((sum, question) => sum + question.total, 0),
    questions,
    proof: {
      method: METHOD_PROOF,
      route: ROUTE_PROOF,
      complete: true,
      exact_module_binding: "quiz_report_page",
      required_capability: "mod/quiz:grade",
      avoided_routes: AVOIDED_ROUTES,
      records_learner_state: false,
      records_report_viewed_event: true,
      sesskey_sent: false,
      includes_automatically_graded: false,
      question_limit: MAX_QUESTIONS,
      listed_question_rows: questions.length,
    },
  };
  const snapshotDigest = await digest(data);
  if (!snapshotDigest) return fail("moodle_quiz_manual_grading_queue_digest_unavailable");
  return { ok: true, sent: false, complete: true, data, snapshot_digest: snapshotDigest };
}

/**
 * Reads the regrade state of one exact Quiz from the Grades (overview) report
 * with Moodle's own "only regraded attempts" filter: how many attempts carry a
 * regrade record, and whether Moodle is offering to commit a dry-run regrade.
 * It names no learner and starts no regrade: the request carries no `sesskey`
 * and no regrade parameter, and Moodle refuses every regrade action without
 * both.
 */
export async function executeMoodleQuizRegradeReportInPage(rawInput) {
  const PROVIDER = "moodle";
  const OPERATION = "moodle.form.quiz.regrade_report.read.v1";
  const TOOL = "moodle_get_quiz_regrade_report";
  const SCHEMA = "morrow.moodle-quiz-regrade-report.v1";
  const METHOD_PROOF = "quiz_report_overview_regraded_filter";
  const ROUTE_PROOF = "/mod/quiz/report.php?mode=overview&onlyregraded=1";
  const AVOIDED_ROUTES = "/mod/quiz/attempt.php+/mod/quiz/review.php+/mod/quiz/reviewquestion.php";
  const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
  const PAGE_SIZE = 100;
  const MAX_PAGES = 10;
  const STATES = Object.freeze(["notstarted", "inprogress", "overdue", "submitted", "finished", "abandoned"]);
  const ID = /^[1-9][0-9]{0,18}$/;
  const object = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
  const id = (value) => Number.isSafeInteger(value) && value > 0 ? String(value)
    : typeof value === "string" && ID.test(value) ? value : "";
  const fail = (error) => ({ ok: false, sent: false, error });
  const incomplete = () => ({ ok: false, sent: false, complete: false, error: "moodle_quiz_regrade_report_incomplete" });
  const input = (() => { try { return typeof rawInput === "string" ? JSON.parse(rawInput) : rawInput; } catch { return null; } })();
  const cfg = globalThis.M?.cfg;
  if (!object(input) || !object(cfg) || typeof cfg.wwwroot !== "string" || typeof cfg.sesskey !== "string" || !cfg.sesskey) {
    return fail("moodle_quiz_regrade_report_context_invalid");
  }
  let site;
  try { site = new URL(cfg.wwwroot); } catch { return fail("moodle_quiz_regrade_report_context_invalid"); }
  const basePath = site.pathname.replace(/\/$/, "");
  const bodyCourse = String(globalThis.document?.body?.className || "").match(/(?:^|\s)course-([1-9][0-9]*)(?:\s|$)/)?.[1] || "";
  const courseId = id(cfg.courseId) || bodyCourse;
  const principalId = id(cfg.userId);
  const currentPath = String(globalThis.location?.pathname || "");
  if (site.protocol !== "https:" || site.search || site.hash || site.username || site.password
    || site.origin !== globalThis.location?.origin || !(currentPath === basePath || currentPath.startsWith(`${basePath}/`))
    || !courseId || !principalId) return fail("moodle_quiz_regrade_report_context_invalid");
  const operation = input.operation;
  const args = input.arguments;
  const binding = input.binding;
  if (!object(operation) || operation.key !== OPERATION || operation.toolName !== TOOL || operation.provider !== PROVIDER || operation.readOnly !== true
    || !object(args) || Object.keys(args).length !== 2 || id(args.course_id) !== courseId || !id(args.module_id)
    || !object(binding) || binding.origin !== site.origin || binding.siteUrl !== site.href
    || id(binding.principalId) !== principalId || id(binding.courseId) !== courseId
    || !Number.isSafeInteger(input.expiresAt) || input.expiresAt <= Date.now()) return fail("moodle_quiz_regrade_report_arguments_invalid");
  const moduleId = id(args.module_id);
  const sameContext = () => globalThis.M?.cfg?.sesskey === cfg.sesskey && id(globalThis.M?.cfg?.userId) === principalId
    && (id(globalThis.M?.cfg?.courseId) || bodyCourse) === courseId;
  const url = (path, query) => {
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
  const reportPage = async (page) => {
    if (Date.now() >= input.expiresAt || !sameContext()) return "context";
    const endpoint = url("/mod/quiz/report.php", {
      id: moduleId, mode: "overview", attempts: "all_with", onlygraded: "0", onlyregraded: "1",
      slotmarks: "0", states: STATES.join("-"), pagesize: String(PAGE_SIZE), page: String(page),
    });
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
    const body = documentValue.body;
    const bodyClass = String(body?.className || "");
    if (!body || body.getAttribute("id") !== "page-mod-quiz-report"
      || !new RegExp(`(?:^|\\s)course-${courseId}(?:\\s|$)`).test(bodyClass)) return null;
    return { endpoint, documentValue };
  };
  const commitLink = (documentValue, endpoint) => [...documentValue.querySelectorAll("a[href]")].some((link) => {
    const href = link.getAttribute("href");
    if (typeof href !== "string" || !href) return false;
    try {
      const target = new URL(href, endpoint);
      return target.origin === site.origin && target.pathname === `${basePath}/mod/quiz/report.php`
        && target.searchParams.get("regradealldrydo") === "1" && target.searchParams.get("id") === moduleId;
    } catch { return false; }
  });
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

  const attempts = new Set();
  let commitPending = false;
  let pageCount = 0;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const loaded = await reportPage(page);
    if (loaded === "limit") return incomplete();
    if (loaded === "context") return fail("moodle_quiz_regrade_report_context_changed");
    if (!loaded) return fail("moodle_quiz_regrade_report_target_unavailable");
    pageCount += 1;
    if (page === 0) {
      // Moodle renders the "only regraded attempts" filter only for a person who
      // holds mod/quiz:regrade, and it renders the attempt checkbox column for
      // the same person. Without that filter the page cannot answer this
      // question, so the read refuses instead of reporting zero.
      if (!loaded.documentValue.querySelector('select[name="attempts"]')) return fail("moodle_quiz_regrade_report_target_unavailable");
      if (!loaded.documentValue.querySelector('input[type="checkbox"][name="onlyregraded"]')) {
        return fail("moodle_quiz_regrade_report_capability_unavailable");
      }
      commitPending = commitLink(loaded.documentValue, loaded.endpoint);
    }
    let pageRows = 0;
    for (const control of loaded.documentValue.querySelectorAll('table#attempts tbody input[name="attemptid[]"]')) {
      const value = id(control.getAttribute("value") || "");
      if (!value) return fail("moodle_quiz_regrade_report_response_invalid");
      attempts.add(value);
      pageRows += 1;
    }
    if (pageRows < PAGE_SIZE) break;
    if (page + 1 === MAX_PAGES) return incomplete();
  }
  if (!sameContext() || Date.now() > input.expiresAt) return fail("moodle_quiz_regrade_report_context_changed");
  const data = {
    schema: SCHEMA,
    provider: PROVIDER,
    course_id: Number(courseId),
    module_id: Number(moduleId),
    regraded_attempt_count: attempts.size,
    commit_pending: commitPending,
    proof: {
      method: METHOD_PROOF,
      route: ROUTE_PROOF,
      complete: true,
      exact_module_binding: "quiz_report_page",
      required_capability: "mod/quiz:viewreports",
      regrade_capability_marker: "onlyregraded_filter",
      avoided_routes: AVOIDED_ROUTES,
      records_learner_state: false,
      records_report_viewed_event: true,
      sesskey_sent: false,
      regrade_parameter_sent: false,
      page_size: PAGE_SIZE,
      page_count: pageCount,
      attempt_limit: PAGE_SIZE * MAX_PAGES,
    },
  };
  const snapshotDigest = await digest(data);
  if (!snapshotDigest) return fail("moodle_quiz_regrade_report_digest_unavailable");
  return { ok: true, sent: false, complete: true, data, snapshot_digest: snapshotDigest };
}
