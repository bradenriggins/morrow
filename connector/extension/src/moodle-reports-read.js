/**
 * Reads Moodle's own course reports for one exact course, bounded and
 * learner-safe.
 *
 * Five reads live here. Four are aggregate only and return no learner identity
 * of any kind. The fifth, the participation report, returns one row per listed
 * person only when the request asks for it, and then it carries the Moodle user
 * ID and nothing else, so the MCP runtime can project that identity to a stable
 * token through the complete course participant roster and refuse a person the
 * roster does not hold.
 *
 * Routes, read from Moodle v5.2.2 source:
 * - Activity report: GET /report/outline/index.php?id=<courseid>, which calls
 *   require_capability('report/outline:view'). Its table is
 *   `table#outlinereport`, whose activity rows carry `td.cell.activityname`
 *   with the activity link and `td.cell.numviews` with the view count.
 *   https://github.com/moodle/moodle/blob/v5.2.2/public/report/outline/index.php
 * - Participation report: GET /report/participation/index.php with the course
 *   id, one course-module id, one action and one time window, which calls
 *   require_capability('report/participation:view'). Its table id is
 *   `course-participation-<courseid>-<cmid>-<roleid>`, its first column holds
 *   the user link and its second column holds the action count.
 *   https://github.com/moodle/moodle/blob/v5.2.2/public/report/participation/index.php
 * - Activity completion report: GET /report/progress/index.php?course=<courseid>,
 *   which calls require_capability('report/progress:view'). Its table is
 *   `table#completion-progress`, its activity headers are `th.completion-header`
 *   with the activity link, and each `td.completion-progresscell` holds the
 *   toggle link Moodle renders for a person who may override completion.
 *   https://github.com/moodle/moodle/blob/v5.2.2/public/report/progress/index.php
 * - Log summary: GET /report/log/index.php?id=<courseid>&chooselog=1, which
 *   calls require_capability('report/log:view'). Its table is `table.reportlog`
 *   and its columns end in the fixed order context, component, event name,
 *   description, origin, IP address.
 *   https://github.com/moodle/moodle/blob/v5.2.2/public/report/log/classes/table_log.php
 * - Dates report: the same-site AJAX method core_calendar_get_calendar_monthly_view,
 *   which lib/db/services.php registers with 'ajax' => true and 'type' => 'read'.
 *   Moodle 5.2.2 ships no core dates report; the Dates report teachers may know
 *   is the third-party report_editdates plugin, so this read uses the course
 *   calendar month view instead and says so. It is a count of the dated entries
 *   per month and per activity and nothing more: it returns no date and no
 *   event name, because a civil date needs the signed-in person's time zone and
 *   moodle_list_course_events already reports each entry with the civil values
 *   Moodle itself rendered.
 *   https://github.com/moodle/moodle/blob/v5.2.2/public/calendar/externallib.php
 *
 * What these routes record: each report page triggers its own
 * \report_<name>\event\report_viewed log event for the signed-in person,
 * exactly as opening the report in Moodle does. None of them changes a grade,
 * a completion state, an attempt, an enrolment, or any other learner state, and
 * none of them opens an activity view, player, attempt or report page.
 *
 * The log report renders an IP address column, and a log store can add a user
 * agent column of its own. Neither is read here: the log summary reads the
 * context cell and the origin cell only, and every other cell of every log row
 * stays in the page world.
 *
 * Every read is bounded by response bytes, by row count and by request count,
 * and returns <prefix>_incomplete rather than a partial report when a bound is
 * exceeded or when it does not reach the report's own last page.
 */

/**
 * Runs one of the five Moodle course-report reads in the page world. The
 * operation key selects the report; every helper is inline because Chrome
 * serializes this function for MAIN-world injection.
 */
