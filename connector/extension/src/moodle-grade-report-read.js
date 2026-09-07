/**
 * Reads the Moodle grader report of one exact course, learner-safe.
 *
 * Both readers use one native route: a plain GET of
 * /grade/report/grader/index.php with the course id and a page number and
 * nothing else. That page calls require_capability('gradereport/grader:view')
 * and require_capability('moodle/grade:viewall') at the exact course context
 * before it renders anything, so the signed-in teacher's own authority is what
 * admits the read. Passing only `id` and `page` also means the request reaches
 * none of the page's writing branches: `perpage` and `toggle` are the branches
 * that call set_user_preference, `sifirst` and `silast` are the branches that
 * write $SESSION->gradereport, and `target` with `action` is the branch that
 * calls grade_report_grader::do_process_action.
 *
 * What the route does record: Moodle triggers its own
 * gradereport_grader\event\grade_report_viewed log event at the end of the
 * page, exactly as it does when a teacher opens the gradebook, and it runs
 * grade_regrade_final_grades_if_required() when Moodle has already flagged the
 * course as needing a regrade. Neither changes a grade, a completion state, an
 * attempt, or any other learner state.
 *
 * Grade values stay in the page world. The summary returns per-item counts and
 * bucketed statistics with no learner identity of any kind. The learner report
 * returns one requested learner's per-item state and whole-percent value, and
 * carries the Moodle user ID only inside `learner`, which the MCP runtime
 * projects to a stable token through the complete course roster.
 *
 * Percentage limit, read from Moodle v5.2.2 source: the grader report renders
 * each grade with grade_format_gradevalue() in the course display type
 * (public/grade/report/grader/lib.php), and it renders the Ranges row only when
 * the grade_report_showranges preference is on, which
 * public/grade/report/grader/settings.php ships as off. A percentage is
 * therefore available when the display type includes a percentage, or when the
 * Ranges row is shown and its bounds read as plain numbers. Where neither
 * holds, both readers still return the counts and the per-item state and name
 * the exact reason the statistics or the percentage are unavailable. They never
 * infer a value.
 *
 * Source: https://github.com/moodle/moodle/blob/v5.2.2/public/grade/report/grader/index.php
 * Table markup: https://github.com/moodle/moodle/blob/v5.2.2/public/grade/report/grader/lib.php
 * Required capabilities: gradereport/grader:view and moodle/grade:viewall at the exact course context.
 */

/**
 * Aggregates the grader report of one exact course. Every source row stays in
 * the page world; the result holds per-grade-item counts and bucketed
 * statistics only, with no learner row, name, ID, or grade value.
 */
