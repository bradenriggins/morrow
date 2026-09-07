/**
 * Reads the participant and enrolment state of one exact Moodle course.
 *
 * Three separate reads share one rule: the raw Moodle page holds names, email
 * addresses and profile links, and none of them leaves this page-world
 * function. Only the Moodle user ID leaves, inside `learner` or `participants`,
 * so the MCP runtime can project it through the complete participant roster and
 * refuse an identity that roster does not hold.
 *
 * Each function is self-contained because Chrome serializes it for MAIN-world
 * injection, so no helper is shared between them.
 */

/**
 * Bounded participant list for one exact course: the Moodle user ID, the role
 * names the participants table renders, and the names of the enrolment methods
 * that placed the user in the course. No status, no dates, no identity text.
 */
export async function executeMoodleCourseParticipantsInPage(rawInput) {
  const PROVIDER = "moodle";
  const OPERATION = "moodle.form.enrol.participants.read.v1";
  const TOOL = "moodle_get_course_participants";
  const SCHEMA = "morrow.moodle-course-participants.v1";
  const METHOD = "core_table_get_dynamic_table_content";
  const CAPABILITIES = ["moodle/course:viewparticipants", "moodle/course:enrolreview"];
  const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
  const PAGE_SIZE = 100;
  const MAX_PARTICIPANTS = 500;
  const MAX_PAGE_REQUESTS = MAX_PARTICIPANTS / PAGE_SIZE;
  const MAX_ROLES = 20;
  const MAX_ENROLMENTS = 20;
  const MAX_LABEL = 200;
  const ID = /^[1-9][0-9]{0,18}$/;
  const object = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
  const id = (value) => {
    const raw = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : typeof value === "string" ? value : "";
    return ID.test(raw) ? raw : "";
  };
  const text = (value, maximum = 1_024) => typeof value === "string" && value.length > 0 && value.length <= maximum
    && !/[\u0000-\u001f\u007f]/.test(value);
  const label = (value) => {
    const collapsed = String(value ?? "").replace(/\s+/g, " ").trim();
    return text(collapsed, MAX_LABEL) ? collapsed : "";
  };
  const fail = (error) => ({ ok: false, sent: false, error });
  const incomplete = () => ({ ok: false, sent: false, complete: false, error: "moodle_course_participants_incomplete" });
  const input = (() => { try { return typeof rawInput === "string" ? JSON.parse(rawInput) : rawInput; } catch { return null; } })();
  const cfg = globalThis.M?.cfg;
  if (!object(input) || !object(cfg) || typeof cfg.wwwroot !== "string" || !text(cfg.sesskey)) {
    return fail("moodle_course_participants_context_invalid");
  }
  let site;
  try { site = new URL(cfg.wwwroot); } catch { return fail("moodle_course_participants_context_invalid"); }
  const basePath = site.pathname.replace(/\/$/, "");
  const bodyCourse = String(globalThis.document?.body?.className || "").match(/(?:^|\s)course-([1-9][0-9]*)(?:\s|$)/)?.[1] || "";
  const courseId = id(cfg.courseId) || bodyCourse;
  const principalId = id(cfg.userId);
  const currentPath = String(globalThis.location?.pathname || "");
  if (site.protocol !== "https:" || site.search || site.hash || site.username || site.password
    || site.origin !== globalThis.location?.origin || !(currentPath === basePath || currentPath.startsWith(`${basePath}/`))
    || !courseId || !principalId) return fail("moodle_course_participants_context_invalid");
  const operation = input.operation;
  const args = input.arguments;
  const binding = input.binding;
  if (!object(operation) || operation.key !== OPERATION || operation.toolName !== TOOL || operation.provider !== PROVIDER
    || operation.readOnly !== true || !object(args) || Object.keys(args).length !== 1 || id(args.course_id) !== courseId
    || !object(binding) || binding.origin !== site.origin || binding.siteUrl !== site.href
    || id(binding.principalId) !== principalId || id(binding.courseId) !== courseId
    || !Number.isSafeInteger(input.expiresAt) || input.expiresAt <= Date.now()) {
    return fail("moodle_course_participants_arguments_invalid");
  }
  const sameContext = () => globalThis.M?.cfg?.sesskey === cfg.sesskey && id(globalThis.M?.cfg?.userId) === principalId
    && (id(globalThis.M?.cfg?.courseId) || bodyCourse) === courseId;
  const endpointFor = (path, query) => {
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
  const ajax = async (methodArgs) => {
    if (Date.now() >= input.expiresAt || !sameContext()) return { error: "moodle_course_participants_context_changed" };
    const endpoint = endpointFor("/lib/ajax/service.php", { sesskey: cfg.sesskey, info: METHOD });
    let response;
    try {
      response = await fetch(endpoint, {
        method: "POST", credentials: "include", cache: "no-store", redirect: "error",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify([{ index: 0, methodname: METHOD, args: methodArgs }]),
      });
    } catch { return { error: "moodle_course_participants_request_failed" }; }
    const raw = await boundedText(response, endpoint);
    if (raw === "limit") return { incomplete: true };
    if (typeof raw !== "string") return { error: "moodle_course_participants_response_unavailable" };
    try {
      const payload = JSON.parse(raw);
      if (!Array.isArray(payload) || payload.length !== 1 || !object(payload[0]) || payload[0].index !== 0
        || payload[0].error || payload[0].exception || !("data" in payload[0])) {
        return { error: "moodle_course_participants_service_unavailable" };
      }
      const data = typeof payload[0].data === "string" ? JSON.parse(payload[0].data) : payload[0].data;
      return object(data) && typeof data.html === "string"
        ? { html: data.html }
        : { error: "moodle_course_participants_response_invalid" };
    } catch { return { error: "moodle_course_participants_response_invalid" }; }
  };
  // The participants table is the only route read here. Its status column
  // renders one element per user enrolment, and Moodle renders that column
  // only for a principal who holds moodle/course:enrolreview at this course.
  const parsePage = (html) => {
    if (typeof globalThis.DOMParser !== "function") return { error: "moodle_course_participants_response_invalid" };
    let documentValue;
    try { documentValue = new DOMParser().parseFromString(html, "text/html"); } catch { return { error: "moodle_course_participants_response_invalid" }; }
    const wrappers = [...documentValue.querySelectorAll('div[data-region="core_table/dynamic"]')].filter((node) => (
      node.getAttribute("data-table-component") === "core_user"
      && node.getAttribute("data-table-handler") === "participants"
      && node.getAttribute("data-table-uniqueid") === `user-index-participants-${courseId}`
    ));
    if (wrappers.length !== 1) return { error: "moodle_course_participants_table_proof_missing" };
    const declared = wrappers[0].getAttribute("data-table-total-rows") || "";
    if (!/^(?:0|[1-9][0-9]{0,6})$/.test(declared)) return { error: "moodle_course_participants_table_total_invalid" };
    const participants = [];
    for (const row of wrappers[0].querySelectorAll("tr")) {
      const checkboxes = row.querySelectorAll("input.usercheckbox");
      if (checkboxes.length === 0) continue;
      if (checkboxes.length !== 1) return { error: "moodle_course_participants_row_invalid" };
      const userId = /^user([1-9][0-9]{0,18})$/.exec(checkboxes[0].getAttribute("name") || "")?.[1] || "";
      const roleNodes = [...row.querySelectorAll('[data-itemtype="user_roles"]')]
        .filter((node) => node.getAttribute("data-component") === "core_role");
      if (!userId || roleNodes.length !== 1) return { error: "moodle_course_participants_row_invalid" };
      const roles = String(roleNodes[0].textContent || "").split(",").map(label).filter((value) => value.length > 0);
      if (roles.length > MAX_ROLES) return { bound: true };
      // Nested matches would count one enrolment twice, so only the outermost
      // element of each status field is taken.
      const enrolmentNodes = [...row.querySelectorAll("[data-status][data-enrolinstancename]")]
        .filter((node) => !node.parentElement || node.parentElement.closest("[data-status][data-enrolinstancename]") === null);
      if (enrolmentNodes.length === 0) return { error: "moodle_course_participants_enrolment_unavailable" };
      if (enrolmentNodes.length > MAX_ENROLMENTS) return { bound: true };
      const methods = [];
      for (const node of enrolmentNodes) {
        const name = label(node.getAttribute("data-enrolinstancename"));
        if (!name) return { error: "moodle_course_participants_row_invalid" };
        methods.push(name);
      }
      participants.push({ user_id: userId, roles, enrolment_methods: methods });
    }
    return { totalRows: Number(declared), participants };
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

  const participants = [];
  const seen = new Set();
  let totalRows = null;
  let pageRequestCount = 0;
  for (let page = 0; page < MAX_PAGE_REQUESTS; page += 1) {
    const result = await ajax({
      component: "core_user",
      handler: "participants",
      uniqueid: `user-index-participants-${courseId}`,
      sortdata: [{ sortby: "lastname", sortorder: 4 }],
      filters: [{ name: "courseid", jointype: 1, values: [Number(courseId)] }],
      jointype: 1,
      firstinitial: "",
      lastinitial: "",
      pagenumber: page + 1,
      pagesize: PAGE_SIZE,
      hiddencolumns: [],
      resetpreferences: false,
    });
    if (result.incomplete) return incomplete();
    if (typeof result.html !== "string") return fail(result.error || "moodle_course_participants_response_invalid");
    pageRequestCount += 1;
    const parsed = parsePage(result.html);
    if (parsed.bound) return incomplete();
    if (parsed.error) return fail(parsed.error);
    if (totalRows === null) totalRows = parsed.totalRows;
    else if (totalRows !== parsed.totalRows) return fail("moodle_course_participants_table_total_changed");
    // A course larger than the bound is reported as incomplete before any row
    // is kept, so a partial list can never read as the whole course.
    if (totalRows > MAX_PARTICIPANTS) return incomplete();
    const expectedRows = Math.min(PAGE_SIZE, Math.max(0, totalRows - (page * PAGE_SIZE)));
    if (parsed.participants.length !== expectedRows) return fail("moodle_course_participants_page_bounds_invalid");
    for (const participant of parsed.participants) {
      if (seen.has(participant.user_id)) return fail("moodle_course_participants_duplicate_identity");
      seen.add(participant.user_id);
      participants.push(participant);
    }
    if (participants.length === totalRows) {
      if (!sameContext() || Date.now() > input.expiresAt) return fail("moodle_course_participants_context_changed");
      const data = {
        schema: SCHEMA,
        provider: PROVIDER,
        course_id: Number(courseId),
        participant_count: participants.length,
        participants,
        proof: {
          method: METHOD,
          complete: true,
          required_capabilities: [...CAPABILITIES],
          participant_limit: MAX_PARTICIPANTS,
          page_size: PAGE_SIZE,
          page_request_limit: MAX_PAGE_REQUESTS,
          page_request_count: pageRequestCount,
          total_rows: totalRows,
        },
      };
      const snapshotDigest = await digest(data);
      if (!snapshotDigest) return fail("moodle_course_participants_digest_unavailable");
      return { ok: true, sent: false, complete: true, data, snapshot_digest: snapshotDigest };
    }
  }
  return incomplete();
}

/**
 * The enrolment methods configured on one exact course, read from Moodle's own
 * enrolment-methods page. It carries no learner identity of any kind: one row
 * per method with its name, whether it is enabled, and how many users it holds.
 */
export async function executeMoodleEnrolmentMethodsInPage(rawInput) {
  const PROVIDER = "moodle";
  const OPERATION = "moodle.form.enrol.methods.read.v1";
  const TOOL = "moodle_get_enrolment_methods";
  const SCHEMA = "morrow.moodle-enrolment-methods.v1";
  const METHOD = "native_enrol_instances_page";
  const CAPABILITIES = ["moodle/course:viewparticipants", "moodle/course:enrolreview"];
  const PATH = "/enrol/instances.php";
  const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
  const MAX_METHODS = 100;
  const MAX_USERS = 1_000_000;
  const MAX_LABEL = 200;
  const ID = /^[1-9][0-9]{0,18}$/;
  const object = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
  const id = (value) => {
    const raw = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : typeof value === "string" ? value : "";
    return ID.test(raw) ? raw : "";
  };
  const text = (value, maximum = 1_024) => typeof value === "string" && value.length > 0 && value.length <= maximum
    && !/[\u0000-\u001f\u007f]/.test(value);
  const label = (value) => {
    const collapsed = String(value ?? "").replace(/\s+/g, " ").trim();
    return text(collapsed, MAX_LABEL) ? collapsed : "";
  };
  const fail = (error) => ({ ok: false, sent: false, error });
  const incomplete = () => ({ ok: false, sent: false, complete: false, error: "moodle_enrolment_methods_incomplete" });
  const input = (() => { try { return typeof rawInput === "string" ? JSON.parse(rawInput) : rawInput; } catch { return null; } })();
  const cfg = globalThis.M?.cfg;
  if (!object(input) || !object(cfg) || typeof cfg.wwwroot !== "string" || !text(cfg.sesskey)) {
    return fail("moodle_enrolment_methods_context_invalid");
  }
  let site;
  try { site = new URL(cfg.wwwroot); } catch { return fail("moodle_enrolment_methods_context_invalid"); }
  const basePath = site.pathname.replace(/\/$/, "");
  const bodyCourse = String(globalThis.document?.body?.className || "").match(/(?:^|\s)course-([1-9][0-9]*)(?:\s|$)/)?.[1] || "";
  const courseId = id(cfg.courseId) || bodyCourse;
  const principalId = id(cfg.userId);
  const currentPath = String(globalThis.location?.pathname || "");
  if (site.protocol !== "https:" || site.search || site.hash || site.username || site.password
    || site.origin !== globalThis.location?.origin || !(currentPath === basePath || currentPath.startsWith(`${basePath}/`))
    || !courseId || !principalId) return fail("moodle_enrolment_methods_context_invalid");
  const operation = input.operation;
  const args = input.arguments;
  const binding = input.binding;
  if (!object(operation) || operation.key !== OPERATION || operation.toolName !== TOOL || operation.provider !== PROVIDER
    || operation.readOnly !== true || !object(args) || Object.keys(args).length !== 1 || id(args.course_id) !== courseId
    || !object(binding) || binding.origin !== site.origin || binding.siteUrl !== site.href
    || id(binding.principalId) !== principalId || id(binding.courseId) !== courseId
    || !Number.isSafeInteger(input.expiresAt) || input.expiresAt <= Date.now()) {
    return fail("moodle_enrolment_methods_arguments_invalid");
  }
  const sameContext = () => globalThis.M?.cfg?.sesskey === cfg.sesskey && id(globalThis.M?.cfg?.userId) === principalId
    && (id(globalThis.M?.cfg?.courseId) || bodyCourse) === courseId;
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
  // Every M.cfg object the returned page declares, so the page itself proves
  // which site, principal and course it belongs to before anything is parsed.
  const pageConfigs = (raw) => {
    const marker = /\bM\.cfg\s*=\s*/g;
    const values = [];
    let match;
    while ((match = marker.exec(raw))) {
      const start = raw.indexOf("{", marker.lastIndex);
      if (start < 0) break;
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
          if (depth === 0) { end = index; break; }
        }
      }
      if (end < 0) break;
      try {
        const parsed = JSON.parse(raw.slice(start, end + 1));
        if (object(parsed)) values.push(parsed);
      } catch {
        // Another script may assign a non-JSON object. It is not a Moodle proof.
      }
      marker.lastIndex = end + 1;
    }
    return values;
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

  const endpoint = new URL(site.href);
  endpoint.pathname = `${basePath}${PATH}`;
  endpoint.search = new URLSearchParams({ id: courseId }).toString();
  endpoint.hash = "";
  let response;
  try {
    response = await fetch(endpoint, {
      method: "GET", credentials: "include", cache: "no-store", redirect: "error", headers: { Accept: "text/html" },
    });
  } catch { return fail("moodle_enrolment_methods_request_failed"); }
  const raw = await boundedText(response, endpoint);
  if (raw === "limit") return incomplete();
  if (typeof raw !== "string") return fail("moodle_enrolment_methods_response_unavailable");
  if (!pageConfigs(raw).some((value) => {
    try {
      return id(value.courseId) === courseId && id(value.userId) === principalId && new URL(value.wwwroot).href === site.href;
    } catch { return false; }
  })) return fail("moodle_enrolment_methods_page_proof_invalid");
  if (typeof globalThis.DOMParser !== "function") return fail("moodle_enrolment_methods_response_invalid");
  let documentValue;
  try { documentValue = new DOMParser().parseFromString(raw, "text/html"); } catch { return fail("moodle_enrolment_methods_response_invalid"); }
  // Moodle builds this page from one three-column table: the method name, the
  // number of users it holds, and its management actions. Exactly one table on
  // the page may carry that shape, or the parse refuses rather than guessing.
  const candidates = [];
  let overBound = false;
  for (const table of documentValue.querySelectorAll("table")) {
    const rows = [...table.querySelectorAll("tbody > tr")];
    if (rows.length === 0) continue;
    if (rows.length > MAX_METHODS) { overBound = true; continue; }
    const methods = [];
    for (const row of rows) {
      const cells = [...row.children].filter((cell) => cell.tagName === "TD" || cell.tagName === "TH");
      if (cells.length !== 3) { methods.length = 0; break; }
      const name = label(cells[0].textContent);
      const users = label(cells[1].textContent);
      if (!name || !/^(?:0|[1-9][0-9]{0,8})$/.test(users) || Number(users) > MAX_USERS) { methods.length = 0; break; }
      methods.push({
        name,
        // Moodle dims the name of an enrolment method it has switched off.
        enabled: !cells[0].classList.contains("dimmed_text") && cells[0].querySelector(".dimmed_text") === null,
        participant_count: Number(users),
      });
    }
    if (methods.length === rows.length) candidates.push(methods);
  }
  if (candidates.length > 1) return fail("moodle_enrolment_methods_table_ambiguous");
  if (candidates.length === 0) return overBound ? incomplete() : fail("moodle_enrolment_methods_table_missing");
  if (!sameContext() || Date.now() > input.expiresAt) return fail("moodle_enrolment_methods_context_changed");
  const data = {
    schema: SCHEMA,
    provider: PROVIDER,
    course_id: Number(courseId),
    method_count: candidates[0].length,
    methods: candidates[0],
    proof: {
      method: METHOD,
      complete: true,
      required_capabilities: [...CAPABILITIES],
      method_limit: MAX_METHODS,
    },
  };
  const snapshotDigest = await digest(data);
  if (!snapshotDigest) return fail("moodle_enrolment_methods_digest_unavailable");
  return { ok: true, sent: false, complete: true, data, snapshot_digest: snapshotDigest };
}

/**
 * The enrolment record of one exact requested learner: for each enrolment, the
 * method that placed them in the course, the status label the site renders, and
 * the start and end of that enrolment. The Moodle user ID survives only inside
 * `learner` so the runtime can project it through the participant roster.
 */
export async function executeMoodleParticipantEnrolmentInPage(rawInput) {
  const PROVIDER = "moodle";
  const OPERATION = "moodle.form.enrol.participant.read.v1";
  const TOOL = "moodle_get_participant_enrolment";
  const SCHEMA = "morrow.moodle-participant-enrolment.v1";
  const METHOD = "core_table_get_dynamic_table_content";
  const CAPABILITIES = ["moodle/course:viewparticipants", "moodle/course:enrolreview"];
  const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
  const PAGE_SIZE = 100;
  const MAX_PARTICIPANTS = 500;
  const MAX_PAGE_REQUESTS = MAX_PARTICIPANTS / PAGE_SIZE;
  const MAX_ENROLMENTS = 20;
  const MAX_LABEL = 200;
  const MAX_SECONDS = 253_402_300_799;
  const ID = /^[1-9][0-9]{0,18}$/;
  const object = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
  const id = (value) => {
    const raw = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : typeof value === "string" ? value : "";
    return ID.test(raw) ? raw : "";
  };
  const text = (value, maximum = 1_024) => typeof value === "string" && value.length > 0 && value.length <= maximum
    && !/[\u0000-\u001f\u007f]/.test(value);
  const label = (value) => {
    const collapsed = String(value ?? "").replace(/\s+/g, " ").trim();
    return text(collapsed, MAX_LABEL) ? collapsed : "";
  };
  const fail = (error) => ({ ok: false, sent: false, error });
  const incomplete = () => ({ ok: false, sent: false, complete: false, error: "moodle_participant_enrolment_incomplete" });
  const input = (() => { try { return typeof rawInput === "string" ? JSON.parse(rawInput) : rawInput; } catch { return null; } })();
  const cfg = globalThis.M?.cfg;
  if (!object(input) || !object(cfg) || typeof cfg.wwwroot !== "string" || !text(cfg.sesskey)) {
    return fail("moodle_participant_enrolment_context_invalid");
  }
  let site;
  try { site = new URL(cfg.wwwroot); } catch { return fail("moodle_participant_enrolment_context_invalid"); }
  const basePath = site.pathname.replace(/\/$/, "");
  const bodyCourse = String(globalThis.document?.body?.className || "").match(/(?:^|\s)course-([1-9][0-9]*)(?:\s|$)/)?.[1] || "";
  const courseId = id(cfg.courseId) || bodyCourse;
  const principalId = id(cfg.userId);
  const currentPath = String(globalThis.location?.pathname || "");
  if (site.protocol !== "https:" || site.search || site.hash || site.username || site.password
    || site.origin !== globalThis.location?.origin || !(currentPath === basePath || currentPath.startsWith(`${basePath}/`))
    || !courseId || !principalId) return fail("moodle_participant_enrolment_context_invalid");
  const operation = input.operation;
  const args = input.arguments;
  const binding = input.binding;
  if (!object(operation) || operation.key !== OPERATION || operation.toolName !== TOOL || operation.provider !== PROVIDER
    || operation.readOnly !== true || !object(args) || Object.keys(args).length !== 2 || id(args.course_id) !== courseId
    || !id(args.user_id) || !object(binding) || binding.origin !== site.origin || binding.siteUrl !== site.href
    || id(binding.principalId) !== principalId || id(binding.courseId) !== courseId
    || !Number.isSafeInteger(input.expiresAt) || input.expiresAt <= Date.now()) {
    return fail("moodle_participant_enrolment_arguments_invalid");
  }
  const requestedUserId = id(args.user_id);
  const sameContext = () => globalThis.M?.cfg?.sesskey === cfg.sesskey && id(globalThis.M?.cfg?.userId) === principalId
    && (id(globalThis.M?.cfg?.courseId) || bodyCourse) === courseId;
  const endpointFor = (path, query) => {
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
  const ajax = async (methodArgs) => {
    if (Date.now() >= input.expiresAt || !sameContext()) return { error: "moodle_participant_enrolment_context_changed" };
    const endpoint = endpointFor("/lib/ajax/service.php", { sesskey: cfg.sesskey, info: METHOD });
    let response;
    try {
      response = await fetch(endpoint, {
        method: "POST", credentials: "include", cache: "no-store", redirect: "error",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify([{ index: 0, methodname: METHOD, args: methodArgs }]),
      });
    } catch { return { error: "moodle_participant_enrolment_request_failed" }; }
    const raw = await boundedText(response, endpoint);
    if (raw === "limit") return { incomplete: true };
    if (typeof raw !== "string") return { error: "moodle_participant_enrolment_response_unavailable" };
    try {
      const payload = JSON.parse(raw);
      if (!Array.isArray(payload) || payload.length !== 1 || !object(payload[0]) || payload[0].index !== 0
        || payload[0].error || payload[0].exception || !("data" in payload[0])) {
        return { error: "moodle_participant_enrolment_service_unavailable" };
      }
      const data = typeof payload[0].data === "string" ? JSON.parse(payload[0].data) : payload[0].data;
      return object(data) && typeof data.html === "string"
        ? { html: data.html }
        : { error: "moodle_participant_enrolment_response_invalid" };
    } catch { return { error: "moodle_participant_enrolment_response_invalid" }; }
  };
  // Moodle writes 0, or omits the attribute, when an enrolment has no bound.
  // A value that is present but not a plain timestamp is refused rather than
  // guessed at, so a date can never be inferred from unreadable markup.
  const instant = (value) => {
    if (value === null || value === undefined || value === "") return null;
    const raw = String(value);
    if (!/^(?:0|[1-9][0-9]{0,11})$/.test(raw)) return undefined;
    const seconds = Number(raw);
    if (seconds === 0) return null;
    if (seconds > MAX_SECONDS) return undefined;
    return new Date(seconds * 1000).toISOString();
  };
  const parsePage = (html) => {
    if (typeof globalThis.DOMParser !== "function") return { error: "moodle_participant_enrolment_response_invalid" };
    let documentValue;
    try { documentValue = new DOMParser().parseFromString(html, "text/html"); } catch { return { error: "moodle_participant_enrolment_response_invalid" }; }
    const wrappers = [...documentValue.querySelectorAll('div[data-region="core_table/dynamic"]')].filter((node) => (
      node.getAttribute("data-table-component") === "core_user"
      && node.getAttribute("data-table-handler") === "participants"
      && node.getAttribute("data-table-uniqueid") === `user-index-participants-${courseId}`
    ));
    if (wrappers.length !== 1) return { error: "moodle_participant_enrolment_table_proof_missing" };
    const declared = wrappers[0].getAttribute("data-table-total-rows") || "";
    if (!/^(?:0|[1-9][0-9]{0,6})$/.test(declared)) return { error: "moodle_participant_enrolment_table_total_invalid" };
    let rowCount = 0;
    let enrolments = null;
    for (const row of wrappers[0].querySelectorAll("tr")) {
      const checkboxes = row.querySelectorAll("input.usercheckbox");
      if (checkboxes.length === 0) continue;
      if (checkboxes.length !== 1) return { error: "moodle_participant_enrolment_row_invalid" };
      const userId = /^user([1-9][0-9]{0,18})$/.exec(checkboxes[0].getAttribute("name") || "")?.[1] || "";
      if (!userId) return { error: "moodle_participant_enrolment_row_invalid" };
      rowCount += 1;
      if (userId !== requestedUserId) continue;
      if (enrolments) return { error: "moodle_participant_enrolment_duplicate_identity" };
      const nodes = [...row.querySelectorAll("[data-status][data-enrolinstancename]")]
        .filter((node) => !node.parentElement || node.parentElement.closest("[data-status][data-enrolinstancename]") === null);
      if (nodes.length === 0) return { error: "moodle_participant_enrolment_unavailable" };
      if (nodes.length > MAX_ENROLMENTS) return { bound: true };
      enrolments = [];
      for (const node of nodes) {
        const method = label(node.getAttribute("data-enrolinstancename"));
        const status = label(node.getAttribute("data-status"));
        const start = instant(node.getAttribute("data-timestart"));
        const end = instant(node.getAttribute("data-timeend"));
        if (!method || !status || start === undefined || end === undefined) {
          return { error: "moodle_participant_enrolment_row_invalid" };
        }
        enrolments.push({ method, status, start, end });
      }
    }
    return { totalRows: Number(declared), rowCount, enrolments };
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

  let totalRows = null;
  let scannedRows = 0;
  let pageRequestCount = 0;
  for (let page = 0; page < MAX_PAGE_REQUESTS; page += 1) {
    const result = await ajax({
      component: "core_user",
      handler: "participants",
      uniqueid: `user-index-participants-${courseId}`,
      sortdata: [{ sortby: "lastname", sortorder: 4 }],
      filters: [{ name: "courseid", jointype: 1, values: [Number(courseId)] }],
      jointype: 1,
      firstinitial: "",
      lastinitial: "",
      pagenumber: page + 1,
      pagesize: PAGE_SIZE,
      hiddencolumns: [],
      resetpreferences: false,
    });
    if (result.incomplete) return incomplete();
    if (typeof result.html !== "string") return fail(result.error || "moodle_participant_enrolment_response_invalid");
    pageRequestCount += 1;
    const parsed = parsePage(result.html);
    if (parsed.bound) return incomplete();
    if (parsed.error) return fail(parsed.error);
    if (totalRows === null) totalRows = parsed.totalRows;
    else if (totalRows !== parsed.totalRows) return fail("moodle_participant_enrolment_table_total_changed");
    const expectedRows = Math.min(PAGE_SIZE, Math.max(0, totalRows - (page * PAGE_SIZE)));
    if (parsed.rowCount !== expectedRows) return fail("moodle_participant_enrolment_page_bounds_invalid");
    scannedRows += parsed.rowCount;
    if (parsed.enrolments) {
      if (!sameContext() || Date.now() > input.expiresAt) return fail("moodle_participant_enrolment_context_changed");
      const data = {
        schema: SCHEMA,
        provider: PROVIDER,
        course_id: Number(courseId),
        learner: { user_id: requestedUserId },
        enrolment_count: parsed.enrolments.length,
        enrolments: parsed.enrolments,
        proof: {
          method: METHOD,
          complete: true,
          required_capabilities: [...CAPABILITIES],
          participant_limit: MAX_PARTICIPANTS,
          page_size: PAGE_SIZE,
          page_request_limit: MAX_PAGE_REQUESTS,
          page_request_count: pageRequestCount,
        },
      };
      const snapshotDigest = await digest(data);
      if (!snapshotDigest) return fail("moodle_participant_enrolment_digest_unavailable");
      return { ok: true, sent: false, complete: true, data, snapshot_digest: snapshotDigest };
    }
    // Only a scan that reached the table's own last row can state that this
    // course does not hold the requested learner. A bound reached first is an
    // incomplete read, never an absent answer.
    if (scannedRows >= totalRows) return fail("moodle_participant_enrolment_absent");
  }
  return incomplete();
}