export async function executeMoodleCourseReportReadInPage(rawInput) {
  const PROVIDER = "moodle";
  const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
  const MAX_ACTIVITIES = 500;
  const MAX_PARTICIPANTS = 5_000;
  const MAX_PARTICIPATION_PAGES = 100;
  const MAX_COMPLETION_PAGES = 200;
  const MAX_LOG_ENTRIES = 5_000;
  const MAX_LOG_PAGES = 50;
  const LOG_PAGE_SIZE = 100;
  const PARTICIPATION_PAGE_SIZE = 100;
  const MAX_MONTHS = 12;
  const MAX_EVENTS = 2_000;
  const MAX_SINCE_DAYS = 365;
  const CALENDAR_METHOD = "core_calendar_get_calendar_monthly_view";
  const LOG_ORIGINS = Object.freeze(["web", "ws", "cli", "restore"]);
  // Every log column this summary never reads. The IP address is the last
  // column of Moodle's log table and a log store may add a user agent column of
  // its own; neither is parsed, so neither can reach a result.
  const LOG_OMITTED_COLUMNS = Object.freeze([
    "time", "user", "related_user", "component", "event_name", "description", "ip_address", "user_agent",
  ]);
  const DEFINITIONS = new Map([
    ["moodle.form.report.activity.read.v1", {
      tool: "moodle_get_course_activity_report",
      schema: "morrow.moodle-course-activity-report.v1",
      prefix: "moodle_course_activity_report",
      method: "report_outline_index",
      capability: "report/outline:view",
    }],
    ["moodle.form.report.participation.read.v1", {
      tool: "moodle_get_course_participation_report",
      schema: "morrow.moodle-course-participation-report.v1",
      prefix: "moodle_course_participation_report",
      method: "report_participation_index",
      capability: "report/participation:view",
    }],
    ["moodle.form.report.completion.read.v1", {
      tool: "moodle_get_course_completion_report",
      schema: "morrow.moodle-course-completion-report.v1",
      prefix: "moodle_course_completion_report",
      method: "report_progress_index",
      capability: "report/progress:view",
    }],
    ["moodle.form.report.log_summary.read.v1", {
      tool: "moodle_get_course_log_summary",
      schema: "morrow.moodle-course-log-summary.v1",
      prefix: "moodle_course_log_summary",
      method: "report_log_index",
      capability: "report/log:view",
    }],
    ["moodle.form.report.dates.read.v1", {
      tool: "moodle_get_course_dates_report",
      schema: "morrow.moodle-course-dates-report.v1",
      prefix: "moodle_course_dates_report",
      method: CALENDAR_METHOD,
      capability: null,
    }],
  ]);
  const ID = /^[1-9][0-9]{0,18}$/;
  const COUNT = /^(?:0|[1-9][0-9]{0,9})$/;
  const MODNAME = /^[a-z][a-z0-9_]{0,30}$/;
  const EVENT_TYPE = /^[a-z][a-z0-9_]{0,30}$/;
  const object = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
  const id = (value) => Number.isSafeInteger(value) && value > 0 ? String(value)
    : typeof value === "string" && ID.test(value) ? value : "";
  const input = (() => { try { return typeof rawInput === "string" ? JSON.parse(rawInput) : rawInput; } catch { return null; } })();
  const operation = object(input) ? input.operation : null;
  const definition = object(operation) && typeof operation.key === "string" ? DEFINITIONS.get(operation.key) : undefined;
  if (!definition) return { ok: false, sent: false, error: "moodle_course_report_operation_refused" };
  const fail = (error) => ({ ok: false, sent: false, error: `${definition.prefix}_${error}` });
  const incomplete = () => ({ ok: false, sent: false, complete: false, error: `${definition.prefix}_incomplete` });
  const cfg = globalThis.M?.cfg;
  if (!object(cfg) || typeof cfg.wwwroot !== "string" || typeof cfg.sesskey !== "string" || !cfg.sesskey) {
    return fail("context_invalid");
  }
  let site;
  try { site = new URL(cfg.wwwroot); } catch { return fail("context_invalid"); }
  const basePath = site.pathname.replace(/\/$/, "");
  const bodyCourse = String(globalThis.document?.body?.className || "").match(/(?:^|\s)course-([1-9][0-9]*)(?:\s|$)/)?.[1] || "";
  const courseId = id(cfg.courseId) || bodyCourse;
  const principalId = id(cfg.userId);
  const currentPath = String(globalThis.location?.pathname || "");
  if (site.protocol !== "https:" || site.search || site.hash || site.username || site.password
    || site.origin !== globalThis.location?.origin || !(currentPath === basePath || currentPath.startsWith(`${basePath}/`))
    || !courseId || !principalId) return fail("context_invalid");
  const args = input.arguments;
  const binding = input.binding;
  if (operation.toolName !== definition.tool || operation.provider !== PROVIDER || operation.readOnly !== true
    || !object(args) || id(args.course_id) !== courseId
    || !object(binding) || binding.origin !== site.origin || binding.siteUrl !== site.href
    || id(binding.principalId) !== principalId || id(binding.courseId) !== courseId
    || !Number.isSafeInteger(input.expiresAt) || input.expiresAt <= Date.now()) return fail("arguments_invalid");
  const integerArgument = (value, minimum, maximum) => Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : null;
  let moduleId = "";
  let action = "";
  let sinceDays = 0;
  let includeParticipants = false;
  let months = 0;
  let year = 0;
  let month = 0;
  if (definition.prefix === "moodle_course_participation_report") {
    const keys = Object.keys(args).length;
    moduleId = id(args.module_id);
    action = args.action === "view" || args.action === "post" ? args.action : "";
    sinceDays = integerArgument(args.since_days, 1, MAX_SINCE_DAYS) ?? 0;
    includeParticipants = args.include_participants === true;
    const allowed = args.include_participants === undefined ? 4 : 5;
    if (keys !== allowed || !moduleId || !action || !sinceDays
      || (args.include_participants !== undefined && typeof args.include_participants !== "boolean")) return fail("arguments_invalid");
  } else if (definition.prefix === "moodle_course_dates_report") {
    months = integerArgument(args.months, 1, MAX_MONTHS) ?? 0;
    year = integerArgument(args.year, 2000, 2100) ?? 0;
    month = integerArgument(args.month, 1, 12) ?? 0;
    if (Object.keys(args).length !== 4 || !months || !year || !month) return fail("arguments_invalid");
  } else if (Object.keys(args).length !== 1) return fail("arguments_invalid");
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
    if (declared !== null && (!COUNT.test(String(declared)) || Number(declared) > MAX_RESPONSE_BYTES)) return "limit";
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
  /** One bounded GET of a native report page, parsed into a document. */
  const reportDocument = async (path, query) => {
    if (Date.now() >= input.expiresAt || !sameContext()) return "context";
    const endpoint = url(path, query);
    let response;
    try {
      response = await fetch(endpoint, {
        method: "GET", credentials: "include", cache: "no-store", redirect: "error", headers: { Accept: "text/html" },
      });
    } catch { return "failed"; }
    const html = await boundedText(response, endpoint);
    if (html === "limit") return "limit";
    if (typeof html !== "string" || typeof globalThis.DOMParser !== "function") return "failed";
    try {
      const parsed = new DOMParser().parseFromString(html, "text/html");
      return parsed.querySelector("parsererror") ? "failed" : parsed;
    } catch { return "failed"; }
  };
  /** One bounded same-site AJAX read. Never sends a write method. */
  const ajaxRead = async (methodname, methodArguments) => {
    if (Date.now() >= input.expiresAt || !sameContext()) return "context";
    const endpoint = url("/lib/ajax/service.php", { sesskey: cfg.sesskey, info: methodname });
    let response;
    try {
      response = await fetch(endpoint, {
        method: "POST", credentials: "include", cache: "no-store", redirect: "error",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify([{ index: 0, methodname, args: methodArguments }]),
      });
    } catch { return "failed"; }
    const raw = await boundedText(response, endpoint);
    if (raw === "limit") return "limit";
    if (typeof raw !== "string") return "failed";
    let payload;
    try { payload = JSON.parse(raw); } catch { return "failed"; }
    // Moodle's lib/ajax/service.php answers a batch positionally, so the one
    // response for the one request sent here is the only element.
    if (!Array.isArray(payload) || payload.length !== 1 || !object(payload[0])) return "failed";
    if (payload[0].error || payload[0].exception || !("data" in payload[0])) return "unavailable";
    const data = typeof payload[0].data === "string"
      ? (() => { try { return JSON.parse(payload[0].data); } catch { return null; } })()
      : payload[0].data;
    return object(data) ? data : "failed";
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
  /** The site-relative path of a same-origin URL, or "" when it is elsewhere. */
  const sitePath = (href) => {
    if (typeof href !== "string") return null;
    let target;
    try { target = new URL(href, site.href); } catch { return null; }
    if (target.origin !== site.origin) return null;
    if (basePath && !(target.pathname === basePath || target.pathname.startsWith(`${basePath}/`))) return null;
    return { path: basePath ? target.pathname.slice(basePath.length) : target.pathname, query: target.searchParams };
  };
  /** The course module a /mod/<modname>/view.php link names, or null. */
  const moduleFromHref = (href) => {
    const target = sitePath(href);
    const match = target?.path.match(/^\/mod\/([a-z][a-z0-9_]{0,30})\/view\.php$/);
    if (!match || !MODNAME.test(match[1])) return null;
    const moduleIdValue = id(target.query.get("id") || "");
    return moduleIdValue ? { moduleId: moduleIdValue, modname: match[1] } : null;
  };
  const activityLink = (node) => moduleFromHref(node?.getAttribute?.("href"));
  /** The user a Moodle profile link in this course names, or "" when it names none. */
  const profileUserId = (node) => {
    const target = sitePath(node?.getAttribute?.("href"));
    if (!target || target.path !== "/user/view.php") return "";
    return id(target.query.get("course") || "") === courseId ? id(target.query.get("id") || "") : "";
  };

  const readActivityReport = async () => {
    const parsed = await reportDocument("/report/outline/index.php", { id: courseId });
    if (typeof parsed === "string") return parsed;
    const tables = [...parsed.querySelectorAll("table#outlinereport")];
    if (tables.length !== 1) return "invalid";
    const rows = [...tables[0].querySelectorAll("tr")];
    const activities = [];
    const seen = new Set();
    let unreadable = 0;
    let total = 0;
    for (const row of rows) {
      const name = row.querySelector("td.cell.activityname");
      if (!name) continue;
      const link = activityLink(name.querySelector("a[href]"));
      const views = row.querySelector("td.cell.numviews");
      if (!link || !views) return "invalid";
      if (seen.has(link.moduleId)) return "invalid";
      seen.add(link.moduleId);
      if (activities.length >= MAX_ACTIVITIES) return "limit";
      const text = String(views.textContent || "").trim();
      if (COUNT.test(text)) {
        total += Number(text);
        activities.push({ module_id: Number(link.moduleId), modname: link.modname, view_count: Number(text) });
        continue;
      }
      // Moodle writes "-" when it has no view record for the activity. Any
      // other cell is a value this read does not understand, and it is counted
      // as unreadable rather than treated as zero.
      if (text !== "-") unreadable += 1;
      activities.push({ module_id: Number(link.moduleId), modname: link.modname, view_count: null });
    }
    return {
      schema: definition.schema,
      provider: PROVIDER,
      course_id: Number(courseId),
      activity_count: activities.length,
      total_view_count: total,
      unreadable_count: unreadable,
      activities,
      proof: {
        method: definition.method,
        complete: true,
        required_capability: definition.capability,
        activity_limit: MAX_ACTIVITIES,
        response_byte_limit: MAX_RESPONSE_BYTES,
        request_count: 1,
      },
    };
  };

  const readParticipationReport = async () => {
    const timeFrom = Math.floor(Date.now() / 1000) - sinceDays * 86_400;
    const participants = [];
    const seen = new Set();
    let performed = 0;
    let totalActions = 0;
    let roleId = "";
    let pageSize = 0;
    let pageCount = 0;
    let reachedLastPage = false;
    for (let pageIndex = 0; pageIndex < MAX_PARTICIPATION_PAGES; pageIndex += 1) {
      const parsed = await reportDocument("/report/participation/index.php", {
        id: courseId,
        instanceid: moduleId,
        timefrom: String(timeFrom),
        action,
        page: String(pageIndex),
        perpage: String(PARTICIPATION_PAGE_SIZE),
      });
      if (typeof parsed === "string") return parsed;
      pageCount += 1;
      const tables = [...parsed.querySelectorAll(`table[id^="course-participation-${courseId}-${moduleId}-"]`)];
      if (tables.length !== 1) return "invalid";
      const suffix = String(tables[0].getAttribute("id") || "").slice(`course-participation-${courseId}-${moduleId}-`.length);
      if (!id(suffix)) return "invalid";
      if (roleId && roleId !== suffix) return "changed";
      roleId = suffix;
      const rows = [...tables[0].querySelectorAll("tbody tr")];
      for (const row of rows) {
        const cells = [...row.querySelectorAll("td")];
        const user = profileUserId(row.querySelector("td.c0 a[href]"));
        const countCell = row.querySelector("td.c1");
        if (cells.length < 2 || !user || !countCell) return "invalid";
        if (seen.has(user)) return "invalid";
        seen.add(user);
        if (seen.size > MAX_PARTICIPANTS) return "limit";
        // Moodle writes the localized yes-string followed by " (<count>) " when
        // the person did the action, and the localized no-string when they did
        // not. The parenthesised count is written by the report itself, not by
        // a language pack.
        const matches = [...String(countCell.textContent || "").matchAll(/\((\d{1,9})\)/g)];
        if (matches.length > 1) return "invalid";
        const count = matches.length === 1 ? Number(matches[0][1]) : 0;
        if (count > 0) performed += 1;
        totalActions += count;
        if (includeParticipants) participants.push({ user_id: user, action_count: count });
      }
      if (pageIndex === 0) {
        pageSize = rows.length;
        if (pageSize === 0) { reachedLastPage = true; break; }
      } else if (rows.length < pageSize) { reachedLastPage = true; break; }
    }
    if (!reachedLastPage) return "limit";
    return {
      schema: definition.schema,
      provider: PROVIDER,
      course_id: Number(courseId),
      module_id: Number(moduleId),
      role_id: Number(roleId),
      action,
      since_days: sinceDays,
      time_from: timeFrom,
      participant_count: seen.size,
      performed_count: performed,
      not_performed_count: seen.size - performed,
      total_action_count: totalActions,
      includes_participants: includeParticipants,
      participants,
      proof: {
        method: definition.method,
        complete: true,
        required_capability: definition.capability,
        participant_limit: MAX_PARTICIPANTS,
        page_size: pageSize,
        page_request_limit: MAX_PARTICIPATION_PAGES,
        page_request_count: pageCount,
      },
    };
  };

  const readCompletionReport = async () => {
    let columns = null;
    let pageSize = 0;
    let pageCount = 0;
    let reachedLastPage = false;
    const seen = new Set();
    const totals = new Map();
    for (let pageIndex = 0; pageIndex < MAX_COMPLETION_PAGES; pageIndex += 1) {
      const parsed = await reportDocument("/report/progress/index.php", { course: courseId, page: String(pageIndex) });
      if (typeof parsed === "string") return parsed;
      pageCount += 1;
      const tables = [...parsed.querySelectorAll("table#completion-progress")];
      if (tables.length !== 1) return "invalid";
      const table = tables[0];
      const headers = [];
      const headerIds = new Set();
      for (const header of table.querySelectorAll("thead th.completion-header")) {
        const link = activityLink(header.querySelector("a[href]"));
        if (!link || headerIds.has(link.moduleId)) return "invalid";
        headerIds.add(link.moduleId);
        headers.push(link);
      }
      if (headers.length === 0) return "invalid";
      if (headers.length > MAX_ACTIVITIES) return "limit";
      if (columns === null) {
        columns = headers;
        for (const column of columns) totals.set(column.moduleId, { complete: 0, incomplete: 0, unreadable: 0 });
      } else if (stable(columns) !== stable(headers)) return "changed";
      const rows = [...table.querySelectorAll("tbody tr")];
      for (const row of rows) {
        const user = profileUserId(row.querySelector("th[scope='row'] a[href]"));
        const cells = [...row.querySelectorAll("td.completion-progresscell")];
        if (!user || cells.length !== columns.length) return "invalid";
        if (seen.has(user)) return "invalid";
        seen.add(user);
        if (seen.size > MAX_PARTICIPANTS) return "limit";
        for (let index = 0; index < cells.length; index += 1) {
          const total = totals.get(columns[index].moduleId);
          const toggle = cells[index].querySelector("a.changecompl[data-changecompl]");
          const parts = String(toggle?.getAttribute("data-changecompl") || "").split("-");
          // Moodle renders the toggle as "<userid>-<cmid>-<newstate>", where
          // the new state is the one the toggle would set. It renders a plain
          // icon instead for a pass or fail state, and for a person who may not
          // override completion; that icon is themed and translated, so this
          // read counts the cell as unreadable rather than guessing a state.
          if (parts.length !== 3 || parts[0] !== user || parts[1] !== columns[index].moduleId
            || (parts[2] !== "0" && parts[2] !== "1")) { total.unreadable += 1; continue; }
          if (parts[2] === "1") total.incomplete += 1; else total.complete += 1;
        }
      }
      if (pageIndex === 0) {
        pageSize = rows.length;
        if (pageSize === 0) { reachedLastPage = true; break; }
      } else if (rows.length < pageSize) { reachedLastPage = true; break; }
    }
    if (columns === null) return "invalid";
    if (!reachedLastPage) return "limit";
    return {
      schema: definition.schema,
      provider: PROVIDER,
      course_id: Number(courseId),
      participant_count: seen.size,
      activity_count: columns.length,
      activities: columns.map((column) => ({
        module_id: Number(column.moduleId),
        modname: column.modname,
        complete_count: totals.get(column.moduleId).complete,
        incomplete_count: totals.get(column.moduleId).incomplete,
        unreadable_count: totals.get(column.moduleId).unreadable,
      })),
      proof: {
        method: definition.method,
        complete: true,
        required_capability: definition.capability,
        participant_limit: MAX_PARTICIPANTS,
        activity_limit: MAX_ACTIVITIES,
        page_size: pageSize,
        page_request_limit: MAX_COMPLETION_PAGES,
        page_request_count: pageCount,
      },
    };
  };

  const readLogSummary = async () => {
    const origins = { web: 0, ws: 0, cli: 0, restore: 0, other: 0 };
    const activities = new Map();
    let entries = 0;
    let courseContext = 0;
    let otherContext = 0;
    let pageSize = 0;
    let pageCount = 0;
    let reachedLastPage = false;
    for (let pageIndex = 0; pageIndex < MAX_LOG_PAGES; pageIndex += 1) {
      const parsed = await reportDocument("/report/log/index.php", {
        id: courseId, chooselog: "1", page: String(pageIndex), perpage: String(LOG_PAGE_SIZE),
      });
      if (typeof parsed === "string") return parsed;
      pageCount += 1;
      const tables = [...parsed.querySelectorAll("table.reportlog")];
      if (tables.length !== 1) return "invalid";
      const rows = [...tables[0].querySelectorAll("tbody tr")];
      for (const row of rows) {
        const cells = [...row.querySelectorAll("td")];
        // Moodle's course log ends in the fixed order context, component,
        // event name, description, origin, IP address, with an optional course
        // column in front. Counting from the end binds the two cells this read
        // uses without reading the identity, description or IP cells at all.
        if (cells.length !== 9 && cells.length !== 10) return "invalid";
        entries += 1;
        if (entries > MAX_LOG_ENTRIES) return "limit";
        const originText = String(cells[cells.length - 2].textContent || "").trim();
        if (LOG_ORIGINS.includes(originText)) origins[originText] += 1; else origins.other += 1;
        const contextCell = cells[cells.length - 6];
        const link = activityLink(contextCell.querySelector("a[href]"));
        if (link) {
          const current = activities.get(link.moduleId);
          if (current) current.count += 1;
          else {
            if (activities.size >= MAX_ACTIVITIES) return "limit";
            activities.set(link.moduleId, { modname: link.modname, count: 1 });
          }
          continue;
        }
        const contextTarget = sitePath(contextCell.querySelector("a[href]")?.getAttribute("href"));
        if (contextTarget && contextTarget.path === "/course/view.php"
          && id(contextTarget.query.get("id") || "") === courseId) courseContext += 1;
        else otherContext += 1;
      }
      if (pageIndex === 0) {
        pageSize = rows.length;
        if (pageSize === 0) { reachedLastPage = true; break; }
      } else if (rows.length < pageSize) { reachedLastPage = true; break; }
    }
    if (!reachedLastPage) return "limit";
    return {
      schema: definition.schema,
      provider: PROVIDER,
      course_id: Number(courseId),
      entry_count: entries,
      course_context_count: courseContext,
      other_context_count: otherContext,
      origin_counts: origins,
      activity_counts: [...activities.entries()]
        .map(([moduleIdValue, entry]) => ({ module_id: Number(moduleIdValue), modname: entry.modname, count: entry.count }))
        .sort((left, right) => left.module_id - right.module_id),
      proof: {
        method: definition.method,
        complete: true,
        required_capability: definition.capability,
        entry_limit: MAX_LOG_ENTRIES,
        page_size: pageSize,
        page_request_limit: MAX_LOG_PAGES,
        page_request_count: pageCount,
        omitted_columns: [...LOG_OMITTED_COLUMNS],
      },
    };
  };

  const readDatesReport = async () => {
    const label = (yearValue, monthValue) => `${yearValue}-${String(monthValue).padStart(2, "0")}`;
    const monthCounts = [];
    const activities = new Map();
    const seen = new Set();
    let dated = 0;
    let courseEvents = 0;
    let unattributed = 0;
    let skipped = 0;
    for (let offset = 0; offset < months; offset += 1) {
      const requestedYear = year + Math.floor((month - 1 + offset) / 12);
      const requestedMonth = ((month - 1 + offset) % 12) + 1;
      const data = await ajaxRead(CALENDAR_METHOD, {
        year: requestedYear, month: requestedMonth, courseid: Number(courseId),
        categoryid: 0, includenavigation: false, mini: false, day: 1,
      });
      if (typeof data === "string") return data;
      if (!Array.isArray(data.weeks)) return "invalid";
      let monthTotal = 0;
      for (const week of data.weeks) {
        if (!object(week) || !Array.isArray(week.days)) return "invalid";
        for (const day of week.days) {
          if (!object(day) || !Array.isArray(day.events)) return "invalid";
          for (const event of day.events) {
            if (!object(event)) return "invalid";
            const eventId = id(event.id);
            const eventType = typeof event.eventtype === "string" && EVENT_TYPE.test(event.eventtype) ? event.eventtype : "";
            const modname = typeof event.modulename === "string" && MODNAME.test(event.modulename) ? event.modulename : null;
            if (!eventId || !eventType) return "invalid";
            // Moodle's month grid repeats a multi-day entry on every day it
            // covers, so each entry is counted once, in the first month of the
            // window that shows it.
            if (seen.has(eventId)) continue;
            seen.add(eventId);
            if (seen.size > MAX_EVENTS) return "limit";
            // A course or activity entry is course content. Every other entry
            // belongs to a person or a group, so it is counted and dropped.
            if (!modname && eventType !== "course") { skipped += 1; continue; }
            dated += 1;
            monthTotal += 1;
            if (!modname) { courseEvents += 1; continue; }
            const link = moduleFromHref(event.url);
            if (!link) { unattributed += 1; continue; }
            const current = activities.get(link.moduleId);
            if (current) current.count += 1;
            else {
              if (activities.size >= MAX_ACTIVITIES) return "limit";
              activities.set(link.moduleId, { modname: link.modname, count: 1 });
            }
          }
        }
      }
      monthCounts.push({ month: label(requestedYear, requestedMonth), count: monthTotal });
    }
    return {
      schema: definition.schema,
      provider: PROVIDER,
      course_id: Number(courseId),
      first_month: monthCounts[0].month,
      last_month: monthCounts[monthCounts.length - 1].month,
      months,
      dated_entry_count: dated,
      course_event_count: courseEvents,
      unattributed_activity_event_count: unattributed,
      skipped_event_count: skipped,
      month_counts: monthCounts,
      activity_counts: [...activities.entries()]
        .map(([moduleIdValue, entry]) => ({ module_id: Number(moduleIdValue), modname: entry.modname, count: entry.count }))
        .sort((left, right) => left.module_id - right.module_id),
      proof: {
        method: definition.method,
        complete: true,
        required_capability: null,
        access_rule: "course_calendar_visibility",
        event_limit: MAX_EVENTS,
        month_limit: MAX_MONTHS,
        request_count: months,
      },
    };
  };

  const readers = {
    moodle_course_activity_report: readActivityReport,
    moodle_course_participation_report: readParticipationReport,
    moodle_course_completion_report: readCompletionReport,
    moodle_course_log_summary: readLogSummary,
    moodle_course_dates_report: readDatesReport,
  };
  const data = await readers[definition.prefix]();
  if (data === "limit") return incomplete();
  if (data === "context") return fail("context_changed");
  if (data === "failed") return fail("request_failed");
  if (data === "unavailable") return fail("route_unavailable");
  if (data === "changed") return fail("response_changed");
  if (typeof data === "string" || !object(data)) return fail("response_invalid");
  if (!sameContext() || Date.now() > input.expiresAt) return fail("context_changed");
  const snapshotDigest = await digest(data);
  if (!snapshotDigest) return fail("digest_unavailable");
  return { ok: true, sent: false, complete: true, data, snapshot_digest: snapshotDigest };
}