export async function executeMoodleGradeReportSummaryInPage(rawInput) {
  const PROVIDER = "moodle";
  const OPERATION = "moodle.form.grade.report.summary.read.v1";
  const TOOL = "moodle_get_grade_report_summary";
  const SCHEMA = "morrow.moodle-grade-report-summary.v1";
  const METHOD_PROOF = "grade_report_grader_index";
  const CAPABILITIES = Object.freeze(["gradereport/grader:view", "moodle/grade:viewall"]);
  const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
  const MAX_PARTICIPANTS = 10_000;
  const MAX_GRADE_ITEMS = 500;
  const MAX_PAGES = 500;
  const KINDS = Object.freeze({ item: "item", categoryitem: "category_total", courseitem: "course_total" });
  const ID = /^[1-9][0-9]{0,18}$/;
  const object = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
  const id = (value) => Number.isSafeInteger(value) && value > 0 ? String(value)
    : typeof value === "string" && ID.test(value) ? value : "";
  const fail = (error) => ({ ok: false, sent: false, error });
  const incomplete = () => ({ ok: false, sent: false, complete: false, error: "moodle_grade_report_summary_incomplete" });
  const input = (() => { try { return typeof rawInput === "string" ? JSON.parse(rawInput) : rawInput; } catch { return null; } })();
  const cfg = globalThis.M?.cfg;
  if (!object(input) || !object(cfg) || typeof cfg.wwwroot !== "string" || typeof cfg.sesskey !== "string" || !cfg.sesskey) {
    return fail("moodle_grade_report_summary_context_invalid");
  }
  let site;
  try { site = new URL(cfg.wwwroot); } catch { return fail("moodle_grade_report_summary_context_invalid"); }
  const basePath = site.pathname.replace(/\/$/, "");
  const bodyCourse = String(globalThis.document?.body?.className || "").match(/(?:^|\s)course-([1-9][0-9]*)(?:\s|$)/)?.[1] || "";
  const courseId = id(cfg.courseId) || bodyCourse;
  const principalId = id(cfg.userId);
  const currentPath = String(globalThis.location?.pathname || "");
  if (site.protocol !== "https:" || site.search || site.hash || site.username || site.password
    || site.origin !== globalThis.location?.origin || !(currentPath === basePath || currentPath.startsWith(`${basePath}/`))
    || !courseId || !principalId) return fail("moodle_grade_report_summary_context_invalid");
  const operation = input.operation;
  const args = input.arguments;
  const binding = input.binding;
  if (!object(operation) || operation.key !== OPERATION || operation.toolName !== TOOL || operation.provider !== PROVIDER || operation.readOnly !== true
    || !object(args) || Object.keys(args).length !== 1 || id(args.course_id) !== courseId
    || !object(binding) || binding.origin !== site.origin || binding.siteUrl !== site.href
    || id(binding.principalId) !== principalId || id(binding.courseId) !== courseId
    || !Number.isSafeInteger(input.expiresAt) || input.expiresAt <= Date.now()) return fail("moodle_grade_report_summary_arguments_invalid");
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
  const decimal = (value) => {
    const text = String(value).trim();
    // Moodle's format_float() writes no thousands separator and uses the
    // language's decimal separator, which is a comma in several languages.
    if (!/^-?(?:[0-9]+|[0-9]+[.,][0-9]+)$/.test(text)) return null;
    const parsed = Number(text.replace(",", "."));
    return Number.isFinite(parsed) ? parsed : null;
  };
  const percentFromText = (text) => {
    const matches = [...String(text).matchAll(/(-?[0-9]+(?:[.,][0-9]+)?)\s*%/g)];
    return matches.length === 1 ? decimal(matches[0][1]) : null;
  };
  const rangeFromText = (text) => {
    // grade_item::get_formatted_range() joins the two bounds with &ndash;.
    const parts = String(text).split("–");
    if (parts.length !== 2) return null;
    const minimum = decimal(parts[0]);
    const maximum = decimal(parts[1]);
    return minimum !== null && maximum !== null && maximum > minimum ? { minimum, maximum } : null;
  };
  const bucket = (percent) => {
    const bounded = Math.round(Math.min(100, Math.max(0, percent)));
    return bounded < 20 ? "0-19" : bounded < 40 ? "20-39" : bounded < 60 ? "40-59" : bounded < 80 ? "60-79" : "80-100";
  };
  const page = async (pageIndex) => {
    if (Date.now() >= input.expiresAt || !sameContext()) return { error: "moodle_grade_report_summary_context_changed" };
    const endpoint = url("/grade/report/grader/index.php", { id: courseId, page: String(pageIndex) });
    let response;
    try {
      response = await fetch(endpoint, {
        method: "GET", credentials: "include", cache: "no-store", redirect: "error", headers: { Accept: "text/html" },
      });
    } catch { return { error: "moodle_grade_report_summary_request_failed" }; }
    const html = await boundedText(response, endpoint);
    if (html === "limit") return { incomplete: true };
    if (typeof html !== "string" || typeof globalThis.DOMParser !== "function") return { error: "moodle_grade_report_summary_response_unavailable" };
    let documentValue;
    try { documentValue = new DOMParser().parseFromString(html, "text/html"); } catch { return { error: "moodle_grade_report_summary_response_invalid" }; }
    const tables = [...documentValue.querySelectorAll("table#user-grades")];
    if (tables.length !== 1) return { error: "moodle_grade_report_summary_response_invalid" };
    const table = tables[0];
    const columns = [];
    const seenColumns = new Set();
    for (const header of table.querySelectorAll("th[data-itemid]")) {
      const itemId = id(header.getAttribute("data-itemid"));
      const kind = KINDS[String(header.getAttribute("class") || "").trim().split(/\s+/)[0]];
      if (!itemId || !kind || seenColumns.has(itemId)) return { error: "moodle_grade_report_summary_response_invalid" };
      seenColumns.add(itemId);
      columns.push({ itemId, kind });
    }
    if (columns.length > MAX_GRADE_ITEMS) return { incomplete: true };
    const ranges = new Map();
    for (const cell of table.querySelectorAll("tr.range td[data-itemid]")) {
      const itemId = id(cell.getAttribute("data-itemid"));
      const text = cell.querySelector(".rangevalues")?.textContent;
      if (!itemId || !seenColumns.has(itemId) || typeof text !== "string") continue;
      const range = rangeFromText(text);
      if (range) ranges.set(itemId, range);
    }
    const rows = [];
    for (const row of table.querySelectorAll("tr[data-uid]")) {
      const userId = id(row.getAttribute("data-uid"));
      const cells = [...row.querySelectorAll("td.gradecell[data-itemid]")];
      if (!userId || cells.length !== columns.length) return { error: "moodle_grade_report_summary_response_invalid" };
      const values = [];
      for (let index = 0; index < cells.length; index += 1) {
        const cell = cells[index];
        const column = columns[index];
        if (cell.getAttribute("data-itemid") !== column.itemId || cell.getAttribute("id") !== `u${userId}i${column.itemId}`) {
          return { error: "moodle_grade_report_summary_response_invalid" };
        }
        const value = cell.querySelector("span.gradevalue");
        const text = typeof value?.textContent === "string" ? value.textContent.trim() : null;
        if (text === null) {
          // A cell Moodle rendered without a grade value: a grading error, or a
          // grade hidden from this teacher and shown as its submission date.
          values.push(String(cell.textContent || "").trim() === "-" ? { state: "ungraded" } : { state: "unreadable" });
          continue;
        }
        if (text === "-") { values.push({ state: "ungraded" }); continue; }
        const direct = percentFromText(text);
        if (direct !== null) { values.push({ state: "graded", percent: direct, source: "percentage_display" }); continue; }
        const plain = decimal(text);
        const range = ranges.get(column.itemId);
        values.push(plain !== null && range
          ? { state: "graded", percent: ((plain - range.minimum) / (range.maximum - range.minimum)) * 100, source: "range_row" }
          : { state: "graded" });
      }
      rows.push({ userId, values });
    }
    return { columns, rows };
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
  let columns = null;
  let pageSize = 0;
  let pageCount = 0;
  // The loop must reach the report's own last page. Running out of page
  // requests first would leave a partial count that reads as a whole course.
  let reachedLastPage = false;
  const seenUsers = new Set();
  const totals = new Map();
  for (let pageIndex = 0; pageIndex < MAX_PAGES; pageIndex += 1) {
    const result = await page(pageIndex);
    if (result.incomplete) return incomplete();
    if (result.error || !result.columns) return fail(result.error || "moodle_grade_report_summary_response_invalid");
    pageCount += 1;
    if (columns === null) {
      columns = result.columns;
      for (const column of columns) {
        totals.set(column.itemId, { kind: column.kind, graded: 0, ungraded: 0, unreadable: 0, percents: [], sources: new Set(), unsourced: 0 });
      }
    } else if (stable(columns) !== stable(result.columns)) {
      return fail("moodle_grade_report_summary_response_changed");
    }
    for (const row of result.rows) {
      if (seenUsers.has(row.userId)) return fail("moodle_grade_report_summary_response_invalid");
      seenUsers.add(row.userId);
      if (seenUsers.size > MAX_PARTICIPANTS) return incomplete();
      for (let index = 0; index < row.values.length; index += 1) {
        const total = totals.get(columns[index].itemId);
        const value = row.values[index];
        if (value.state === "ungraded") { total.ungraded += 1; continue; }
        if (value.state === "unreadable") { total.unreadable += 1; continue; }
        total.graded += 1;
        if (typeof value.percent === "number") {
          total.percents.push(value.percent);
          total.sources.add(value.source);
        } else {
          total.unsourced += 1;
        }
      }
    }
    if (pageIndex === 0) {
      pageSize = result.rows.length;
      if (pageSize === 0) { reachedLastPage = true; break; }
    } else if (result.rows.length < pageSize) { reachedLastPage = true; break; }
  }
  if (columns === null) return fail("moodle_grade_report_summary_response_invalid");
  if (!reachedLastPage) return incomplete();
  if (!sameContext() || Date.now() > input.expiresAt) return fail("moodle_grade_report_summary_context_changed");
  const items = columns.map((column) => {
    const total = totals.get(column.itemId);
    const sourced = total.percents.length;
    const source = total.sources.size === 1 ? [...total.sources][0] : null;
    const reason = total.unreadable > 0 ? "unreadable_cells"
      : total.graded === 0 ? "no_graded_values"
        : total.unsourced > 0 || !source ? "grade_values_not_numeric" : null;
    const sorted = reason ? [] : [...total.percents].sort((left, right) => left - right);
    const middle = sorted.length >> 1;
    return {
      item_id: Number(column.itemId),
      kind: column.kind,
      graded_count: total.graded,
      ungraded_count: total.ungraded,
      unreadable_count: total.unreadable,
      percent_source: reason ? null : source,
      statistics: reason ? null : {
        mean: bucket(sorted.reduce((sum, percent) => sum + percent, 0) / sourced),
        median: bucket(sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2),
        minimum: bucket(sorted[0]),
        maximum: bucket(sorted[sorted.length - 1]),
      },
      statistics_unavailable: reason,
    };
  });
  const data = {
    schema: SCHEMA,
    provider: PROVIDER,
    course_id: Number(courseId),
    participant_count: seenUsers.size,
    grade_item_count: items.length,
    items,
    proof: {
      method: METHOD_PROOF,
      complete: true,
      required_capabilities: [...CAPABILITIES],
      participant_limit: MAX_PARTICIPANTS,
      participant_response_rows: seenUsers.size,
      grade_item_limit: MAX_GRADE_ITEMS,
      page_size: pageSize,
      page_request_limit: MAX_PAGES,
      page_request_count: pageCount,
    },
  };
  const snapshotDigest = await digest(data);
  if (!snapshotDigest) return fail("moodle_grade_report_summary_digest_unavailable");
  return { ok: true, sent: false, complete: true, data, snapshot_digest: snapshotDigest };
}

/**
 * Reads the grader-report row of one exact learner in one exact course. The
 * page world sees every learner the report lists because the grader report is a
 * whole-course table; the result carries one requested identity, inside
 * `learner`, which the MCP runtime projects to a stable token through the
 * complete course roster and refuses when the identity is not on that roster.
 * No name, no free text and no feedback leaves the page.
 */
export async function executeMoodleLearnerGradeReportInPage(rawInput) {
  const PROVIDER = "moodle";
  const OPERATION = "moodle.form.grade.report.learner.read.v1";
  const TOOL = "moodle_get_learner_grade_report";
  const SCHEMA = "morrow.moodle-learner-grade-report.v1";
  const METHOD_PROOF = "grade_report_grader_index";
  const CAPABILITIES = Object.freeze(["gradereport/grader:view", "moodle/grade:viewall"]);
  const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
  const MAX_PARTICIPANTS = 10_000;
  const MAX_GRADE_ITEMS = 500;
  const MAX_PAGES = 500;
  const KINDS = Object.freeze({ item: "item", categoryitem: "category_total", courseitem: "course_total" });
  const ID = /^[1-9][0-9]{0,18}$/;
  const object = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
  const id = (value) => Number.isSafeInteger(value) && value > 0 ? String(value)
    : typeof value === "string" && ID.test(value) ? value : "";
  const fail = (error) => ({ ok: false, sent: false, error });
  const incomplete = () => ({ ok: false, sent: false, complete: false, error: "moodle_learner_grade_report_incomplete" });
  const input = (() => { try { return typeof rawInput === "string" ? JSON.parse(rawInput) : rawInput; } catch { return null; } })();
  const cfg = globalThis.M?.cfg;
  if (!object(input) || !object(cfg) || typeof cfg.wwwroot !== "string" || typeof cfg.sesskey !== "string" || !cfg.sesskey) {
    return fail("moodle_learner_grade_report_context_invalid");
  }
  let site;
  try { site = new URL(cfg.wwwroot); } catch { return fail("moodle_learner_grade_report_context_invalid"); }
  const basePath = site.pathname.replace(/\/$/, "");
  const bodyCourse = String(globalThis.document?.body?.className || "").match(/(?:^|\s)course-([1-9][0-9]*)(?:\s|$)/)?.[1] || "";
  const courseId = id(cfg.courseId) || bodyCourse;
  const principalId = id(cfg.userId);
  const currentPath = String(globalThis.location?.pathname || "");
  if (site.protocol !== "https:" || site.search || site.hash || site.username || site.password
    || site.origin !== globalThis.location?.origin || !(currentPath === basePath || currentPath.startsWith(`${basePath}/`))
    || !courseId || !principalId) return fail("moodle_learner_grade_report_context_invalid");
  const operation = input.operation;
  const args = input.arguments;
  const binding = input.binding;
  if (!object(operation) || operation.key !== OPERATION || operation.toolName !== TOOL || operation.provider !== PROVIDER || operation.readOnly !== true
    || !object(args) || Object.keys(args).length !== 2 || id(args.course_id) !== courseId || !id(args.user_id)
    || !object(binding) || binding.origin !== site.origin || binding.siteUrl !== site.href
    || id(binding.principalId) !== principalId || id(binding.courseId) !== courseId
    || !Number.isSafeInteger(input.expiresAt) || input.expiresAt <= Date.now()) return fail("moodle_learner_grade_report_arguments_invalid");
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
  const decimal = (value) => {
    const text = String(value).trim();
    if (!/^-?(?:[0-9]+|[0-9]+[.,][0-9]+)$/.test(text)) return null;
    const parsed = Number(text.replace(",", "."));
    return Number.isFinite(parsed) ? parsed : null;
  };
  const percentFromText = (text) => {
    const matches = [...String(text).matchAll(/(-?[0-9]+(?:[.,][0-9]+)?)\s*%/g)];
    return matches.length === 1 ? decimal(matches[0][1]) : null;
  };
  const rangeFromText = (text) => {
    const parts = String(text).split("–");
    if (parts.length !== 2) return null;
    const minimum = decimal(parts[0]);
    const maximum = decimal(parts[1]);
    return minimum !== null && maximum !== null && maximum > minimum ? { minimum, maximum } : null;
  };
  const page = async (pageIndex) => {
    if (Date.now() >= input.expiresAt || !sameContext()) return { error: "moodle_learner_grade_report_context_changed" };
    const endpoint = url("/grade/report/grader/index.php", { id: courseId, page: String(pageIndex) });
    let response;
    try {
      response = await fetch(endpoint, {
        method: "GET", credentials: "include", cache: "no-store", redirect: "error", headers: { Accept: "text/html" },
      });
    } catch { return { error: "moodle_learner_grade_report_request_failed" }; }
    const html = await boundedText(response, endpoint);
    if (html === "limit") return { incomplete: true };
    if (typeof html !== "string" || typeof globalThis.DOMParser !== "function") return { error: "moodle_learner_grade_report_response_unavailable" };
    let documentValue;
    try { documentValue = new DOMParser().parseFromString(html, "text/html"); } catch { return { error: "moodle_learner_grade_report_response_invalid" }; }
    const tables = [...documentValue.querySelectorAll("table#user-grades")];
    if (tables.length !== 1) return { error: "moodle_learner_grade_report_response_invalid" };
    const table = tables[0];
    const columns = [];
    const seenColumns = new Set();
    for (const header of table.querySelectorAll("th[data-itemid]")) {
      const itemId = id(header.getAttribute("data-itemid"));
      const kind = KINDS[String(header.getAttribute("class") || "").trim().split(/\s+/)[0]];
      if (!itemId || !kind || seenColumns.has(itemId)) return { error: "moodle_learner_grade_report_response_invalid" };
      seenColumns.add(itemId);
      columns.push({ itemId, kind });
    }
    if (columns.length > MAX_GRADE_ITEMS) return { incomplete: true };
    const ranges = new Map();
    for (const cell of table.querySelectorAll("tr.range td[data-itemid]")) {
      const itemId = id(cell.getAttribute("data-itemid"));
      const text = cell.querySelector(".rangevalues")?.textContent;
      if (!itemId || !seenColumns.has(itemId) || typeof text !== "string") continue;
      const range = rangeFromText(text);
      if (range) ranges.set(itemId, range);
    }
    const rows = [...table.querySelectorAll("tr[data-uid]")];
    const userIds = rows.map((row) => id(row.getAttribute("data-uid")));
    if (userIds.some((userId) => !userId)) return { error: "moodle_learner_grade_report_response_invalid" };
    const index = userIds.indexOf(learnerId);
    if (index < 0) return { columns, userIds, items: null };
    const cells = [...rows[index].querySelectorAll("td.gradecell[data-itemid]")];
    if (cells.length !== columns.length) return { error: "moodle_learner_grade_report_response_invalid" };
    const items = [];
    for (let position = 0; position < cells.length; position += 1) {
      const cell = cells[position];
      const column = columns[position];
      if (cell.getAttribute("data-itemid") !== column.itemId || cell.getAttribute("id") !== `u${learnerId}i${column.itemId}`) {
        return { error: "moodle_learner_grade_report_response_invalid" };
      }
      const value = cell.querySelector("span.gradevalue");
      const text = typeof value?.textContent === "string" ? value.textContent.trim() : null;
      const entry = { item_id: Number(column.itemId), kind: column.kind, state: "graded", percent: null, percent_source: null };
      if (text === null) {
        entry.state = String(cell.textContent || "").trim() === "-" ? "ungraded" : "unreadable";
      } else if (text === "-") {
        entry.state = "ungraded";
      } else {
        const direct = percentFromText(text);
        const plain = direct === null ? decimal(text) : null;
        const range = ranges.get(column.itemId);
        if (direct !== null) {
          entry.percent = Math.round(Math.min(100, Math.max(0, direct)));
          entry.percent_source = "percentage_display";
        } else if (plain !== null && range) {
          entry.percent = Math.round(Math.min(100, Math.max(0, ((plain - range.minimum) / (range.maximum - range.minimum)) * 100)));
          entry.percent_source = "range_row";
        }
      }
      items.push(entry);
    }
    return { columns, userIds, items };
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
  let columns = null;
  let pageSize = 0;
  let pageCount = 0;
  let scanned = 0;
  let items = null;
  // The scan must reach the report's own last page before it can say the
  // requested learner is not listed. Running out of page requests first proves
  // nothing about that learner, so it is an incomplete read, not an answer.
  let reachedLastPage = false;
  for (let pageIndex = 0; pageIndex < MAX_PAGES && items === null; pageIndex += 1) {
    const result = await page(pageIndex);
    if (result.incomplete) return incomplete();
    if (result.error || !result.columns) return fail(result.error || "moodle_learner_grade_report_response_invalid");
    pageCount += 1;
    if (columns === null) columns = result.columns;
    else if (stable(columns) !== stable(result.columns)) return fail("moodle_learner_grade_report_response_changed");
    scanned += result.userIds.length;
    if (scanned > MAX_PARTICIPANTS) return incomplete();
    if (result.items) { items = result.items; reachedLastPage = true; break; }
    if (pageIndex === 0) {
      pageSize = result.userIds.length;
      if (pageSize === 0) { reachedLastPage = true; break; }
    } else if (result.userIds.length < pageSize) { reachedLastPage = true; break; }
  }
  if (!reachedLastPage) return incomplete();
  if (items === null) return fail("moodle_learner_grade_report_learner_unavailable");
  if (!sameContext() || Date.now() > input.expiresAt) return fail("moodle_learner_grade_report_context_changed");
  const data = {
    schema: SCHEMA,
    provider: PROVIDER,
    course_id: Number(courseId),
    learner: { user_id: learnerId },
    grade_item_count: items.length,
    items,
    proof: {
      method: METHOD_PROOF,
      complete: true,
      required_capabilities: [...CAPABILITIES],
      participant_limit: MAX_PARTICIPANTS,
      grade_item_limit: MAX_GRADE_ITEMS,
      page_request_limit: MAX_PAGES,
      page_request_count: pageCount,
    },
  };
  const snapshotDigest = await digest(data);
  if (!snapshotDigest) return fail("moodle_learner_grade_report_digest_unavailable");
  return { ok: true, sent: false, complete: true, data, snapshot_digest: snapshotDigest };
}
