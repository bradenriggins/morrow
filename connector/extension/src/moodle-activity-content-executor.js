/**
 * Writes one exact child record of one exact Moodle Choice, Feedback, or
 * Database activity: one Choice option, one Feedback question item, or one
 * Database field.
 *
 * Every write binds the activity through the native course/modedit.php
 * settings form first, reads the complete child list through the same native
 * route `moodle_get_choice_options`, `moodle_get_feedback_items`, and
 * `moodle_get_database_fields` read, binds the exact record and its position
 * inside that list, refuses while the activity holds responses or entries the
 * change would invalidate, sends exactly one POST, and then reads the complete
 * child list back. None of these routes opens /mod/choice/view.php,
 * /mod/feedback/view.php, or /mod/data/view.php.
 *
 * Routes, read from Moodle v5.2.2 source:
 * - A Choice option is a row of the repeated `option[i]`, `limit[i]`, and
 *   `optionid[i]` controls of the native Choice settings form. Moodle freezes
 *   `allowmultiple` once choice_answers rows exist, so a form whose
 *   `allowmultiple` control is no longer writable is Moodle's own statement
 *   that the Choice has responses.
 *   https://github.com/moodle/moodle/blob/v5.2.2/public/mod/choice/mod_form.php#L55-L112
 *   The write sends `submitbutton2`, the native save-and-return control, so
 *   Moodle's redirect names course/view.php and never /mod/choice/view.php.
 *   https://github.com/moodle/moodle/blob/v5.2.2/public/course/modedit.php#L195-L212
 * - A Feedback item is created and edited through /mod/feedback/edit_item.php,
 *   which requires mod/feedback:edititems. Its `position` select offers one
 *   entry per possible position, so the number of options states how many
 *   items the Feedback holds.
 *   https://github.com/moodle/moodle/blob/v5.2.2/public/mod/feedback/edit_item.php#L28-L82
 *   Moodle replaces the writable `multiple_submit` control with a disabled
 *   `multiple_submit_static` control once the Feedback has completed
 *   responses, so that frozen control is Moodle's own statement that responses
 *   exist.
 *   https://github.com/moodle/moodle/blob/v5.2.2/public/mod/feedback/mod_form.php#L61-L99
 * - A Database field is created and edited through /mod/data/field.php, which
 *   requires mod/data:managetemplates. `mode=add` and `mode=update` save the
 *   `form#editfield` the same page renders.
 *   https://github.com/moodle/moodle/blob/v5.2.2/public/mod/data/field.php#L113-L186
 *   A Database field write changes the shape every saved entry is stored
 *   against, and Moodle has no control that states whether entries exist, so
 *   the count comes from the read-only activity overview service. Moodle
 *   counts unapproved entries in it only for a person who holds
 *   mod/data:approve, which is also the person its `actions` item is built
 *   for, so a write proceeds only when that item is present and the count is
 *   zero.
 *   https://github.com/moodle/moodle/blob/v5.2.2/public/mod/data/classes/courseformat/overview.php#L92-L203
 *
 * No result carries a session key, a draft item ID, a learner, or a response.
 *
 * Chrome serializes this function for a MAIN-world injection. Keep every
 * dependency inside the function body.
 */
