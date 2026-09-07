/**
 * Reads child records and aggregate response counts for one exact Moodle
 * Choice, Feedback, or Database activity.
 *
 * Every read binds the activity through the native course/modedit.php settings
 * form first, so the course module, its module type, and its instance are the
 * exact ones the request named. None of the routes below opens
 * /mod/choice/view.php, /mod/feedback/view.php, or /mod/data/view.php, so none
 * of them can record a view, a completion state, or a learner response.
 *
 * Routes, read from Moodle v5.2.2 source:
 * - Choice options come from the repeated `option[i]`, `limit[i]`, and
 *   `optionid[i]` controls of the native Choice settings form.
 *   https://github.com/moodle/moodle/blob/v5.2.2/public/mod/choice/mod_form.php#L55-L112
 * - Feedback items come from the native item export,
 *   /mod/feedback/export.php?id=<cmid>&action=exportfile, which requires
 *   mod/feedback:edititems and returns one XML document.
 *   https://github.com/moodle/moodle/blob/v5.2.2/public/mod/feedback/export.php#L56-L166
 * - Database fields come from /mod/data/field.php?id=<cmid>, which requires
 *   mod/data:managetemplates.
 *   https://github.com/moodle/moodle/blob/v5.2.2/public/mod/data/field.php#L91-L440
 * - Every response and entry count comes from the read-only activity overview
 *   service core_courseformat_get_overview_information, which lib/db/services.php
 *   registers with 'ajax' => true and 'type' => 'read'. Moodle logs an overview
 *   view through a separate write function that this read never calls.
 *   https://github.com/moodle/moodle/blob/v5.2.2/public/lib/db/services.php#L602-L614
 *
 * The overview items are capability-gated inside Moodle: mod_choice omits
 * `studentwhoresponded` without mod/choice:readresponses, mod_feedback omits
 * `responses` without mod/feedback:viewreports, and mod_data omits `actions`
 * without mod/data:approve. A read that cannot find its item returns
 * <prefix>_capability_missing and no count.
 *
 * Route limit: the activity overview service exists from Moodle 5.0. On an
 * older site the AJAX endpoint refuses the method and every summary read here
 * returns <prefix>_service_unavailable with no count.
 *
 * Every result is aggregate or course content. No route reads a response row,
 * and no result carries a learner name, a learner ID, or a response value.
 */
