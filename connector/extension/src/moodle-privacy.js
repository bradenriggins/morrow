/**
 * Reads a source-proven complete participant roster for one bound Moodle course.
 * Browser-session material and raw Moodle HTML remain in this page-world function.
 */
export async function collectMoodleCourseParticipantRoster(input) {
  const SCHEMA = "morrow.moodle-course-roster.v1";
  const PAGE_SIZE = 100;
  const MAX_PAGES = 100;
  const MAX_IDENTITIES = PAGE_SIZE * MAX_PAGES;
  const MAX_RESPONSE_CHARS = 2 * 1024 * 1024;
  const MAX_NAME_CHARS = 500;
  const TABLE_METHOD = "core_table_get_dynamic_table_content";
  const COURSE_PAGE_PATH = "/user/index.php";
  const CAPABILITY_PAGE_PATH = "/admin/roles/check.php";
  const REQUIRED_CAPABILITIES = [
    "moodle/site:accessallgroups",
    "moodle/course:enrolreview",
    "moodle/course:viewsuspendedusers",
    "moodle/user:viewdetails",
  ];
  const idPattern = /^[1-9][0-9]{0,18}$/;
  const digestPattern = /^[a-f0-9]{64}$/;
  const sourceBindingPattern = /^[A-Za-z0-9_.:@-]{1,160}$/;
  const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
  const courseId = (value) => {
    if (Number.isSafeInteger(value) && value > 0) return String(value);
    const valueText = typeof value === "string" ? value : "";
    return idPattern.test(valueText) ? valueText : "";
  };
  const text = (value, maximum) => typeof value === "string" && value.length > 0 && value.length <= maximum
    && !/[\u0000-\u001f\u007f]/.test(value) ? value : "";
  const stableName = (value) => text(value, MAX_NAME_CHARS).trim().replace(/\s+/g, " ");
  const proof = (requests, pages, rows, identities, scope = null, totalRows = null) => ({
    method: TABLE_METHOD,
    pageSize: PAGE_SIZE,
    requestCount: requests,
    pageCount: pages,
    rowCount: rows,
    identityCount: identities,
    ...(Number.isSafeInteger(totalRows) ? { totalRows } : {}),
    ...(scope ? { scope } : {}),
  });
  const failed = (status, error, counts = [0, 0, 0, 0], base = {}, scope = null, totalRows = null) => ({
    schema: SCHEMA,
    provider: "moodle",
    ...base,
    status,
    complete: false,
    identities: [],
    proof: proof(...counts, scope, totalRows),
    error,
  });
  const parseInput = () => {
    if (typeof input === "string") {
      try { return JSON.parse(input); } catch { return null; }
    }
    return input;
  };
  const currentContext = () => {
    const cfg = globalThis.M?.cfg;
    if (!isObject(cfg) || typeof cfg.wwwroot !== "string" || !text(cfg.sesskey, 500)) return null;
    const principalId = courseId(cfg.userId);
    if (!principalId) return null;
    let site;
    try { site = new URL(cfg.wwwroot); } catch { return null; }
    if (site.protocol !== "https:" || site.search || site.hash || site.username || site.password) return null;
    const currentOrigin = String(globalThis.location?.origin || "");
    const currentPath = String(globalThis.location?.pathname || "");
    const basePath = site.pathname.replace(/\/$/, "");
    if (currentOrigin !== site.origin || !(currentPath === basePath || currentPath.startsWith(`${basePath}/`))) return null;
    const cfgCourseId = courseId(cfg.courseId);
    const bodyCourseId = String(globalThis.document?.body?.className || "").match(/(?:^|\s)course-([1-9][0-9]*)(?:\s|$)/)?.[1] || "";
    if (cfgCourseId && bodyCourseId && bodyCourseId !== cfgCourseId) return null;
    const currentCourseId = cfgCourseId || bodyCourseId;
    if (!currentCourseId) return null;
    return {
      origin: site.origin,
      siteUrl: site.href,
      principalId,
      courseId: currentCourseId,
      sesskey: cfg.sesskey,
      basePath,
    };
  };
  const sameContext = (left, right) => left?.origin === right?.origin
    && left?.siteUrl === right?.siteUrl
    && left?.principalId === right?.principalId
    && left?.courseId === right?.courseId
    && left?.sesskey === right?.sesskey;
  const responseIsSameOrigin = (response, expected) => {
    // Browsers populate Response.url after redirects. The empty value exists in
    // minimal test doubles only; current-context readback still binds every call.
    if (!response?.url) return true;
    try {
      const responseUrl = new URL(response.url);
      return responseUrl.origin === expected.origin
        && (responseUrl.pathname === expected.basePath || responseUrl.pathname.startsWith(`${expected.basePath}/`));
    } catch {
      return false;
    }
  };
  const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const getAttribute = (tag, name) => {
    const attribute = escapeRegExp(name);
    const match = tag.match(new RegExp(`(?:^|\\s)${attribute}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
    return match ? (match[1] ?? match[2] ?? match[3] ?? "") : "";
  };
  const hasBooleanAttribute = (tag, name) => {
    const attribute = escapeRegExp(name);
    return new RegExp(`(?:^|\\s)${attribute}(?:\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s>]+))?(?=\\s|/?>)`, "i").test(tag);
  };
  const hasClass = (tag, className) => getAttribute(tag, "class").split(/\s+/).includes(className);
  // DOMParser creates a detached inert document. It decodes the full HTML
  // entity set without executing scripts or touching the active Moodle page.
  const decodeHtmlText = (value) => {
    if (typeof globalThis.DOMParser !== "function") return "";
    try {
      const detached = new globalThis.DOMParser().parseFromString(value, "text/html");
      for (const node of detached.querySelectorAll("script,style")) node.remove();
      return detached.body?.textContent || "";
    } catch {
      return "";
    }
  };
  const parseMConfigObject = (raw) => {
    const marker = /\bM\.cfg\s*=\s*/g;
    let match;
    const values = [];
    while ((match = marker.exec(raw))) {
      const start = raw.indexOf("{", marker.lastIndex);
      if (start < 0) continue;
      let depth = 0;
      let quote = "";
      let escaped = false;
      let end = -1;
      for (let index = start; index < raw.length; index += 1) {
        const character = raw[index];
        if (quote) {
          if (escaped) escaped = false;
          else if (character === "\\") escaped = true;
          else if (character === quote) quote = "";
          continue;
        }
        if (character === "\"" || character === "'") quote = character;
        else if (character === "{") depth += 1;
        else if (character === "}") {
          depth -= 1;
          if (depth === 0) {
            end = index;
            break;
          }
        }
      }
      if (end < 0) continue;
      try {
        const parsedConfig = JSON.parse(raw.slice(start, end + 1));
        if (isObject(parsedConfig)) values.push(parsedConfig);
      } catch {
        // Another script can use a non-JSON object. It is not a Moodle proof.
      }
      marker.lastIndex = end + 1;
    }
    return values;
  };
  const parseCourseContext = (raw, expectedCourseId, expectedPrincipalId, expectedSiteUrl) => {
    const matches = parseMConfigObject(raw).filter((cfg) => {
      if (courseId(cfg.courseId) !== expectedCourseId || courseId(cfg.userId) !== expectedPrincipalId) return false;
      try { return new URL(cfg.wwwroot).href === expectedSiteUrl; } catch { return false; }
    });
    const contextIds = new Set(matches.map((cfg) => courseId(cfg.courseContextId)).filter(Boolean));
    return contextIds.size === 1 ? [...contextIds][0] : "";
  };
  const hasPermissionProof = (raw, expectedPrincipalId, expectedContextId, expectedContext) => {
    const formMatch = [...raw.matchAll(/<form\b[^>]*>/gi)].find((match) => {
      const action = getAttribute(match[0], "action").replace(/&amp;/gi, "&");
      try {
        const url = new URL(action, expectedContext.siteUrl);
        const contextIds = url.searchParams.getAll("contextid");
        return getAttribute(match[0], "method").toLowerCase() === "post"
          && url.origin === expectedContext.origin
          && url.pathname === `${expectedContext.basePath}${CAPABILITY_PAGE_PATH}`
          && contextIds.length === 1
          && contextIds[0] === expectedContextId;
      } catch {
        return false;
      }
    });
    if (!formMatch) return false;
    const formStart = formMatch.index + formMatch[0].length;
    const formEnd = raw.indexOf("</form>", formStart);
    if (formEnd < 0) return false;
    const form = raw.slice(formStart, formEnd);
    const selectMatch = /<select\b[^>]*\bname\s*=\s*(?:"reportuser"|'reportuser'|reportuser)[^>]*>([\s\S]*?)<\/select\s*>/i.exec(form);
    if (!selectMatch) return false;
    const selected = [...selectMatch[1].matchAll(/<option\b[^>]*>/gi)].filter((match) => hasBooleanAttribute(match[0], "selected"));
    if (selected.length !== 1 || getAttribute(selected[0][0], "value") !== expectedPrincipalId) return false;
    const openingTable = /<table\b[^>]*>/gi;
    let tableMatch;
    let table = "";
    while ((tableMatch = openingTable.exec(raw))) {
      if (getAttribute(tableMatch[0], "id") !== "explaincaps") continue;
      const closingIndex = raw.indexOf("</table>", openingTable.lastIndex);
      if (closingIndex < 0) return false;
      table = raw.slice(tableMatch.index, closingIndex + "</table>".length);
      break;
    }
    if (!table) return false;
    const allowed = new Set();
    const rows = table.matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr\s*>/gi);
    for (const rowMatch of rows) {
      const row = rowMatch[0];
      const opening = row.match(/<tr\b[^>]*>/i)?.[0] || "";
      if (!hasClass(opening, "rolecap") || !hasClass(opening, "yes")) continue;
      const nameMatch = row.match(/<span\b[^>]*class\s*=\s*(?:"[^"]*\bcap-name\b[^"]*"|'[^']*\bcap-name\b[^']*')[^>]*>\s*([^<]+?)\s*<\/span\s*>/i);
      if (nameMatch) allowed.add(nameMatch[1].trim());
    }
    return REQUIRED_CAPABILITIES.every((capability) => allowed.has(capability));
  };
  const parseTablePage = (raw, expectedCourseId) => {
    const openingDiv = /<div\b[^>]*>/gi;
    let wrapper = "";
    let totalRows = null;
    while (true) {
      const match = openingDiv.exec(raw);
      if (!match) break;
      if (getAttribute(match[0], "data-region") !== "core_table/dynamic"
        || getAttribute(match[0], "data-table-component") !== "core_user"
        || getAttribute(match[0], "data-table-handler") !== "participants"
        || getAttribute(match[0], "data-table-uniqueid") !== `user-index-participants-${expectedCourseId}`) {
        continue;
      }
      const value = getAttribute(match[0], "data-table-total-rows");
      if (!/^(?:0|[1-9][0-9]{0,5})$/.test(value)) return { error: "moodle_roster_table_total_invalid" };
      totalRows = Number(value);
      if (!Number.isSafeInteger(totalRows) || totalRows > MAX_IDENTITIES) return { error: "moodle_roster_table_total_bounds" };
      wrapper = raw.slice(match.index);
      break;
    }
    if (!wrapper || totalRows === null) return { error: "moodle_roster_table_proof_missing" };
    const identities = [];
    const rows = wrapper.matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr\s*>/gi);
    for (const rowMatch of rows) {
      const row = rowMatch[0];
      const inputs = [...row.matchAll(/<input\b[^>]*>/gi)].map((match) => match[0]).filter((tag) => hasClass(tag, "usercheckbox"));
      if (!inputs.length) continue;
      if (inputs.length !== 1) return { error: "moodle_roster_table_row_invalid" };
      const userId = getAttribute(inputs[0], "name").match(/^user([1-9][0-9]{0,18})$/)?.[1] || "";
      const cells = [...row.matchAll(/<(?:td|th)\b[^>]*>([\s\S]*?)<\/(?:td|th)\s*>/gi)].map((match) => match[1]);
      const name = cells.length >= 2 ? stableName(decodeHtmlText(cells[1])) : "";
      if (!userId || !name) return { error: "moodle_roster_table_row_invalid" };
      identities.push({ id: userId, name });
    }
    return { totalRows, identities };
  };

  const parsed = parseInput();
  if (!isObject(parsed) || !isObject(parsed.binding)) return failed("refused", "moodle_roster_arguments_invalid");
  const binding = parsed.binding;
  const requestedCourseId = courseId(parsed.courseId);
  const boundCourseId = courseId(binding.courseId);
  const sourceBindingId = text(binding.sourceBindingId, 160);
  const origin = text(binding.origin, 500);
  const siteUrl = text(binding.siteUrl, 500);
  const principalId = courseId(binding.principalId);
  const principalFingerprint = text(binding.principalFingerprint, 64);
  const sessionGeneration = binding.sessionGeneration;
  const catalogDigest = text(binding.catalogDigest, 64);
  const expiresAt = parsed.expiresAt;
  let boundSite;
  try { boundSite = new URL(siteUrl); } catch { boundSite = null; }
  if (!requestedCourseId || requestedCourseId !== boundCourseId || !sourceBindingPattern.test(sourceBindingId)
    || !boundSite || boundSite.protocol !== "https:" || boundSite.search || boundSite.hash || boundSite.username || boundSite.password
    || origin !== boundSite.origin || !principalId || !digestPattern.test(principalFingerprint)
    || !Number.isSafeInteger(sessionGeneration) || sessionGeneration < 1 || !digestPattern.test(catalogDigest)
    || !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + 60_000) {
    return failed("refused", "moodle_roster_binding_invalid");
  }
  const context = currentContext();
  // The authenticated page is a site anchor. The target course is proved by
  // source M.cfg on the native target page below, not by the anchor's course id.
  if (!context || context.origin !== origin || context.siteUrl !== boundSite.href || context.principalId !== principalId) {
    return failed("refused", "moodle_roster_binding_mismatch");
  }
  const base = {
    sourceBindingId,
    courseId: requestedCourseId,
    origin,
    siteUrl: context.siteUrl,
    principalFingerprint,
    sessionGeneration,
    catalogDigest,
  };
  const requestUrl = (method) => {
    const url = new URL(context.siteUrl);
    url.pathname = `${context.basePath}/lib/ajax/service.php`;
    url.search = new URLSearchParams({ sesskey: context.sesskey, info: method }).toString();
    url.hash = "";
    return url.toString();
  };
  const requestAjax = async (method, args) => {
    let response;
    try {
      response = await fetch(requestUrl(method), {
        method: "POST",
        credentials: "include",
        cache: "no-store",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify([{ index: 0, methodname: method, args }]),
      });
    } catch {
      return { error: "moodle_roster_request_failed" };
    }
    if (!responseIsSameOrigin(response, context)) return { error: "moodle_roster_response_origin_invalid" };
    if (!sameContext(context, currentContext())) return { error: "moodle_roster_session_changed" };
    let raw;
    try { raw = await response.text(); } catch { return { error: "moodle_roster_response_unavailable" }; }
    if (raw.length > MAX_RESPONSE_CHARS) return { error: "moodle_roster_response_too_large" };
    let payload;
    try { payload = JSON.parse(raw); } catch { return { error: "moodle_roster_response_invalid" }; }
    if (!response.ok || !Array.isArray(payload) || payload.length !== 1 || !isObject(payload[0])
      || payload[0].error || payload[0].exception || !("data" in payload[0])) {
      return { error: "moodle_roster_ajax_failed" };
    }
    return { data: payload[0].data };
  };
  const requestNative = async (path, params, method = "GET", queryParams = params) => {
    if (Date.now() >= expiresAt) return { error: "moodle_roster_execution_expired" };
    const url = new URL(context.siteUrl);
    url.pathname = `${context.basePath}${path}`;
    url.search = new URLSearchParams(queryParams).toString();
    url.hash = "";
    let response;
    try {
      response = await fetch(url.toString(), {
        method,
        credentials: "include",
        cache: "no-store",
        redirect: "follow",
        headers: method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded" } : undefined,
        ...(method === "POST" ? { body: new URLSearchParams(params).toString() } : {}),
      });
    } catch {
      return { error: "moodle_roster_request_failed" };
    }
    if (!responseIsSameOrigin(response, context)) return { error: "moodle_roster_response_origin_invalid" };
    if (!sameContext(context, currentContext())) return { error: "moodle_roster_session_changed" };
    if (!response.ok) return { error: "moodle_roster_native_request_failed" };
    let raw;
    try { raw = await response.text(); } catch { return { error: "moodle_roster_response_unavailable" }; }
    if (raw.length > MAX_RESPONSE_CHARS) return { error: "moodle_roster_response_too_large" };
    return { raw };
  };
  const readScope = async () => {
    const coursePage = await requestNative(COURSE_PAGE_PATH, {
      id: requestedCourseId,
      page: "0",
      perpage: "1",
    });
    if (!coursePage.raw) return { error: coursePage.error };
    const courseContextId = parseCourseContext(coursePage.raw, requestedCourseId, principalId, context.siteUrl);
    if (!courseContextId) return { error: "moodle_roster_native_course_proof_invalid" };
    // Moodle's check-permissions page is a source read. It receives only the
    // bound principal and the target course context; it does not mutate roles.
    const capabilityPage = await requestNative(CAPABILITY_PAGE_PATH, {
      reportuser: principalId,
    }, "POST", {
      contextid: courseContextId,
    });
    if (!capabilityPage.raw) return { error: capabilityPage.error };
    if (!hasPermissionProof(capabilityPage.raw, principalId, courseContextId, context)) {
      return { error: "moodle_roster_capability_proof_unavailable" };
    }
    return {
      scope: {
        method: "moodle.native.admin.roles.check",
        outcome: "explicit_course_capabilities",
      },
    };
  };

  const scopeResult = await readScope();
  if (!scopeResult.scope) return failed("refused", scopeResult.error, [0, 0, 0, 0], base);
  const identities = [];
  const seen = new Set();
  let requestCount = 0;
  let pageCount = 0;
  let rowCount = 0;
  let totalRows = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    if (Date.now() >= expiresAt) {
      return failed(pageCount ? "partial" : "refused", "moodle_roster_execution_expired", [requestCount, pageCount, rowCount, identities.length], base, scopeResult.scope, totalRows);
    }
    requestCount += 1;
    const result = await requestAjax(TABLE_METHOD, {
      component: "core_user",
      handler: "participants",
      uniqueid: `user-index-participants-${requestedCourseId}`,
      sortdata: [{ sortby: "lastname", sortorder: 4 }],
      filters: [{ name: "courseid", jointype: 1, values: [Number(requestedCourseId)] }],
      jointype: 1,
      firstinitial: "",
      lastinitial: "",
      pagenumber: page + 1,
      pagesize: PAGE_SIZE,
      hiddencolumns: [],
      resetpreferences: false,
    });
    if (!isObject(result.data) || typeof result.data.html !== "string") {
      return failed(pageCount ? "partial" : "refused", result.error || "moodle_roster_table_response_invalid", [requestCount, pageCount, rowCount, identities.length], base, scopeResult.scope, totalRows);
    }
    const parsedPage = parseTablePage(result.data.html, requestedCourseId);
    if (parsedPage.error) {
      return failed(pageCount ? "partial" : "refused", parsedPage.error, [requestCount, pageCount, rowCount, identities.length], base, scopeResult.scope, totalRows);
    }
    if (totalRows === null) totalRows = parsedPage.totalRows;
    else if (totalRows !== parsedPage.totalRows) {
      return failed("partial", "moodle_roster_table_total_changed", [requestCount, pageCount, rowCount, identities.length], base, scopeResult.scope, totalRows);
    }
    const expectedPageRows = Math.min(PAGE_SIZE, Math.max(0, totalRows - (page * PAGE_SIZE)));
    if (parsedPage.identities.length !== expectedPageRows) {
      return failed("partial", "moodle_roster_table_page_bounds_invalid", [requestCount, pageCount, rowCount, identities.length], base, scopeResult.scope, totalRows);
    }
    pageCount += 1;
    rowCount += parsedPage.identities.length;
    for (const identity of parsedPage.identities) {
      if (seen.has(identity.id)) {
        return failed("partial", "moodle_roster_duplicate_identity", [requestCount, pageCount, rowCount, identities.length], base, scopeResult.scope, totalRows);
      }
      seen.add(identity.id);
      identities.push(identity);
    }
    if (identities.length === totalRows) {
      return {
        schema: SCHEMA,
        provider: "moodle",
        ...base,
        status: "complete",
        complete: true,
        identities,
        proof: proof(requestCount, pageCount, rowCount, identities.length, scopeResult.scope, totalRows),
      };
    }
  }
  return failed("partial", "moodle_roster_page_limit_reached", [requestCount, pageCount, rowCount, identities.length], base, scopeResult.scope, totalRows);
}