export async function executeMoodleActivityContentInPage(rawInput) {
  const PROVIDER = "moodle";
  const MODULE_BINDING = "course_modedit_form";
  const OVERVIEW_METHOD = "core_courseformat_get_overview_information";
  const MODEDIT_PATH = "/course/modedit.php";
  const FEEDBACK_EXPORT_PATH = "/mod/feedback/export.php";
  const FEEDBACK_ITEM_PATH = "/mod/feedback/edit_item.php";
  const DATA_FIELD_PATH = "/mod/data/field.php";
  const AJAX_PATH = "/lib/ajax/service.php";
  const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
  const MAX_FORM_ENTRIES = 600;
  const MAX_FORM_BYTES = 256 * 1024;
  const MAX_VALUE_BYTES = 64 * 1024;
  const MAX_OPTIONS = 100;
  const MAX_ITEMS = 200;
  const MAX_FIELDS = 100;
  const MAX_ACTIVITIES = 500;
  const MAX_TEXT = 4000;
  const MAX_ITEM_TEXT = 1333;
  const MAX_LABEL = 255;
  const MAX_FIELD_NAME = 255;
  const RESPONSE_LIMIT = 1_000_000;
  const ID = /^[1-9][0-9]{0,18}$/;
  const COUNT = /^(?:0|[1-9][0-9]{0,6})$/;
  const FIELD_TYPE = /^[a-z][a-z0-9_]{0,50}$/;
  const CONTROL = /[\u0000-\u001f\u007f]/;
  const TRANSIENT_FIELD = /(?:sesskey|statekey|_qf__|csrf|token|secret|password|authorization|cookie|(?:^|[[_-])(?:draft|itemid)(?:$|[\]_-]))/i;
  // A Moodle file reference only resolves inside a saved file area, and no
  // route here sends a file.
  const FILE_REFERENCE = /@@PLUGINFILE@@|pluginfile\.php|draftfile\.php/i;
  // Every Feedback item type whose native form saves from the common controls
  // alone. Each one keeps its own presentation controls at the values the
  // loaded form already carries.
  const FEEDBACK_ITEM_TYPES = Object.freeze(["numeric", "textarea", "textfield"]);
  // Every Database field type whose native form saves from the common controls
  // alone, with no option list a learner entry could be measured against.
  const DATABASE_FIELD_TYPES = Object.freeze(["number", "text", "textarea"]);
  const DEFINITIONS = Object.freeze({
    "moodle.form.choice.option.write.v1": {
      toolName: "moodle_update_choice_option", module: "choice", kind: "choice-option",
      prefix: "moodle_choice_option", schema: "morrow.moodle-choice-option-write.v1",
      capability: "moodle/course:manageactivities", method: MODULE_BINDING,
    },
    "moodle.form.feedback.item.create.write.v1": {
      toolName: "moodle_create_feedback_item", module: "feedback", kind: "feedback-item", create: true,
      prefix: "moodle_feedback_item", schema: "morrow.moodle-feedback-item-write.v1",
      capability: "mod/feedback:edititems", method: `${MODULE_BINDING}+mod_feedback_edit_item`,
    },
    "moodle.form.feedback.item.write.v1": {
      toolName: "moodle_update_feedback_item", module: "feedback", kind: "feedback-item", create: false,
      prefix: "moodle_feedback_item", schema: "morrow.moodle-feedback-item-write.v1",
      capability: "mod/feedback:edititems", method: `${MODULE_BINDING}+mod_feedback_edit_item`,
    },
    "moodle.form.data.field.create.write.v1": {
      toolName: "moodle_create_database_field", module: "data", kind: "database-field", create: true,
      prefix: "moodle_database_field", schema: "morrow.moodle-database-field-write.v1",
      capability: "mod/data:managetemplates", method: `${MODULE_BINDING}+mod_data_field_index`,
    },
    "moodle.form.data.field.write.v1": {
      toolName: "moodle_update_database_field", module: "data", kind: "database-field", create: false,
      prefix: "moodle_database_field", schema: "morrow.moodle-database-field-write.v1",
      capability: "mod/data:managetemplates", method: `${MODULE_BINDING}+mod_data_field_index`,
    },
  });

  const object = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
  const input = (() => {
    if (typeof rawInput !== "string") return rawInput;
    try { return JSON.parse(rawInput); } catch { return null; }
  })();
  const definition = object(input) && object(input.operation) && typeof input.operation.key === "string"
    ? DEFINITIONS[input.operation.key]
    : undefined;
  if (!definition) return { ok: false, sent: false, error: "moodle_activity_content_operation_unsupported" };
  const prefix = definition.prefix;
  const failure = (reason, status) => ({ ok: false, sent: false, ...(Number.isInteger(status) ? { status } : {}), error: `${prefix}_${reason}` });
  const incomplete = () => ({ ok: false, sent: false, complete: false, error: `${prefix}_incomplete` });
  const unconfirmed = (reason, status) => ({
    ok: false,
    sent: true,
    ...(Number.isInteger(status) ? { status } : {}),
    outcomeUnknown: true,
    verification: { schema: "morrow.browser-verification.v1", status: "unconfirmed", reason: `${prefix}_${reason}` },
    error: `${prefix}_${reason}`,
  });
  const mismatch = (status) => ({
    ok: false,
    sent: true,
    ...(Number.isInteger(status) ? { status } : {}),
    verification: { schema: "morrow.browser-verification.v1", status: "mismatch", reason: `${prefix}_readback_mismatch` },
    error: `${prefix}_write_not_verified`,
  });
  const id = (value) => {
    const text = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : typeof value === "string" ? value : "";
    return ID.test(text) ? text : "";
  };
  const plainText = (value, maximum) => typeof value === "string" && value.length > 0 && value.length <= maximum
    && value === value.trim() && !CONTROL.test(value) && !FILE_REFERENCE.test(value);
  // Moodle rewrites some of these values as it saves them, and a rewritten
  // value could not be compared against the approved one. A Choice option is
  // PARAM_CLEANHTML and a Feedback label is PARAM_NOTAGS, so both refuse
  // markup. A Feedback question is exported inside a CDATA section, so it
  // refuses the one sequence that would end that section.
  const savedAsSent = (value, forbidMarkup) => !/\]\]>/.test(value) && (!forbidMarkup || !/[<>]/.test(value));
  const boundedString = (value, limit) => (typeof value === "string" && value.length <= limit ? value : null);
  const count = (value, maximum) => Number.isSafeInteger(value) && value >= 0 && value <= maximum;
  const stable = (value) => {
    if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
    if (object(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
    return JSON.stringify(value === undefined ? null : value);
  };
  const digest = async (value) => {
    if (!globalThis.crypto?.subtle || typeof globalThis.TextEncoder !== "function") throw new Error(`${prefix}_digest_unavailable`);
    const bytes = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(stable(value)));
    return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
  };
  const currentContext = () => {
    const cfg = globalThis.M?.cfg;
    if (!object(cfg) || typeof cfg.wwwroot !== "string" || typeof cfg.sesskey !== "string" || !cfg.sesskey || cfg.sesskey.length > 1024) return null;
    const principalId = id(cfg.userId);
    if (!principalId) return null;
    let site;
    try { site = new URL(cfg.wwwroot); } catch { return null; }
    if (site.protocol !== "https:" || site.search || site.hash || site.username || site.password) return null;
    const basePath = site.pathname.replace(/\/$/, "");
    const currentPath = String(globalThis.location?.pathname || "");
    if (site.origin !== String(globalThis.location?.origin || "") || !(currentPath === basePath || currentPath.startsWith(`${basePath}/`))) return null;
    const configuredCourse = id(cfg.courseId);
    const bodyCourse = String(globalThis.document?.body?.className || "").match(/(?:^|\s)course-([1-9][0-9]*)(?:\s|$)/)?.[1] || "";
    if (configuredCourse && bodyCourse && bodyCourse !== configuredCourse) return null;
    const anchorCourseId = configuredCourse || bodyCourse;
    return anchorCourseId ? { origin: site.origin, siteUrl: site.href, basePath, principalId, anchorCourseId, sesskey: cfg.sesskey } : null;
  };
  const sameContext = (left, right) => left?.origin === right?.origin && left?.siteUrl === right?.siteUrl
    && left?.basePath === right?.basePath && left?.principalId === right?.principalId
    && left?.anchorCourseId === right?.anchorCourseId && left?.sesskey === right?.sesskey;
  const urlFor = (context, path, params) => {
    const url = new URL(context.siteUrl);
    url.pathname = `${context.basePath}${path}`;
    url.search = new URLSearchParams(params).toString();
    url.hash = "";
    return url;
  };
  const sameRoute = (actual, expected) => {
    let received;
    try { received = new URL(actual); } catch { return false; }
    return received.origin === expected.origin && received.pathname === expected.pathname
      && received.search === expected.search && !received.hash && !received.username && !received.password;
  };
  const boundedText = async (response, endpoint, context) => {
    const declared = response?.headers?.get?.("content-length");
    if (declared !== null && (!/^(?:0|[1-9][0-9]*)$/.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) return "limit";
    if (!response?.ok || !sameRoute(response.url, endpoint) || !sameContext(context, currentContext()) || !response.body
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
  const readDocument = async (context, endpoint, accept, type) => {
    if (Date.now() >= input.expiresAt || !sameContext(context, currentContext())) return { error: "context_changed" };
    let response;
    try {
      response = await fetch(endpoint, {
        method: "GET", credentials: "include", cache: "no-store", redirect: "error", headers: { Accept: accept },
      });
    } catch { return { error: "read_unavailable" }; }
    const text = await boundedText(response, endpoint, context);
    if (text === "limit") return { limited: true, status: response.status };
    if (typeof text !== "string" || typeof globalThis.DOMParser !== "function") return { error: "read_unavailable", status: response.status };
    try {
      const parsed = new DOMParser().parseFromString(text, type);
      return parsed.querySelector("parsererror")
        ? { error: "read_unavailable", status: response.status }
        : { status: response.status, document: parsed };
    } catch { return { error: "read_unavailable", status: response.status }; }
  };
  const entriesFor = (form) => {
    let values;
    try { values = [...new FormData(form).entries()]; } catch { return null; }
    if (values.length > MAX_FORM_ENTRIES) return null;
    let size = 0;
    const entries = [];
    for (const [name, value] of values) {
      if (typeof name !== "string" || name.length < 1 || name.length > 255) return null;
      if (typeof globalThis.File !== "undefined" && value instanceof globalThis.File) return null;
      if (typeof value !== "string" || value.length > MAX_VALUE_BYTES) return null;
      size += name.length + value.length;
      if (size > MAX_FORM_BYTES) return null;
      entries.push([name, value]);
    }
    return entries;
  };
  const valuesOf = (entries, name) => entries.filter(([entryName]) => entryName === name).map(([, value]) => value);
  const one = (entries, name) => {
    const values = valuesOf(entries, name);
    return values.length === 1 ? values[0] : null;
  };
  const namedControls = (form, name) => [...form.querySelectorAll("[name]")].filter((control) => control.getAttribute("name") === name);
  /**
   * A native control Moodle has frozen renders as its selected label plus a
   * hidden field, or as nothing at all when it is hard frozen, so a writable
   * select is the single enabled select the form still shows.
   * https://github.com/moodle/moodle/blob/v5.2.2/public/lib/form/templates/element-select.mustache#L119-L131
   */
  const writableSelect = (form, name) => {
    const controls = namedControls(form, name);
    const selects = controls.filter((control) => control.tagName === "SELECT");
    return controls.length === 1 && selects.length === 1 && !selects[0].disabled && !selects[0].multiple ? selects[0] : null;
  };
  const writableTextControl = (form, name) => {
    const controls = namedControls(form, name);
    const editable = controls.filter((control) => (control.tagName === "INPUT"
      && ["", "text", "number"].includes(String(control.getAttribute("type") || "").toLowerCase())) || control.tagName === "TEXTAREA");
    return controls.length === 1 && editable.length === 1 && !editable[0].disabled && !editable[0].readOnly ? editable[0] : null;
  };
  const selectedValue = (select) => {
    const selected = [...select.options].filter((option) => option.selected);
    return selected.length === 1 ? selected[0].value : null;
  };
  /**
   * The protected set of one loaded native form: every successful control the
   * one reviewed change does not name, with the session key, the draft item
   * IDs, and the optional date components Moodle re-renders on each load
   * removed, so the same form loaded twice digests the same way.
   */
  const protectedEntries = (form, entries, changed) => {
    const ignored = new Set();
    const forced = [];
    for (const control of form.querySelectorAll('input[type="checkbox"][name$="[enabled]"]')) {
      const name = String(control.getAttribute("name") || "");
      if (!name || control.checked) continue;
      const group = name.slice(0, -"[enabled]".length);
      for (const [entryName] of entries) if (entryName === name || entryName.startsWith(`${group}[`)) ignored.add(entryName);
      forced.push([name, "0"]);
    }
    const kept = entries
      .filter(([name]) => !changed.has(name) && !ignored.has(name) && !TRANSIENT_FIELD.test(name))
      .concat(forced.filter(([name]) => !changed.has(name)));
    return kept.map(([name, value]) => ({ name, value })).sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : left.value < right.value ? -1 : left.value > right.value ? 1 : 0));
  };
  /**
   * Sends the loaded form once. `changes` maps a native control name to the
   * value this one reviewed change sends, or to null when the change removes
   * the control, which is how a native checkbox with no value attribute is
   * cleared. Every other successful control is carried through unchanged.
   */
  const postForm = async (context, action, entries, changes, submit) => {
    if (!sameContext(context, currentContext()) || Date.now() >= input.expiresAt) return { error: "context_changed" };
    const body = new URLSearchParams();
    const carried = new Set();
    for (const [name, value] of entries) {
      if (changes.has(name)) {
        carried.add(name);
        const replacement = changes.get(name);
        if (replacement !== null) body.append(name, replacement);
        continue;
      }
      body.append(name, value);
    }
    for (const [name, value] of changes) if (!carried.has(name) && value !== null) body.append(name, value);
    if (submit) body.append(submit.name, submit.value);
    let response;
    try {
      writeAttempted = true;
      response = await fetch(action, {
        method: "POST", credentials: "include", cache: "no-store", redirect: "manual",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "text/html" }, body,
      });
    } catch { return { sent: true, unconfirmed: "write_unconfirmed" }; }
    if (!sameContext(context, currentContext())) return { sent: true, unconfirmed: "write_unconfirmed", status: response.status };
    return { sent: true, response };
  };
  /**
   * Moodle answers a saved native form with a redirect. Chromium reports a
   * manual same-origin POST redirect as opaqueredirect and does not follow it,
   * so the fixed native endpoint and the readback are the confirmation. The
   * redirect Moodle names is checked when the browser exposes it, so a save
   * that would send the person to an activity view page is reported as
   * unconfirmed rather than treated as done.
   */
  const redirectedTo = (response, action, context, expectedPath) => {
    if (response.type === "opaqueredirect") return { status: undefined };
    if (![301, 302, 303, 307, 308].includes(response.status)) return { error: "write_unconfirmed", status: response.status };
    let redirect;
    try { redirect = new URL(response.headers.get("location") || "", action); } catch { return { error: "write_unconfirmed", status: response.status }; }
    return redirect.origin === context.origin && redirect.pathname === `${context.basePath}${expectedPath}`
      ? { status: response.status }
      : { error: "write_unconfirmed", status: response.status };
  };

  /** Binds the exact course module through its own native settings form. */
  const bindModule = async (context, courseId, moduleId) => {
    const endpoint = urlFor(context, MODEDIT_PATH, { update: moduleId, return: "0" });
    const page = await readDocument(context, endpoint, "text/html", "text/html");
    if (page.limited) return { limited: true, status: page.status };
    if (page.error) return { error: page.error, status: page.status };
    const forms = [...page.document.querySelectorAll("form")].filter((form) => {
      if (String(form.getAttribute("method") || "").toLowerCase() !== "post") return false;
      try {
        const action = new URL(form.getAttribute("action") || endpoint.href, endpoint);
        return action.origin === endpoint.origin && action.pathname === endpoint.pathname && !action.hash
          && !action.username && !action.password && (action.search === "" || action.search === endpoint.search);
      } catch { return false; }
    });
    if (forms.length !== 1) return { error: "target_unavailable", status: page.status };
    const form = forms[0];
    const entries = entriesFor(form);
    if (!entries) return { error: "target_unavailable", status: page.status };
    const instanceId = id(one(entries, "instance"));
    if (one(entries, "course") !== courseId || one(entries, "coursemodule") !== moduleId
      || one(entries, "update") !== moduleId || one(entries, "modulename") !== definition.module || !instanceId) {
      return { error: "target_unavailable", status: page.status };
    }
    if (one(entries, "sesskey") !== context.sesskey) return { error: "session_mismatch", status: page.status };
    return {
      status: page.status,
      form,
      entries,
      instanceId,
      action: new URL(form.getAttribute("action") || endpoint.href, endpoint).href,
    };
  };
  const overview = async (context, courseId) => {
    if (Date.now() >= input.expiresAt || !sameContext(context, currentContext())) return { error: "context_changed" };
    const endpoint = urlFor(context, AJAX_PATH, { sesskey: context.sesskey, info: OVERVIEW_METHOD });
    let response;
    try {
      response = await fetch(endpoint, {
        method: "POST", credentials: "include", cache: "no-store", redirect: "error",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify([{ index: 0, methodname: OVERVIEW_METHOD, args: { courseid: Number(courseId), modname: definition.module } }]),
      });
    } catch { return { error: "entry_count_unavailable" }; }
    const raw = await boundedText(response, endpoint, context);
    if (raw === "limit") return { limited: true, status: response.status };
    if (typeof raw !== "string") return { error: "entry_count_unavailable", status: response.status };
    let payload;
    try { payload = JSON.parse(raw); } catch { return { error: "entry_count_unavailable", status: response.status }; }
    if (!Array.isArray(payload) || payload.length !== 1 || !object(payload[0]) || payload[0].index !== 0) {
      return { error: "entry_count_unavailable", status: response.status };
    }
    // A site older than Moodle 5.0 has no overview service, so no route here
    // can prove the Database is empty and every field write refuses.
    if (payload[0].error || payload[0].exception || !("data" in payload[0])) return { error: "service_unavailable", status: response.status };
    let data;
    try { data = typeof payload[0].data === "string" ? JSON.parse(payload[0].data) : payload[0].data; }
    catch { return { error: "entry_count_unavailable", status: response.status }; }
    if (!object(data) || !Array.isArray(data.activities)) return { error: "entry_count_unavailable", status: response.status };
    if (data.activities.length > MAX_ACTIVITIES) return { limited: true, status: response.status };
    return { status: response.status, activities: data.activities };
  };
  /**
   * Proves this exact Database holds no entry. Moodle's own entry count covers
   * unapproved entries only for a person who holds mod/data:approve, and its
   * `actions` item exists only for that person, so an absent `actions` item
   * means the count cannot be read as a whole and the write refuses.
   */
  const databaseIsEmpty = async (context, courseId, moduleId) => {
    const table = await overview(context, courseId);
    if (table.limited) return { limited: true, status: table.status };
    if (table.error) return { error: table.error, status: table.status };
    const rows = table.activities.filter((activity) => object(activity) && activity.modname === "data"
      && Number.isSafeInteger(activity.cmid) && String(activity.cmid) === moduleId);
    if (rows.length !== 1 || !Array.isArray(rows[0].items)) return { error: "entry_count_unavailable", status: table.status };
    const itemFor = (key) => {
      const matches = rows[0].items.filter((item) => object(item) && item.key === key);
      return matches.length === 1 ? matches[0] : null;
    };
    if (!itemFor("actions")) return { error: "capability_missing", status: table.status };
    const total = itemFor("totalentries");
    if (!total || typeof total.contentjson !== "string" || total.contentjson.length > MAX_TEXT) {
      return { error: "entry_count_unavailable", status: table.status };
    }
    let content;
    try { content = JSON.parse(total.contentjson); } catch { return { error: "entry_count_unavailable", status: table.status }; }
    if (!object(content) || content.datatype !== "integer" || !count(content.value, RESPONSE_LIMIT)) {
      return { error: "entry_count_unavailable", status: table.status };
    }
    return { status: table.status, entryCount: content.value };
  };

  /**
   * The saved option rows of one Choice settings form, in the order Moodle
   * renders them. A row Moodle keeps as a spare carries no text and no option
   * ID, so the position a caller binds counts only the saved options.
   */
  const choiceOptions = (form, entries) => {
    // A Choice with more option rows than the bound returns no list at all.
    if (namedControls(form, `option[${MAX_OPTIONS}]`).length) return "limit";
    const rows = [];
    for (let index = 0; index < MAX_OPTIONS; index += 1) {
      const text = one(entries, `option[${index}]`);
      if (text === null || text === "") continue;
      const rawLimit = one(entries, `limit[${index}]`);
      const optionId = id(one(entries, `optionid[${index}]`) || "");
      if (typeof rawLimit !== "string" || !COUNT.test(rawLimit) || !optionId || text.length > MAX_TEXT) return null;
      rows.push({ option_id: Number(optionId), position: rows.length + 1, text, response_limit: Number(rawLimit), index });
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
      // Moodle writes every exported value inside a padded CDATA section, so
      // the element text carries its own indentation.
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
  /**
   * Reads the item list. Moodle refuses to build the export file for a
   * Feedback with no items, so an absent document is reported as an empty
   * list only where the item form itself already proved the count is zero.
   */
  const feedbackItemList = async (context, moduleId) => {
    const endpoint = urlFor(context, FEEDBACK_EXPORT_PATH, { id: moduleId, action: "exportfile" });
    const page = await readDocument(context, endpoint, "application/xml", "application/xml");
    if (page.limited) return { limited: true, status: page.status };
    if (page.error === "context_changed") return { error: page.error };
    if (page.error) return { unavailable: true, status: page.status };
    const items = feedbackItems(page.document);
    if (items === "limit") return { limited: true, status: page.status };
    if (!items) return { error: "response_invalid", status: page.status };
    return { status: page.status, items };
  };
  const databaseFieldList = (parsed, context, courseId, moduleId, databaseId) => {
    const bodyClass = String(parsed.body?.className || "");
    const bound = [`course-${courseId}`, `cmid-${moduleId}`, "cm-type-data"]
      .every((entry) => new RegExp(`(?:^|\\s)${entry}(?:\\s|$)`).test(bodyClass));
    if (!bound) return "unbound";
    const forms = [...parsed.querySelectorAll("form#sortdefault")]
      .filter((form) => one(entriesFor(form) || [], "d") === databaseId);
    // Moodle answers a Database with no fields with its own zero state, which
    // carries no field list and no default-sort control.
    if (!forms.length) return { fields: [], defaultSort: null };
    if (forms.length !== 1) return null;
    const select = writableSelect(forms[0], "defaultsort");
    if (!select) return null;
    // The field type is language-independent only in the field icon, which
    // Moodle renders inside that field's own edit link.
    const icons = [...parsed.querySelectorAll("a[href] img[alt]")].map((icon) => {
      try {
        const target = new URL(icon.closest("a[href]").getAttribute("href"), context.siteUrl);
        return target.origin === context.origin && target.pathname === `${context.basePath}${DATA_FIELD_PATH}`
          && target.searchParams.get("d") === databaseId && target.searchParams.get("mode") === "display"
          ? { fieldId: target.searchParams.get("fid"), type: icon.getAttribute("alt") }
          : null;
      } catch { return null; }
    }).filter(Boolean);
    const rows = [];
    const seen = new Set();
    for (const option of [...select.querySelectorAll("optgroup > option")]) {
      const fieldId = id(option.getAttribute("value") || "");
      if (!fieldId) continue;
      if (seen.has(fieldId)) return null;
      seen.add(fieldId);
      const name = boundedString(option.textContent, MAX_TEXT);
      const types = [...new Set(icons.filter((icon) => icon.fieldId === fieldId).map((icon) => icon.type))];
      if (!name || types.length !== 1 || !FIELD_TYPE.test(types[0])) return null;
      rows.push({ field_id: Number(fieldId), position: rows.length + 1, name, type: types[0] });
      if (rows.length > MAX_FIELDS) return "limit";
    }
    const selected = selectedValue(select);
    return { fields: rows, defaultSort: id(selected || "") ? Number(selected) : null };
  };
  const databaseFields = async (context, courseId, moduleId, databaseId) => {
    const endpoint = urlFor(context, DATA_FIELD_PATH, { id: moduleId });
    const page = await readDocument(context, endpoint, "text/html", "text/html");
    if (page.limited) return { limited: true, status: page.status };
    if (page.error) return { error: page.error, status: page.status };
    const listing = databaseFieldList(page.document, context, courseId, moduleId, databaseId);
    if (listing === "limit") return { limited: true, status: page.status };
    if (listing === "unbound") return { error: "target_unavailable", status: page.status };
    if (!listing) return { error: "response_invalid", status: page.status };
    return { status: page.status, ...listing };
  };
  /**
   * One Database field's own native edit form. It is the only route that
   * states the field's description and required flag in a language-independent
   * way, so it is both the protected set before the write and the exact saved
   * state after it.
   */
  const databaseFieldForm = async (context, databaseId, fieldId, type) => {
    const endpoint = fieldId
      ? urlFor(context, DATA_FIELD_PATH, { d: databaseId, fid: fieldId, mode: "display", sesskey: context.sesskey })
      : urlFor(context, DATA_FIELD_PATH, { d: databaseId, mode: "new", newtype: type });
    const page = await readDocument(context, endpoint, "text/html", "text/html");
    if (page.limited) return { limited: true, status: page.status };
    if (page.error) return { error: page.error, status: page.status };
    const forms = [...page.document.querySelectorAll("form#editfield")].filter((form) => {
      if (String(form.getAttribute("method") || "").toLowerCase() !== "post") return false;
      try {
        const action = new URL(form.getAttribute("action") || endpoint.href, endpoint);
        return action.origin === context.origin && action.pathname === `${context.basePath}${DATA_FIELD_PATH}`
          && !action.search && !action.hash && !action.username && !action.password;
      } catch { return false; }
    });
    if (forms.length !== 1) return { error: "target_unavailable", status: page.status };
    const form = forms[0];
    const entries = entriesFor(form);
    if (!entries) return { error: "target_unavailable", status: page.status };
    if (one(entries, "d") !== databaseId || one(entries, "type") !== type
      || one(entries, "mode") !== (fieldId ? "update" : "add") || (fieldId && one(entries, "fid") !== fieldId)) {
      return { error: "target_unavailable", status: page.status };
    }
    if (one(entries, "sesskey") !== context.sesskey) return { error: "session_mismatch", status: page.status };
    const nameControl = writableTextControl(form, "name");
    const descriptionControl = writableTextControl(form, "description");
    const requiredControls = namedControls(form, "required").filter((control) => control.tagName === "INPUT"
      && String(control.getAttribute("type") || "").toLowerCase() === "checkbox");
    if (!nameControl || !descriptionControl || requiredControls.length !== 1 || requiredControls[0].disabled) {
      return { error: "target_unavailable", status: page.status };
    }
    return {
      status: page.status,
      form,
      entries,
      action: new URL(form.getAttribute("action") || endpoint.href, endpoint).href,
      name: String(nameControl.value ?? ""),
      description: String(descriptionControl.value ?? ""),
      required: Boolean(requiredControls[0].checked),
      requiredValue: String(requiredControls[0].getAttribute("value") ?? "") || "1",
    };
  };
  /** One Feedback item's own native form, for a new item or an existing one. */
  const feedbackItemForm = async (context, moduleId, itemId, type) => {
    const endpoint = itemId
      ? urlFor(context, FEEDBACK_ITEM_PATH, { id: itemId })
      : urlFor(context, FEEDBACK_ITEM_PATH, { cmid: moduleId, typ: type });
    const page = await readDocument(context, endpoint, "text/html", "text/html");
    if (page.limited) return { limited: true, status: page.status };
    if (page.error) return { error: page.error, status: page.status };
    const forms = [...page.document.querySelectorAll("form")].filter((form) => {
      if (String(form.getAttribute("method") || "").toLowerCase() !== "post") return false;
      try {
        const action = new URL(form.getAttribute("action") || endpoint.href, endpoint);
        return action.origin === context.origin && action.pathname === `${context.basePath}${FEEDBACK_ITEM_PATH}`
          && !action.search && !action.hash && !action.username && !action.password;
      } catch { return false; }
    });
    if (forms.length !== 1) return { error: "target_unavailable", status: page.status };
    const form = forms[0];
    const entries = entriesFor(form);
    if (!entries) return { error: "target_unavailable", status: page.status };
    if (one(entries, "cmid") !== moduleId || one(entries, "typ") !== type
      || (itemId ? one(entries, "id") !== itemId : Boolean(id(one(entries, "id") || "")))) {
      return { error: "target_unavailable", status: page.status };
    }
    if (one(entries, "sesskey") !== context.sesskey) return { error: "session_mismatch", status: page.status };
    const nameControl = writableTextControl(form, "name");
    const labelControl = writableTextControl(form, "label");
    const positionSelect = writableSelect(form, "position");
    const requiredControls = namedControls(form, "required");
    const requiredBoxes = requiredControls.filter((control) => control.tagName === "INPUT"
      && String(control.getAttribute("type") || "").toLowerCase() === "checkbox");
    if (!nameControl || !labelControl || !positionSelect || requiredBoxes.length !== 1 || requiredBoxes[0].disabled) {
      return { error: "target_unavailable", status: page.status };
    }
    const positions = [...positionSelect.options].map((option) => option.value);
    // The native position list is 1..n, so its length states how many
    // positions this item can take and, for a new item, how many items exist.
    if (!positions.length || positions.length > MAX_ITEMS + 1
      || positions.some((value, index) => value !== String(index + 1))) {
      return { error: "target_unavailable", status: page.status };
    }
    // A submit named `clone_item` saves a second copy instead of this change,
    // so the write requires the one control that saves this item alone.
    const submitName = itemId ? "update_item" : "save_item";
    const submits = [...form.querySelectorAll('input[type="submit"][name], button[type="submit"][name]')]
      .filter((control) => !control.disabled && control.getAttribute("name") === submitName
        && typeof control.value === "string" && control.value.length > 0 && control.value.length <= 500);
    if (submits.length !== 1) return { error: "target_unavailable", status: page.status };
    return {
      status: page.status,
      form,
      entries,
      action: new URL(form.getAttribute("action") || endpoint.href, endpoint).href,
      positions,
      requiredValue: String(requiredBoxes[0].getAttribute("value") ?? "") || "1",
      requiredOffValue: requiredControls.filter((control) => control.tagName === "INPUT"
        && String(control.getAttribute("type") || "").toLowerCase() === "hidden")
        .map((control) => String(control.getAttribute("value") ?? ""))[0] ?? "0",
      submit: { name: submits[0].getAttribute("name"), value: submits[0].value },
    };
  };

  const argumentsFor = (args, courseId) => {
    if (!object(args) || id(args.course_id) !== courseId || !id(args.module_id)) return null;
    const moduleId = id(args.module_id);
    const allowed = (names) => Object.keys(args).every((key) => names.includes(key));
    if (definition.kind === "choice-option") {
      if (!allowed(["course_id", "module_id", "option_id", "position", "text", "response_limit"])
        || !id(args.option_id) || !Number.isSafeInteger(args.position) || args.position < 1 || args.position > MAX_OPTIONS) return null;
      const changesText = Object.hasOwn(args, "text");
      const changesLimit = Object.hasOwn(args, "response_limit");
      if (!changesText && !changesLimit) return null;
      if (changesText && (!plainText(args.text, MAX_TEXT) || !savedAsSent(args.text, true))) return null;
      if (changesLimit && !count(args.response_limit, RESPONSE_LIMIT)) return null;
      return {
        courseId, moduleId, optionId: id(args.option_id), position: args.position,
        ...(changesText ? { text: args.text } : {}), ...(changesLimit ? { responseLimit: args.response_limit } : {}),
      };
    }
    if (definition.kind === "feedback-item") {
      if (definition.create) {
        if (!allowed(["course_id", "module_id", "type", "text", "label", "required", "position", "expected_item_count"])
          || !FEEDBACK_ITEM_TYPES.includes(args.type) || !plainText(args.text, MAX_ITEM_TEXT) || !savedAsSent(args.text, false)
          || typeof args.label !== "string" || args.label.length > MAX_LABEL || args.label !== args.label.trim()
          || CONTROL.test(args.label) || !savedAsSent(args.label, true)
          || typeof args.required !== "boolean" || !count(args.expected_item_count, MAX_ITEMS)
          || !Number.isSafeInteger(args.position) || args.position < 1 || args.position > args.expected_item_count + 1) return null;
        return {
          courseId, moduleId, type: args.type, text: args.text, label: args.label,
          required: args.required, position: args.position, expectedCount: args.expected_item_count,
        };
      }
      if (!allowed(["course_id", "module_id", "item_id", "position", "text", "label", "required"])
        || !id(args.item_id) || !Number.isSafeInteger(args.position) || args.position < 1 || args.position > MAX_ITEMS) return null;
      const changes = ["text", "label", "required"].filter((key) => Object.hasOwn(args, key));
      if (!changes.length) return null;
      if (changes.includes("text") && (!plainText(args.text, MAX_ITEM_TEXT) || !savedAsSent(args.text, false))) return null;
      if (changes.includes("label") && (typeof args.label !== "string" || args.label.length > MAX_LABEL
        || args.label !== args.label.trim() || CONTROL.test(args.label) || !savedAsSent(args.label, true))) return null;
      if (changes.includes("required") && typeof args.required !== "boolean") return null;
      return {
        courseId, moduleId, itemId: id(args.item_id), position: args.position,
        ...(changes.includes("text") ? { text: args.text } : {}),
        ...(changes.includes("label") ? { label: args.label } : {}),
        ...(changes.includes("required") ? { required: args.required } : {}),
      };
    }
    if (definition.create) {
      if (!allowed(["course_id", "module_id", "type", "name", "description", "required", "expected_field_count"])
        || !DATABASE_FIELD_TYPES.includes(args.type) || !plainText(args.name, MAX_FIELD_NAME)
        || typeof args.description !== "string" || args.description.length > MAX_FIELD_NAME
        || args.description !== args.description.trim() || CONTROL.test(args.description)
        || typeof args.required !== "boolean" || !count(args.expected_field_count, MAX_FIELDS)) return null;
      return {
        courseId, moduleId, type: args.type, name: args.name, description: args.description,
        required: args.required, expectedCount: args.expected_field_count,
      };
    }
    if (!allowed(["course_id", "module_id", "field_id", "position", "name", "description", "required"])
      || !id(args.field_id) || !Number.isSafeInteger(args.position) || args.position < 1 || args.position > MAX_FIELDS) return null;
    const changes = ["name", "description", "required"].filter((key) => Object.hasOwn(args, key));
    if (!changes.length) return null;
    if (changes.includes("name") && !plainText(args.name, MAX_FIELD_NAME)) return null;
    if (changes.includes("description") && (typeof args.description !== "string" || args.description.length > MAX_FIELD_NAME
      || args.description !== args.description.trim() || CONTROL.test(args.description))) return null;
    if (changes.includes("required") && typeof args.required !== "boolean") return null;
    return {
      courseId, moduleId, fieldId: id(args.field_id), position: args.position,
      ...(changes.includes("name") ? { name: args.name } : {}),
      ...(changes.includes("description") ? { description: args.description } : {}),
      ...(changes.includes("required") ? { required: args.required } : {}),
    };
  };
  const proofFor = (extra) => ({
    method: definition.method,
    complete: true,
    exact_module_binding: MODULE_BINDING,
    required_capability: definition.capability,
    native_posts: 1,
    ...extra,
  });
  const publicOptions = (options) => options.map(({ option_id: optionId, position, text, response_limit: limit }) =>
    ({ option_id: optionId, position, text, response_limit: limit }));

  let writeAttempted = false;
  try {
    const context = currentContext();
    if (input?.mode !== "execute" || !context) return failure("session_unavailable");
    if (!Number.isSafeInteger(input.expiresAt) || Date.now() >= input.expiresAt) return failure("execution_expired");
    const operation = input.operation;
    if (operation.toolName !== definition.toolName || operation.provider !== PROVIDER || operation.readOnly !== false) {
      return failure("operation_refused");
    }
    const binding = input.binding;
    if (!object(binding) || binding.origin !== context.origin || binding.siteUrl !== context.siteUrl
      || id(binding.principalId) !== context.principalId || id(binding.courseId) !== context.anchorCourseId) {
      return failure("binding_mismatch");
    }
    const args = argumentsFor(input.arguments, context.anchorCourseId);
    if (!args) return failure("arguments_invalid");

    const bound = await bindModule(context, args.courseId, args.moduleId);
    if (bound.limited) return incomplete();
    if (bound.error) return failure(bound.error, bound.status);

    if (definition.kind === "choice-option") {
      // Moodle freezes the answer-count control once responses exist, and a
      // frozen control is this form's own statement that they do.
      if (!writableSelect(bound.form, "allowmultiple")) return failure("responses_exist", bound.status);
      const limitAnswers = writableSelect(bound.form, "limitanswers");
      if (!limitAnswers) return failure("target_unavailable", bound.status);
      const before = choiceOptions(bound.form, bound.entries);
      if (before === "limit") return incomplete();
      if (!before) return failure("response_invalid", bound.status);
      const target = before.find((option) => String(option.option_id) === args.optionId);
      if (!target || target.position !== args.position) return failure("option_not_bound", bound.status);
      // Moodle's own response limit is saved only while the Choice limits
      // answers, so a limit change into a Choice that does not is refused.
      if (args.responseLimit !== undefined && selectedValue(limitAnswers) !== "1") return failure("response_limit_refused", bound.status);
      const changes = new Map();
      if (args.text !== undefined) {
        if (!writableTextControl(bound.form, `option[${target.index}]`)) return failure("option_not_writable", bound.status);
        changes.set(`option[${target.index}]`, args.text);
      }
      if (args.responseLimit !== undefined) {
        if (!writableTextControl(bound.form, `limit[${target.index}]`)) return failure("option_not_writable", bound.status);
        changes.set(`limit[${target.index}]`, String(args.responseLimit));
      }
      const submits = [...bound.form.querySelectorAll('input[type="submit"][name]')]
        .filter((control) => !control.disabled && control.getAttribute("name") === "submitbutton2"
          && typeof control.value === "string" && control.value.length > 0 && control.value.length <= 500);
      // `submitbutton` sends Moodle to the Choice's own view page, which
      // records a view, so only the save-and-return control is used.
      if (submits.length !== 1) return failure("target_unavailable", bound.status);
      const guarded = protectedEntries(bound.form, bound.entries, new Set(changes.keys()));
      const posted = await postForm(context, bound.action, bound.entries, changes, { name: "submitbutton2", value: submits[0].value });
      if (posted.error) return failure(posted.error, bound.status);
      if (posted.unconfirmed) return unconfirmed(posted.unconfirmed, posted.status);
      const landing = redirectedTo(posted.response, bound.action, context, "/course/view.php");
      if (landing.error) return unconfirmed(landing.error, landing.status);
      const after = await bindModule(context, args.courseId, args.moduleId);
      if (after.limited || after.error) return unconfirmed("readback_unconfirmed", landing.status);
      const saved = choiceOptions(after.form, after.entries);
      if (saved === "limit" || !saved) return unconfirmed("readback_unconfirmed", landing.status);
      const savedLimitAnswers = writableSelect(after.form, "limitanswers");
      if (!savedLimitAnswers) return unconfirmed("readback_unconfirmed", landing.status);
      const savedTarget = saved.find((option) => String(option.option_id) === args.optionId);
      const expectedText = args.text === undefined ? target.text : args.text;
      const expectedLimit = args.responseLimit === undefined ? target.response_limit : args.responseLimit;
      const unchanged = stable(protectedEntries(after.form, after.entries, new Set(changes.keys()))) === stable(guarded)
        && stable(publicOptions(saved.filter((option) => option !== savedTarget)))
          === stable(publicOptions(before.filter((option) => option !== target)));
      if (!savedTarget || savedTarget.position !== args.position || saved.length !== before.length
        || savedTarget.text !== expectedText || savedTarget.response_limit !== expectedLimit || !unchanged) {
        return mismatch(landing.status);
      }
      const data = {
        schema: definition.schema,
        provider: PROVIDER,
        course_id: Number(args.courseId),
        module_id: Number(args.moduleId),
        choice_id: Number(after.instanceId),
        option_count: saved.length,
        options: publicOptions(saved),
        limit_answers: selectedValue(savedLimitAnswers) === "1",
        has_responses: false,
        changed_option: { option_id: Number(args.optionId), position: args.position, text: savedTarget.text, response_limit: savedTarget.response_limit },
        proof: proofFor({ option_limit: MAX_OPTIONS, option_rows: saved.length, text_limit: MAX_TEXT, response_lock: "allowmultiple_writable" }),
      };
      return {
        ok: true, sent: true, status: landing.status ?? after.status, data,
        snapshot_digest: await digest(data),
        verification: { schema: "morrow.browser-verification.v1", status: "verified" },
      };
    }

    if (definition.kind === "feedback-item") {
      // Moodle replaces the writable multiple-submission control with a frozen
      // one once the Feedback has completed responses.
      if (namedControls(bound.form, "multiple_submit_static").length > 0 || !writableSelect(bound.form, "multiple_submit")) {
        return failure("responses_exist", bound.status);
      }
      const anonymous = writableSelect(bound.form, "anonymous");
      if (!anonymous || (selectedValue(anonymous) !== "1" && selectedValue(anonymous) !== "2")) return failure("target_unavailable", bound.status);
      const before = await feedbackItemList(context, args.moduleId);
      if (before.limited) return incomplete();
      if (before.error) return failure(before.error, before.status);
      const beforeItems = before.unavailable ? [] : before.items;
      const target = definition.create ? null : beforeItems.find((item) => String(item.item_id) === args.itemId);
      if (!definition.create && (!target || target.position !== args.position)) return failure("item_not_bound", before.status);
      const type = definition.create ? args.type : target.type;
      if (!FEEDBACK_ITEM_TYPES.includes(type)) return failure("item_type_unsupported", before.status);
      const itemForm = await feedbackItemForm(context, args.moduleId, definition.create ? "" : args.itemId, type);
      if (itemForm.limited) return incomplete();
      if (itemForm.error) return failure(itemForm.error, itemForm.status);
      // The native position list states the count this change was reviewed
      // against: one entry per item for an edit, one more for a new item.
      const expectedPositions = definition.create ? args.expectedCount + 1 : beforeItems.length;
      if (itemForm.positions.length !== expectedPositions) return failure("item_list_changed", itemForm.status);
      if (before.unavailable && expectedPositions !== 1) return failure("read_unavailable", before.status);
      if (!before.unavailable && definition.create && beforeItems.length !== args.expectedCount) return failure("item_list_changed", before.status);
      if (!itemForm.positions.includes(String(args.position))) return failure("item_not_bound", itemForm.status);
      const changes = new Map([["position", String(args.position)]]);
      if (args.text !== undefined) changes.set("name", args.text);
      if (args.label !== undefined) changes.set("label", args.label);
      if (args.required !== undefined) changes.set("required", args.required ? itemForm.requiredValue : itemForm.requiredOffValue);
      const posted = await postForm(context, itemForm.action, itemForm.entries, changes, itemForm.submit);
      if (posted.error) return failure(posted.error, itemForm.status);
      if (posted.unconfirmed) return unconfirmed(posted.unconfirmed, posted.status);
      const landing = redirectedTo(posted.response, itemForm.action, context, "/mod/feedback/edit.php");
      if (landing.error) return unconfirmed(landing.error, landing.status);
      const after = await feedbackItemList(context, args.moduleId);
      if (after.limited || after.error || after.unavailable) return unconfirmed("readback_unconfirmed", landing.status);
      const savedItems = after.items;
      const savedTarget = definition.create
        ? savedItems.find((item) => item.position === args.position && !beforeItems.some((entry) => entry.item_id === item.item_id))
        : savedItems.find((item) => String(item.item_id) === args.itemId);
      // Inserting an item renumbers every item after it, so the other items
      // are compared without their positions and in their own list order,
      // which proves both their content and their order are unchanged.
      const withoutPosition = ({ position, ...rest }) => rest;
      const others = savedItems.filter((item) => item !== savedTarget).map(withoutPosition);
      const expectedOthers = (definition.create ? beforeItems : beforeItems.filter((item) => item !== target)).map(withoutPosition);
      const expectedText = definition.create || args.text !== undefined ? args.text : target.text;
      const expectedLabel = definition.create || args.label !== undefined ? args.label : target.label;
      const expectedRequired = definition.create || args.required !== undefined ? args.required : target.required;
      if (!savedTarget || savedItems.length !== beforeItems.length + (definition.create ? 1 : 0)
        || savedTarget.position !== args.position || savedTarget.type !== type
        || savedTarget.text !== expectedText || savedTarget.label !== expectedLabel || savedTarget.required !== expectedRequired
        || (!definition.create && (savedTarget.presentation !== target.presentation
          || savedTarget.depends_on_item_id !== target.depends_on_item_id || savedTarget.depends_on_value !== target.depends_on_value))
        || stable(others) !== stable(expectedOthers)) {
        return mismatch(landing.status);
      }
      const data = {
        schema: definition.schema,
        provider: PROVIDER,
        course_id: Number(args.courseId),
        module_id: Number(args.moduleId),
        feedback_id: Number(bound.instanceId),
        anonymous: selectedValue(anonymous) === "1",
        has_responses: false,
        item_count: savedItems.length,
        items: savedItems,
        changed_item: {
          item_id: savedTarget.item_id, position: savedTarget.position, type: savedTarget.type,
          required: savedTarget.required, text: savedTarget.text, label: savedTarget.label,
        },
        proof: proofFor({ item_limit: MAX_ITEMS, item_rows: savedItems.length, text_limit: MAX_ITEM_TEXT, response_lock: "multiple_submit_writable" }),
      };
      return {
        ok: true, sent: true, status: landing.status ?? after.status, data,
        snapshot_digest: await digest(data),
        verification: { schema: "morrow.browser-verification.v1", status: "verified" },
      };
    }

    // A Database field write changes the shape every saved entry is stored
    // against, so it proceeds only while Moodle's own count says the Database
    // holds none.
    const entries = await databaseIsEmpty(context, args.courseId, args.moduleId);
    if (entries.limited) return incomplete();
    if (entries.error) return failure(entries.error, entries.status);
    if (entries.entryCount !== 0) return failure("entries_exist", entries.status);
    const before = await databaseFields(context, args.courseId, args.moduleId, bound.instanceId);
    if (before.limited) return incomplete();
    if (before.error) return failure(before.error, before.status);
    const target = definition.create ? null : before.fields.find((field) => String(field.field_id) === args.fieldId);
    if (!definition.create && (!target || target.position !== args.position)) return failure("field_not_bound", before.status);
    if (definition.create && before.fields.length !== args.expectedCount) return failure("field_list_changed", before.status);
    const type = definition.create ? args.type : target.type;
    if (!DATABASE_FIELD_TYPES.includes(type)) return failure("field_type_unsupported", before.status);
    // Moodle refuses a field name another field already uses, and answers with
    // its own notice rather than a save, so a clash is refused before send.
    const proposedName = args.name === undefined ? null : args.name;
    if (proposedName !== null && before.fields.some((field) => field.name === proposedName && String(field.field_id) !== args.fieldId)) {
      return failure("field_name_in_use", before.status);
    }
    const fieldForm = await databaseFieldForm(context, bound.instanceId, definition.create ? "" : args.fieldId, type);
    if (fieldForm.limited) return incomplete();
    if (fieldForm.error) return failure(fieldForm.error, fieldForm.status);
    if (!definition.create && fieldForm.name !== target.name) return failure("field_not_bound", fieldForm.status);
    const expectedName = proposedName === null ? fieldForm.name : proposedName;
    const expectedDescription = args.description === undefined ? fieldForm.description : args.description;
    const expectedRequired = args.required === undefined ? fieldForm.required : args.required;
    const changes = new Map();
    if (proposedName !== null) changes.set("name", proposedName);
    if (args.description !== undefined) changes.set("description", args.description);
    // The native required control carries no value attribute, so Moodle reads
    // it as set whenever it arrives and as clear whenever it does not.
    if (args.required !== undefined) changes.set("required", args.required ? fieldForm.requiredValue : null);
    const guarded = protectedEntries(fieldForm.form, fieldForm.entries, new Set(changes.keys()));
    const posted = await postForm(context, fieldForm.action, fieldForm.entries, changes, null);
    if (posted.error) return failure(posted.error, fieldForm.status);
    if (posted.unconfirmed) return unconfirmed(posted.unconfirmed, posted.status);
    // mod/data saves a field in place and renders the field list again, so a
    // redirect is not the saved answer here.
    if (posted.response.type === "opaqueredirect" || !posted.response.ok) return unconfirmed("write_unconfirmed", posted.response.status);
    const sentStatus = posted.response.status;
    const after = await databaseFields(context, args.courseId, args.moduleId, bound.instanceId);
    if (after.limited || after.error) return unconfirmed("readback_unconfirmed", sentStatus);
    const savedTarget = definition.create
      ? after.fields.find((field) => !before.fields.some((entry) => entry.field_id === field.field_id))
      : after.fields.find((field) => String(field.field_id) === args.fieldId);
    // Moodle appends a new field, so the fields this change did not name keep
    // both their content and their order.
    const withoutPosition = ({ position, ...rest }) => rest;
    const others = after.fields.filter((field) => field !== savedTarget).map(withoutPosition);
    const expectedOthers = before.fields.filter((field) => field !== target).map(withoutPosition);
    if (!savedTarget || after.fields.length !== before.fields.length + (definition.create ? 1 : 0)
      || savedTarget.name !== expectedName || savedTarget.type !== type
      || (definition.create && savedTarget.position !== before.fields.length + 1)
      || (!definition.create && savedTarget.position !== args.position)
      || stable(others) !== stable(expectedOthers)) {
      return mismatch(sentStatus);
    }
    const savedForm = await databaseFieldForm(context, bound.instanceId, String(savedTarget.field_id), type);
    if (savedForm.limited || savedForm.error) return unconfirmed("readback_unconfirmed", sentStatus);
    // A create has no earlier protected set of its own, so its exact saved
    // values are the whole check. An edit also has to give its own form back
    // with every control this change did not name unchanged.
    const keptUnchanged = definition.create
      || stable(protectedEntries(savedForm.form, savedForm.entries, new Set(changes.keys()))) === stable(guarded);
    if (savedForm.name !== expectedName || savedForm.description !== expectedDescription
      || savedForm.required !== expectedRequired || !keptUnchanged) {
      return mismatch(sentStatus);
    }
    const data = {
      schema: definition.schema,
      provider: PROVIDER,
      course_id: Number(args.courseId),
      module_id: Number(args.moduleId),
      database_id: Number(bound.instanceId),
      entry_count: 0,
      field_count: after.fields.length,
      default_sort_field_id: after.defaultSort,
      fields: after.fields.map(({ field_id: fieldId, position, name, type: fieldType }) => ({ field_id: fieldId, position, name, type: fieldType })),
      changed_field: {
        field_id: savedTarget.field_id, position: savedTarget.position, name: savedForm.name,
        type: savedTarget.type, description: savedForm.description, required: savedForm.required,
      },
      proof: proofFor({ field_limit: MAX_FIELDS, field_rows: after.fields.length, text_limit: MAX_FIELD_NAME, entry_lock: "overview_total_entries_zero" }),
    };
    return {
      ok: true, sent: true, status: sentStatus, data,
      snapshot_digest: await digest(data),
      verification: { schema: "morrow.browser-verification.v1", status: "verified" },
    };
  } catch (error) {
    if (writeAttempted) return unconfirmed("write_unconfirmed");
    const message = String(error?.message || error);
    return message.startsWith(`${prefix}_`) ? { ok: false, sent: false, error: message } : failure("execution_failed");
  }
}
