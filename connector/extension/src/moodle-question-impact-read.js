/**
 * Enumerates every stored Question Bank reference reachable from one exact
 * Moodle course, so a later Question Bank write has a stated impact scope.
 *
 * This reader adds no write and unlocks none. The deterministic Question Bank
 * hold in connector/extension/src/moodle-executor.js stays in force whatever
 * this reader returns.
 *
 * A Quiz slot stores either a direct reference (question_references, one
 * Question Bank entry) or a random reference (question_set_references, a
 * questionscontextid plus a JSON filtercondition). Schema:
 * https://github.com/moodle/moodle/blob/v5.2.2/public/lib/db/install.xml#L1514-L1550
 * Random-slot validation and persistence:
 * https://github.com/moodle/moodle/blob/v5.2.2/public/mod/quiz/classes/structure.php#L1680-L1745
 * Category filter, including its jointype NONE form:
 * https://github.com/moodle/moodle/blob/v5.2.2/public/question/bank/managecategories/classes/category_condition.php#L145-L167
 * Random selection at run time:
 * https://github.com/moodle/moodle/blob/v5.2.2/public/question/classes/local/bank/random_question_loader.php#L121-L185
 * Bank usage query, the native view of the same references:
 * https://github.com/moodle/moodle/blob/v5.2.2/public/question/bank/usage/classes/helper.php#L107-L136
 *
 * Two facts keep this scope honest and are stated in every result.
 *
 * 1. The browser cannot resolve a Question Bank filter key to its server-side
 *    PHP condition class or to its plugin component. Moodle exposes only the
 *    key, title, required flag and optional JavaScript class.
 *    docs/implementation/MOODLE-FULL-FUNCTIONALITY.md lines 112 to 116 and
 *    moodle_get_question_bank_filter_inventory carry the same statement.
 *    A stored filter whose key is outside Morrow's recognised core set keeps
 *    the scope incomplete permanently.
 * 2. Morrow reads the stored random reference only where the native Quiz edit
 *    page carries it on the slot element as data-filtercondition, with
 *    data-questionscontextid or a questionscontextid field inside that JSON.
 *    Moodle renders random slots in more than one form across releases. This
 *    reader recognises that exact pair and nothing else, and reports
 *    random_filter_condition_not_exposed for any other rendering. It is not
 *    checked against a live Moodle site.
 *
 * Required capability: mod/quiz:manage at each Quiz module context, which is
 * what Moodle requires to open /mod/quiz/edit.php. This reader never opens
 * /mod/quiz/view.php, attempt.php, review.php or report.php, so it records no
 * completion, attempt or report event.
 */