export async function executeMoodleActivityContentReadInPage(rawInput) {
  const PROVIDER = "moodle";
  const OVERVIEW_METHOD = "core_courseformat_get_overview_information";
  const MODULE_BINDING = "course_modedit_form";
  const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
  const MAX_OPTIONS = 100;
  const MAX_ITEMS = 200;
  const MAX_FIELDS = 100;
  const MAX_TEXT = 4000;
  const MAX_ACTIVITIES = 500;
  const DEFINITIONS = new Map([
    ["moodle.form.choice.options.read.v1", {
      tool: "moodle_get_choice_options", schema: "morrow.moodle-choice-options.v1", prefix: "moodle_choice_options",
      module: "choice", capability: "moodle/course:manageactivities", method: MODULE_BINDING,
    }],
    ["moodle.form.choice.response_summary.read.v1", {
      tool: "moodle_get_choice_response_summary", schema: "morrow.moodle-choice-response-summary.v1", prefix: "moodle_choice_response_summary",
      module: "choice", capability: "mod/choice:readresponses", method: `${MODULE_BINDING}+${OVERVIEW_METHOD}`,
    }],
    ["moodle.form.feedback.items.read.v1", {
      tool: "moodle_get_feedback_items", schema: "morrow.moodle-feedback-items.v1", prefix: "moodle_feedback_items",
      module: "feedback", capability: "mod/feedback:edititems", method: `${MODULE_BINDING}+mod_feedback_export_items`,
    }],
    ["moodle.form.feedback.response_summary.read.v1", {
      tool: "moodle_get_feedback_response_summary", schema: "morrow.moodle-feedback-response-summary.v1", prefix: "moodle_feedback_response_summary",
      module: "feedback", capability: "mod/feedback:viewreports", method: `${MODULE_BINDING}+${OVERVIEW_METHOD}`,
    }],
    ["moodle.form.data.fields.read.v1", {
      tool: "moodle_get_database_fields", schema: "morrow.moodle-database-fields.v1", prefix: "moodle_database_fields",
      module: "data", capability: "mod/data:managetemplates", method: `${MODULE_BINDING}+mod_data_field_index`,
    }],
    ["moodle.form.data.entry_summary.read.v1", {
      tool: "moodle_get_database_entry_summary", schema: "morrow.moodle-database-entry-summary.v1", prefix: "moodle_database_entry_summary",
      module: "data", capability: "mod/data:approve", method: `${MODULE_BINDING}+${OVERVIEW_METHOD}`,
    }],
  ]);
  const ID = /^[1-9][0-9]{0,18}$/;
  const COUNT = /^(?:0|[1-9][0-9]{0,6})$/;
  const FIELD_TYPE = /^[a-z][a-z0-9_]{0,50}$/;
  const object = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
  const id = (value) => Number.isSafeInteger(value) && value > 0 ? String(value)
    : typeof value === "string" && ID.test(value) ? value : "";
  const input = (() => { try { return typeof rawInput === "string" ? JSON.parse(rawInput) : rawInput; } catch { return null; } })();
  const definition = object(input) && object(input.operation) ? DEFINITIONS.get(input.operation.key) : undefined;
  if (!definition) return { ok: false, sent: false, error: "moodle_activity_content_read_operation_unsupported" };
  const fail = (reason) => ({ ok: false, sent: false, error: `${definition.prefix}_${reason}` });
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
  const operation = input.operation;
  const args = input.arguments;
  const binding = input.binding;
  if (operation.toolName !== definition.tool || operation.provider !== PROVIDER || operation.readOnly !== true
    || !object(args) || Object.keys(args).length !== 2 || id(args.course_id) !== courseId || !id(args.module_id)
    || !object(binding) || binding.origin !== site.origin || binding.siteUrl !== site.href
    || id(binding.principalId) !== principalId || id(binding.courseId) !== courseId
    || !Number.isSafeInteger(input.expiresAt) || input.expiresAt <= Date.now()) return fail("arguments_invalid");
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
  const documentFrom = async (endpoint, accept, type) => {
    if (Date.now() >= input.expiresAt || !sameContext()) return "context";
    let response;
    try {
      response = await fetch(endpoint, {
        method: "GET", credentials: "include", cache: "no-store", redirect: "error", headers: { Accept: accept },
      });
    } catch { return null; }
    const text = await boundedText(response, endpoint);
    if (text === "limit") return "limit";
    if (typeof text !== "string" || typeof globalThis.DOMParser !== "function") return null;
    try {
      const parsed = new DOMParser().parseFromString(text, type);
      return parsed.querySelector("parsererror") ? null : parsed;
    } catch { return null; }
  };
  const hidden = (form, name) => {
    const values = [...form.querySelectorAll(`input[type="hidden"][name="${name}"]`)];
    return values.length === 1 ? values[0].value : "";
  };
  const namedControl = (form, name) => {
    const nodes = [...form.querySelectorAll(`[name="${name}"]`)];
    return nodes.length === 1 ? nodes[0] : null;
  };
  const controlValue = (form, name) => {
    const node = namedControl(form, name);
    if (!node) return null;
    if (node.tagName === "SELECT") {
      const selected = [...node.options].filter((option) => option.selected);
      return selected.length === 1 ? selected[0].value : null;
    }
    return typeof node.value === "string" ? node.value : null;
  };
  const yesNoValue = (form, name) => {
    const value = controlValue(form, name);
    return value === "0" ? false : value === "1" ? true : null;
  };
  /**
   * Binds the exact course module through its own native settings form. The
   * form must name this course, this course module, and this module type, and
   * must carry exactly one instance ID.
   */
  const settingsForm = async () => {
    const endpoint = url("/course/modedit.php", { update: moduleId, return: "0" });
    const parsed = await documentFrom(endpoint, "text/html", "text/html");
    if (parsed === "limit" || parsed === "context" || !parsed) return parsed;
    const forms = [...parsed.querySelectorAll("form")].filter((form) => {
      if (String(form.getAttribute("method") || "").toLowerCase() !== "post") return false;
      const action = form.getAttribute("action") || endpoint.href;
      try {
        const actionUrl = new URL(action, endpoint);
        return actionUrl.origin === endpoint.origin && actionUrl.pathname === endpoint.pathname && !actionUrl.hash
          && !actionUrl.username && !actionUrl.password && (actionUrl.search === "" || actionUrl.search === endpoint.search)
          && hidden(form, "course") === courseId && hidden(form, "coursemodule") === moduleId && hidden(form, "update") === moduleId
          && hidden(form, "modulename") === definition.module && Boolean(id(hidden(form, "instance")));
      } catch { return false; }
    });
    return forms.length === 1 ? forms[0] : null;
  };
  const overview = async () => {
    if (Date.now() >= input.expiresAt || !sameContext()) return "context";
    const endpoint = url("/lib/ajax/service.php", { sesskey: cfg.sesskey, info: OVERVIEW_METHOD });
    let response;
    try {
      response = await fetch(endpoint, {
        method: "POST", credentials: "include", cache: "no-store", redirect: "error",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify([{
          index: 0, methodname: OVERVIEW_METHOD, args: { courseid: Number(courseId), modname: definition.module },
        }]),
      });
    } catch { return null; }
    const raw = await boundedText(response, endpoint);
    if (raw === "limit") return "limit";
    if (typeof raw !== "string") return null;
    let payload;
    try { payload = JSON.parse(raw); } catch { return null; }
    if (!Array.isArray(payload) || payload.length !== 1 || !object(payload[0]) || payload[0].index !== 0) return null;
    // A site older than Moodle 5.0 has no overview service, and lib/ajax/service.php
    // answers with an exception rather than data.
    if (payload[0].error || payload[0].exception || !("data" in payload[0])) return "unavailable";
    const data = typeof payload[0].data === "string" ? (() => { try { return JSON.parse(payload[0].data); } catch { return null; } })() : payload[0].data;
    if (!object(data) || !Array.isArray(data.activities)) return null;
    if (data.activities.length > MAX_ACTIVITIES) return "limit";
    return data;
  };
  /** Reads one capability-gated integer column of this exact activity's overview row. */
  const overviewItem = (table, key) => {
    const rows = table.activities.filter((activity) => object(activity) && activity.modname === definition.module
      && Number.isSafeInteger(activity.cmid) && String(activity.cmid) === moduleId);
    if (rows.length !== 1 || !Array.isArray(rows[0].items)) return "invalid";
    const items = rows[0].items.filter((item) => object(item) && item.key === key);
    if (items.length !== 1) return items.length === 0 ? "missing" : "invalid";
    return items[0];
  };
  const overviewCount = (table, key) => {
    const item = overviewItem(table, key);
    if (typeof item === "string") return item;
    if (typeof item.contentjson !== "string" || item.contentjson.length > MAX_TEXT) return "invalid";
    let content;
    try { content = JSON.parse(item.contentjson); } catch { return "invalid"; }
    return object(content) && content.datatype === "integer" && Number.isSafeInteger(content.value)
      && content.value >= 0 && content.value <= 1_000_000 ? content.value : "invalid";
  };
  /** The overview alert count is declared as text, so Moodle may send it either way. */
  const overviewAlertCount = (table, key) => {
    const item = overviewItem(table, key);
    if (typeof item === "string") return item;
    const alert = item.alertcount;
    if (Number.isSafeInteger(alert) && alert >= 0 && alert <= 1_000_000) return alert;
    return typeof alert === "string" && COUNT.test(alert) ? Number(alert) : "invalid";
  };
  const boundedString = (value, limit) => typeof value === "string" && value.length <= limit ? value : null;
  const choiceOptions = (form) => {
    // A Choice with more option rows than the bound returns no list at all.
    if (namedControl(form, `option[${MAX_OPTIONS}]`)) return "limit";
    const rows = [];
    for (let index = 0; index < MAX_OPTIONS; index += 1) {
      const text = controlValue(form, `option[${index}]`);
      if (!text) continue;
      const rawLimit = controlValue(form, `limit[${index}]`);
      const optionId = id(hidden(form, `optionid[${index}]`));
      if (typeof rawLimit !== "string" || !COUNT.test(rawLimit) || !optionId || text.length > MAX_TEXT) return null;
      rows.push({ option_id: Number(optionId), position: rows.length + 1, text, response_limit: Number(rawLimit) });
    }
    return rows;
  };
  const feedbackItems = (parsed) => {
    const roots = [...parsed.querySelectorAll("FEEDBACK > ITEMS")];
    if (roots.length !== 1) return null;
    const nodes = [...roots[0].querySelectorAll("ITEM")];
    if (nodes.length > MAX_ITEMS) return "limit";
    const rows = [];
    const seen = new Set();
    for (const node of nodes) {
      // Moodle writes every exported value inside a padded CDATA section, so the
      // element text carries its own indentation.
      const child = (name) => {
        const matches = [...node.querySelectorAll(name)];
        return matches.length === 1 ? String(matches[0].textContent ?? "").trim() : null;
      };
      const itemId = id(child("ITEMID") || "");
      const type = boundedString(node.getAttribute("TYPE"), 40);
      const required = node.getAttribute("REQUIRED");
      const text = boundedString(child("ITEMTEXT"), MAX_TEXT);
      const label = boundedString(child("ITEMLABEL"), MAX_TEXT);
      const presentation = boundedString(child("PRESENTATION"), MAX_TEXT);
      const dependItem = child("DEPENDITEM");
      const dependValue = boundedString(child("DEPENDVALUE"), MAX_TEXT);
      if (!itemId || seen.has(itemId) || !type || !FIELD_TYPE.test(type) || (required !== "0" && required !== "1")
        || text === null || label === null || presentation === null || dependValue === null
        || typeof dependItem !== "string" || !COUNT.test(dependItem)) return null;
      seen.add(itemId);
      rows.push({
        item_id: Number(itemId),
        position: rows.length + 1,
        type,
        required: required === "1",
        text,
        label,
        presentation,
        depends_on_item_id: dependItem === "0" ? null : Number(dependItem),
        depends_on_value: dependValue,
      });
    }
    return rows;
  };
  const databaseFields = (parsed, databaseId) => {
    const bodyClass = String(parsed.body?.className || "");
    const bound = [`course-${courseId}`, `cmid-${moduleId}`, "cm-type-data"]
      .every((entry) => new RegExp(`(?:^|\\s)${entry}(?:\\s|$)`).test(bodyClass));
    if (!bound) return "unbound";
    const forms = [...parsed.querySelectorAll("form#sortdefault")]
      .filter((form) => hidden(form, "d") === databaseId);
    // Moodle answers a Database with no fields with its own zero state, which
    // carries no field list and no default-sort control.
    if (!forms.length) return { fields: [], defaultSort: null };
    if (forms.length !== 1) return null;
    const selects = [...forms[0].querySelectorAll('select[name="defaultsort"]')];
    if (selects.length !== 1) return null;
    // The field type is language-independent only in the field icon, which
    // Moodle renders inside that field's own edit link.
    const icons = [...parsed.querySelectorAll("a[href] img[alt]")].map((icon) => {
      try {
        const target = new URL(icon.closest("a[href]").getAttribute("href"), site.href);
        return target.origin === site.origin && target.pathname === `${basePath}/mod/data/field.php`
          && target.searchParams.get("d") === databaseId && target.searchParams.get("mode") === "display"
          ? { fieldId: target.searchParams.get("fid"), type: icon.getAttribute("alt") }
          : null;
      } catch { return null; }
    }).filter(Boolean);
    const rows = [];
    const seen = new Set();
    for (const option of [...selects[0].querySelectorAll("optgroup > option")]) {
      const fieldId = id(option.getAttribute("value") || "");
      if (!fieldId) continue;
      if (seen.has(fieldId)) return null;
      seen.add(fieldId);
      const name = boundedString(option.textContent, MAX_TEXT);
      const types = [...new Set(icons.filter((icon) => icon.fieldId === fieldId).map((icon) => icon.type))];
      if (!name || types.length !== 1 || !FIELD_TYPE.test(types[0])) return null;
      rows.push({ field_id: Number(fieldId), name, type: types[0] });
      if (rows.length > MAX_FIELDS) return "limit";
    }
    const selected = [...selects[0].options].filter((option) => option.selected);
    const defaultSort = selected.length === 1 ? id(selected[0].value) : "";
    return { fields: rows, defaultSort: defaultSort ? Number(defaultSort) : null };
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

  const form = await settingsForm();
  if (form === "limit") return incomplete();
  if (form === "context") return fail("context_changed");
  if (!form) return fail("target_unavailable");
  const instanceId = id(hidden(form, "instance"));
  const base = {
    schema: definition.schema,
    provider: PROVIDER,
    course_id: Number(courseId),
    module_id: Number(moduleId),
  };
  const proof = (extra) => ({
    method: definition.method,
    complete: true,
    exact_module_binding: MODULE_BINDING,
    required_capability: definition.capability,
    ...extra,
  });
  let data;
  if (definition.tool === "moodle_get_choice_options") {
    const options = choiceOptions(form);
    const limitAnswers = yesNoValue(form, "limitanswers");
    const allowMultiple = yesNoValue(form, "allowmultiple");
    if (options === "limit") return incomplete();
    if (!options || limitAnswers === null || allowMultiple === null) return fail("response_invalid");
    data = {
      ...base,
      choice_id: Number(instanceId),
      option_count: options.length,
      options,
      limit_answers: limitAnswers,
      allow_multiple: allowMultiple,
      // Moodle freezes the answer-count controls once choice_answers rows exist.
      has_responses: Boolean(namedControl(form, "allowmultiple")?.disabled),
      proof: proof({ option_limit: MAX_OPTIONS, option_rows: options.length, text_limit: MAX_TEXT }),
    };
  } else if (definition.tool === "moodle_get_feedback_items") {
    const anonymous = controlValue(form, "anonymous");
    if (anonymous !== "1" && anonymous !== "2") return fail("response_invalid");
    const endpoint = url("/mod/feedback/export.php", { id: moduleId, action: "exportfile" });
    const parsed = await documentFrom(endpoint, "application/xml", "application/xml");
    if (parsed === "limit") return incomplete();
    if (parsed === "context") return fail("context_changed");
    // Moodle's item export refuses to build a file for a Feedback that has no
    // items, so an absent document is not proof of an empty item list.
    if (!parsed) return fail("unavailable");
    const items = feedbackItems(parsed);
    if (items === "limit") return incomplete();
    if (!items) return fail("response_invalid");
    data = {
      ...base,
      feedback_id: Number(instanceId),
      anonymous: anonymous === "1",
      item_count: items.length,
      items,
      proof: proof({ item_limit: MAX_ITEMS, item_rows: items.length, text_limit: MAX_TEXT }),
    };
  } else if (definition.tool === "moodle_get_database_fields") {
    const endpoint = url("/mod/data/field.php", { id: moduleId });
    const parsed = await documentFrom(endpoint, "text/html", "text/html");
    if (parsed === "limit") return incomplete();
    if (parsed === "context") return fail("context_changed");
    if (!parsed) return fail("unavailable");
    const listing = databaseFields(parsed, instanceId);
    if (listing === "limit") return incomplete();
    if (listing === "unbound") return fail("target_unavailable");
    if (!listing) return fail("response_invalid");
    data = {
      ...base,
      database_id: Number(instanceId),
      field_count: listing.fields.length,
      default_sort_field_id: listing.defaultSort,
      fields: listing.fields,
      proof: proof({ field_limit: MAX_FIELDS, field_rows: listing.fields.length, text_limit: MAX_TEXT }),
    };
  } else {
    const anonymous = definition.tool === "moodle_get_feedback_response_summary" ? controlValue(form, "anonymous") : null;
    if (definition.tool === "moodle_get_feedback_response_summary" && anonymous !== "1" && anonymous !== "2") return fail("response_invalid");
    const approval = definition.tool === "moodle_get_database_entry_summary" ? yesNoValue(form, "approval") : null;
    if (definition.tool === "moodle_get_database_entry_summary" && approval === null) return fail("response_invalid");
    const allowMultiple = definition.tool === "moodle_get_choice_response_summary" ? yesNoValue(form, "allowmultiple") : null;
    if (definition.tool === "moodle_get_choice_response_summary" && allowMultiple === null) return fail("response_invalid");
    const table = await overview();
    if (table === "limit") return incomplete();
    if (table === "context") return fail("context_changed");
    if (table === "unavailable") return fail("service_unavailable");
    if (!table) return fail("response_invalid");
    const activityRows = table.activities.length;
    if (definition.tool === "moodle_get_choice_response_summary") {
      const responded = overviewCount(table, "studentwhoresponded");
      if (responded === "missing") return fail("capability_missing");
      if (typeof responded !== "number") return fail("response_invalid");
      data = {
        ...base,
        choice_id: Number(instanceId),
        responded_participant_count: responded,
        allow_multiple: allowMultiple,
        proof: proof({ activity_limit: MAX_ACTIVITIES, activity_rows: activityRows, overview_item_key: "studentwhoresponded" }),
      };
    } else if (definition.tool === "moodle_get_feedback_response_summary") {
      const responses = overviewCount(table, "responses");
      if (responses === "missing") return fail("capability_missing");
      if (typeof responses !== "number") return fail("response_invalid");
      data = {
        ...base,
        feedback_id: Number(instanceId),
        anonymous: anonymous === "1",
        response_count: responses,
        // This read has no per-learner projection. An anonymous Feedback also
        // refuses one at the runtime boundary, so a later route cannot add it.
        per_learner_projection: anonymous === "1" ? "refused_anonymous" : "not_supported",
        proof: proof({ activity_limit: MAX_ACTIVITIES, activity_rows: activityRows, overview_item_key: "responses" }),
      };
    } else {
      // The mod_data actions column exists only with mod/data:approve, which is
      // also what makes the entry count cover unapproved entries.
      const awaiting = overviewAlertCount(table, "actions");
      if (awaiting === "missing") return fail("capability_missing");
      const entries = overviewCount(table, "totalentries");
      const comments = overviewCount(table, "comments");
      if (typeof awaiting !== "number" || typeof entries !== "number" || typeof comments !== "number"
        || awaiting > entries) return fail("response_invalid");
      data = {
        ...base,
        database_id: Number(instanceId),
        entry_count: entries,
        entries_awaiting_approval: awaiting,
        comment_count: comments,
        approval_required: approval,
        proof: proof({ activity_limit: MAX_ACTIVITIES, activity_rows: activityRows, overview_item_key: "totalentries" }),
      };
    }
  }
  if (!sameContext() || Date.now() > input.expiresAt) return fail("context_changed");
  const snapshotDigest = await digest(data);
  if (!snapshotDigest) return fail("digest_unavailable");
  return { ok: true, sent: false, complete: true, data, snapshot_digest: snapshotDigest };
}