export async function executeMoodleQuestionBankImpactScopeInPage(rawInput) {
  const PROVIDER = "moodle";
  const OPERATION = "moodle.form.question.bank.impact_scope.read.v1";
  const TOOL = "moodle_get_question_bank_impact_scope";
  const SCHEMA = "morrow.moodle-question-bank-impact-scope.v1";
  const STATE_METHOD = "core_courseformat_get_state";
  const QUIZ_EDIT_PATH = "/mod/quiz/edit.php";
  const QUESTION_EDIT_PATH = "/question/bank/editquestion/question.php";
  const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
  const MAX_QUIZZES = 50;
  const MAX_SLOTS_PER_QUIZ = 100;
  const MAX_FILTERS_PER_SLOT = 20;
  const MAX_FILTER_VALUES = 50;
  const MAX_REASONS = 200;
  // Only the core category condition analysed in the contract is recognised.
  // Every other stored filter key keeps the scope incomplete.
  const RECOGNISED_FILTER_KEYS = ["category"];
  // question/classes/local/bank/condition.php: NONE excludes, ANY is OR, ALL is AND.
  const JOINTYPE_NAMES = { 0: "none", 1: "any", 2: "all" };
  // The stored filtercondition envelope Morrow can reason about. Any other
  // top-level field means Morrow does not know what the slot selects.
  const FILTER_CONDITION_FIELDS = ["filter", "jointype", "questionscontextid", "qpage", "qperpage"];
  const ID = /^[1-9][0-9]{0,18}$/;
  const FILTER_KEY = /^[a-z][a-z0-9_]{0,63}$/;
  const FILTER_VALUE = /^[A-Za-z0-9_,.:@-]{1,64}$/;
  const object = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
  const id = (value) => {
    const value_ = Number.isSafeInteger(value) && value > 0 ? String(value) : typeof value === "string" ? value : "";
    return ID.test(value_) ? value_ : "";
  };
  const text = (value, maximum = 1_024) => typeof value === "string" && value.length > 0 && value.length <= maximum
    && !/[\u0000-\u001f\u007f]/.test(value);
  const name = (value, maximum = 1_333) => {
    const collapsed = String(value ?? "").replace(/\s+/g, " ").trim();
    return collapsed && collapsed.length <= maximum && !/[\u0000-\u001f\u007f]/.test(collapsed) ? collapsed : "";
  };
  const fail = (error) => ({ ok: false, sent: false, error });
  const input = (() => { try { return typeof rawInput === "string" ? JSON.parse(rawInput) : rawInput; } catch { return null; } })();
  const cfg = globalThis.M?.cfg;
  if (!object(input) || !object(cfg) || typeof cfg.wwwroot !== "string" || !text(cfg.sesskey)) {
    return fail("moodle_question_bank_impact_scope_context_invalid");
  }
  let site;
  try { site = new URL(cfg.wwwroot); } catch { return fail("moodle_question_bank_impact_scope_context_invalid"); }
  const basePath = site.pathname.replace(/\/$/, "");
  const bodyCourse = String(globalThis.document?.body?.className || "").match(/(?:^|\s)course-([1-9][0-9]*)(?:\s|$)/)?.[1] || "";
  const courseId = id(cfg.courseId) || bodyCourse;
  const principalId = id(cfg.userId);
  const currentPath = String(globalThis.location?.pathname || "");
  if (site.protocol !== "https:" || site.search || site.hash || site.username || site.password
    || site.origin !== globalThis.location?.origin || !(currentPath === basePath || currentPath.startsWith(`${basePath}/`))
    || !courseId || !principalId) return fail("moodle_question_bank_impact_scope_context_invalid");
  const operation = input.operation;
  const args = input.arguments;
  const binding = input.binding;
  if (!object(operation) || operation.key !== OPERATION || operation.toolName !== TOOL || operation.provider !== PROVIDER
    || operation.readOnly !== true || !object(args) || Object.keys(args).length !== 1 || id(args.course_id) !== courseId
    || !object(binding) || binding.origin !== site.origin || binding.siteUrl !== site.href
    || id(binding.principalId) !== principalId || id(binding.courseId) !== courseId
    || !Number.isSafeInteger(input.expiresAt) || input.expiresAt <= Date.now()) {
    return fail("moodle_question_bank_impact_scope_arguments_invalid");
  }
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
      return received.origin === expected.origin && received.pathname === expected.pathname && received.search === expected.search
        && !received.hash && !received.username && !received.password;
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
  const ajax = async (method, methodArgs) => {
    if (Date.now() >= input.expiresAt || !sameContext()) return { error: "moodle_question_bank_impact_scope_context_changed" };
    const endpoint = url("/lib/ajax/service.php", { sesskey: cfg.sesskey, info: method });
    let response;
    try {
      response = await fetch(endpoint, {
        method: "POST", credentials: "include", cache: "no-store", redirect: "error",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify([{ index: 0, methodname: method, args: methodArgs }]),
      });
    } catch { return { error: "moodle_question_bank_impact_scope_request_failed" }; }
    const raw = await boundedText(response, endpoint);
    if (raw === "limit" || typeof raw !== "string") return { error: "moodle_question_bank_impact_scope_response_unavailable" };
    try {
      const payload = JSON.parse(raw);
      if (!Array.isArray(payload) || payload.length !== 1 || !object(payload[0]) || payload[0].index !== 0
        || payload[0].error || payload[0].exception || !("data" in payload[0])) {
        return { error: "moodle_question_bank_impact_scope_response_invalid" };
      }
      const data = typeof payload[0].data === "string" ? JSON.parse(payload[0].data) : payload[0].data;
      return object(data) ? { data } : { error: "moodle_question_bank_impact_scope_response_invalid" };
    } catch { return { error: "moodle_question_bank_impact_scope_response_invalid" }; }
  };
  const quizPage = async (moduleId) => {
    if (Date.now() >= input.expiresAt || !sameContext()) return { error: "moodle_question_bank_impact_scope_context_changed" };
    const endpoint = url(QUIZ_EDIT_PATH, { cmid: moduleId });
    let response;
    try {
      response = await fetch(endpoint, {
        method: "GET", credentials: "include", cache: "no-store", redirect: "error", headers: { Accept: "text/html" },
      });
    } catch { return { error: "moodle_question_bank_impact_scope_request_failed" }; }
    const html = await boundedText(response, endpoint);
    if (html === "limit") return { truncated: true };
    if (typeof html !== "string" || typeof globalThis.DOMParser !== "function") {
      return { error: "moodle_question_bank_impact_scope_response_unavailable" };
    }
    try { return { document: new DOMParser().parseFromString(html, "text/html") }; }
    catch { return { error: "moodle_question_bank_impact_scope_response_invalid" }; }
  };
  const slotNodes = (documentValue) => {
    const roots = [...documentValue.querySelectorAll("ul.slots")];
    if (roots.length !== 1) return null;
    const sections = [...roots[0].children].filter((node) => node.matches?.('li.section.main[id^="section-"]'));
    if (!sections.length) return null;
    const lists = sections.map((section) => [...section.querySelectorAll("ul.section.img-text")]);
    if (lists.some((entry) => entry.length !== 1)) return null;
    return lists.flatMap((entry) => [...entry[0].querySelectorAll(':scope > li.slot[id^="slot-"]')]);
  };
  const directQuestionId = (node, moduleId) => {
    const found = [];
    for (const anchor of node.querySelectorAll("a[href]")) {
      let href;
      try { href = new URL(anchor.getAttribute("href"), url(QUIZ_EDIT_PATH, { cmid: moduleId })); } catch { continue; }
      if (href.origin !== site.origin || href.pathname !== `${basePath}${QUESTION_EDIT_PATH}`) continue;
      const candidate = id(href.searchParams.get("id"));
      if (href.searchParams.getAll("id").length !== 1 || !candidate || href.searchParams.get("cmid") !== moduleId) return null;
      found.push(candidate);
    }
    return found.length === 1 ? found[0] : null;
  };
  const slotVersion = (node, slotId) => {
    const selects = [...node.querySelectorAll(`select.version-selection[data-slot-id="${slotId}"]`)];
    if (selects.length !== 1) return null;
    const selected = [...selects[0].querySelectorAll("option[selected]")];
    if (selected.length !== 1) return null;
    const value = selected[0].getAttribute("value");
    if (value === "0") return { mode: "latest" };
    return id(value) ? { mode: "pinned", number: Number(id(value)) } : null;
  };
  const filterOptions = (key, value) => {
    if (value === undefined) return { ok: true };
    if (!object(value) || key !== "category") return { ok: false };
    const keys = Object.keys(value);
    if (keys.length !== 1 || keys[0] !== "includesubcategories" || typeof value.includesubcategories !== "boolean") return { ok: false };
    return { ok: true, include_subcategories: value.includesubcategories };
  };
  const parseFilterCondition = (raw) => {
    let condition;
    try { condition = JSON.parse(raw); } catch { return null; }
    if (!object(condition) || Object.keys(condition).some((key) => !FILTER_CONDITION_FIELDS.includes(key))) return null;
    if (!object(condition.filter)) return null;
    const entries = Object.entries(condition.filter);
    if (!entries.length || entries.length > MAX_FILTERS_PER_SLOT) return null;
    const jointype = Number.isSafeInteger(condition.jointype) ? condition.jointype : 2;
    if (!(jointype in JOINTYPE_NAMES)) return null;
    const filters = [];
    for (const [key, value] of entries) {
      if (!FILTER_KEY.test(key) || !object(value)) return null;
      if (Object.keys(value).some((field) => !["jointype", "values", "filteroptions"].includes(field))) return null;
      if (!Number.isSafeInteger(value.jointype) || !(value.jointype in JOINTYPE_NAMES)) return null;
      if (!Array.isArray(value.values) || value.values.length > MAX_FILTER_VALUES) return null;
      const values = value.values.map((entry) => (Number.isSafeInteger(entry) ? String(entry) : entry));
      if (values.some((entry) => typeof entry !== "string" || !FILTER_VALUE.test(entry))) return null;
      const options = filterOptions(key, value.filteroptions);
      if (!options.ok) return null;
      filters.push({
        key,
        jointype: value.jointype,
        jointype_name: JOINTYPE_NAMES[value.jointype],
        values,
        recognised: RECOGNISED_FILTER_KEYS.includes(key),
        ...(options.include_subcategories === undefined ? {} : { include_subcategories: options.include_subcategories }),
      });
    }
    filters.sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
    const contextId = condition.questionscontextid === undefined ? "" : id(condition.questionscontextid);
    if (condition.questionscontextid !== undefined && !contextId) return null;
    return { jointype, jointype_name: JOINTYPE_NAMES[jointype], filters, contextId };
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
  const reasons = [];
  let reasonsTruncated = false;
  const reason = (code, detail = {}) => {
    if (reasons.length >= MAX_REASONS) { reasonsTruncated = true; return; }
    reasons.push({ reason: code, ...detail });
  };

  const state = await ajax(STATE_METHOD, { courseid: Number(courseId) });
  if (!state.data || !object(state.data.course) || id(state.data.course.id) !== courseId || !Array.isArray(state.data.cm)) {
    return fail(state.error || "moodle_question_bank_impact_scope_course_unavailable");
  }
  const quizModules = [];
  for (const entry of state.data.cm) {
    if (!object(entry) || String(entry.module || "") !== "quiz") continue;
    const moduleId = id(entry.id);
    if (!moduleId) return fail("moodle_question_bank_impact_scope_response_invalid");
    quizModules.push({ moduleId, name: name(entry.name) });
  }
  quizModules.sort((left, right) => Number(left.moduleId) - Number(right.moduleId));
  if (quizModules.length > MAX_QUIZZES) reason("quiz_list_truncated");
  const selected = quizModules.slice(0, MAX_QUIZZES);

  const quizzes = [];
  let slotCount = 0;
  let directCount = 0;
  let randomCount = 0;
  for (const quiz of selected) {
    const page = await quizPage(quiz.moduleId);
    if (page.error) return fail(page.error);
    if (page.truncated) {
      reason("slot_list_truncated", { module_id: Number(quiz.moduleId) });
      quizzes.push({ module_id: Number(quiz.moduleId), ...(quiz.name ? { name: quiz.name } : {}), slot_count: 0, slots: [], slots_readable: false });
      continue;
    }
    const nodes = slotNodes(page.document);
    if (!nodes) return fail("moodle_question_bank_impact_scope_quiz_unavailable");
    if (nodes.length > MAX_SLOTS_PER_QUIZ) reason("slot_list_truncated", { module_id: Number(quiz.moduleId) });
    const slots = [];
    const seen = new Set();
    for (const node of nodes.slice(0, MAX_SLOTS_PER_QUIZ)) {
      const slotId = id(String(node.getAttribute("id") || "").slice("slot-".length));
      if (!slotId || seen.has(slotId)) return fail("moodle_question_bank_impact_scope_quiz_unavailable");
      seen.add(slotId);
      const position = slots.length + 1;
      const detail = { module_id: Number(quiz.moduleId), slot_id: Number(slotId) };
      if (node.classList.contains("random") || node.classList.contains("qtype_random")) {
        randomCount += 1;
        const carrier = [...node.querySelectorAll("[data-filtercondition]")];
        const holder = node.hasAttribute("data-filtercondition") ? node : carrier.length === 1 ? carrier[0] : null;
        if (!holder || (node.hasAttribute("data-filtercondition") && carrier.length > 0)) {
          reason("random_filter_condition_not_exposed", detail);
          slots.push({ slot_id: Number(slotId), position, reference: "random", resolved: false });
          continue;
        }
        const parsed = parseFilterCondition(String(holder.getAttribute("data-filtercondition") || ""));
        if (!parsed) {
          reason("random_filter_condition_malformed", detail);
          slots.push({ slot_id: Number(slotId), position, reference: "random", resolved: false });
          continue;
        }
        const attributeContext = id(String(holder.getAttribute("data-questionscontextid") || ""));
        if (attributeContext && parsed.contextId && attributeContext !== parsed.contextId) {
          reason("random_filter_condition_malformed", detail);
          slots.push({ slot_id: Number(slotId), position, reference: "random", resolved: false });
          continue;
        }
        const contextId = attributeContext || parsed.contextId;
        if (!contextId) reason("random_context_not_exposed", detail);
        if (parsed.jointype === 0) reason("filter_jointype_none", detail);
        for (const filter of parsed.filters) {
          if (filter.jointype === 0) reason("filter_jointype_none", { ...detail, filter_key: filter.key });
          if (!filter.recognised) reason("filter_class_unrecognised", { ...detail, filter_key: filter.key });
        }
        slots.push({
          slot_id: Number(slotId), position, reference: "random",
          resolved: Boolean(contextId),
          questions_context_id: contextId ? Number(contextId) : null,
          filter_source: "quiz_edit_slot_data",
          filter_jointype: parsed.jointype,
          filter_jointype_name: parsed.jointype_name,
          filters: parsed.filters,
        });
        continue;
      }
      directCount += 1;
      const questionId = directQuestionId(node, quiz.moduleId);
      const version = questionId ? slotVersion(node, slotId) : null;
      if (!questionId || !version) {
        reason("slot_reference_unresolved", detail);
        slots.push({ slot_id: Number(slotId), position, reference: "direct", resolved: false });
        continue;
      }
      slots.push({ slot_id: Number(slotId), position, reference: "direct", resolved: true, question_id: Number(questionId), version });
    }
    slotCount += slots.length;
    quizzes.push({
      module_id: Number(quiz.moduleId), ...(quiz.name ? { name: quiz.name } : {}),
      slot_count: slots.length, slots, slots_readable: true,
    });
  }
  if (!sameContext() || Date.now() > input.expiresAt) return fail("moodle_question_bank_impact_scope_context_changed");
  const data = {
    schema: SCHEMA,
    provider: PROVIDER,
    course_id: Number(courseId),
    status: reasons.length || reasonsTruncated ? "impact_scope_incomplete" : "complete",
    quiz_count: quizzes.length,
    slot_count: slotCount,
    direct_reference_count: directCount,
    random_reference_count: randomCount,
    quizzes,
    incomplete_reasons: reasons,
    incomplete_reasons_truncated: reasonsTruncated,
    proof: {
      method: STATE_METHOD,
      slot_source: "mod_quiz_edit_page",
      required_capability: "mod/quiz:manage",
      scope: "approved_course_only",
      cross_course_references: "not_enumerated",
      condition_class_resolution: "not_exposed",
      plugin_components: "not_exposed",
      recognised_filter_keys: RECOGNISED_FILTER_KEYS,
      quiz_limit: MAX_QUIZZES,
      slot_limit_per_quiz: MAX_SLOTS_PER_QUIZ,
      reason_limit: MAX_REASONS,
      question_bank_write_eligibility: "held",
    },
  };
  const snapshotDigest = await digest(data);
  if (!snapshotDigest) return fail("moodle_question_bank_impact_scope_digest_unavailable");
  return { ok: true, sent: false, complete: true, data, snapshot_digest: snapshotDigest };
}
