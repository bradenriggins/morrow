/**
 * Reads the settings of one Moodle course through its native course settings
 * form, changes a bounded set of those settings, and changes the course format
 * as its own operation.
 *
 * The read returns every control the native form carries, with the exact
 * protected-setting values a later change is compared against. A settings
 * change reloads the exact form, carries every control it was not asked to
 * change through unchanged, sends one POST, then reads the saved form back and
 * compares both the changed settings and a protected digest of everything else.
 *
 * A format change is separate because it moves every section and every activity
 * in the course into the new format's layout. It reads the complete course
 * state before and after the change and reports both.
 *
 * Chrome serializes this function for a MAIN-world injection. Keep every
 * dependency inside the function body.
 */
export async function executeMoodleCourseSettingsInPage(rawInput) {
  const PROVIDER = "moodle";
  const MAX_FORM_ENTRIES = 600;
  // The course summary and a long-text custom field are both larger than any
  // gradebook control, so this form carries a wider byte bound than they do.
  const MAX_FORM_BYTES = 512 * 1024;
  const MAX_VALUE_BYTES = 64 * 1024;
  const MAX_OPTIONS = 300;
  const MAX_FILE_AREAS = 20;
  const MAX_STATE_ROWS = 2_000;
  const MAX_CHANGE_ROWS = 50;
  const MAX_TEXT = 255;
  const MAX_LABEL = 200;
  const ID = /^[1-9][0-9]{0,18}$/;
  const DIGEST = /^[a-f0-9]{64}$/;
  const SHORTNAME = /^[A-Za-z0-9_-]{1,100}$/;
  const DATE_COMPONENTS = ["year", "month", "day", "hour", "minute"];
  // A draft item id, a session key and mform's own state fields change on every
  // load of the same form, so they are never part of a digest or a result.
  const TRANSIENT_FIELD = /(?:sesskey|statekey|_qf__|csrf|token|secret|password|authorization|cookie|(?:^|[\[_-])(?:draft|itemid)(?:$|[\]_-]))/i;
  const FORMAT_FIELD = "format";
  const FORMAT_FIELDSET = "fieldset#id_courseformathdr";
  const FORMAT_RESERVED = new Set(["format", "updatecourseformat", "addcourseformatoptionshere"]);
  const TAGS_FIELD = "tags[]";
  const CUSTOM_FIELD_PREFIX = "customfield_";
  const COURSE_IMAGE_FIELD = "overviewfiles_filemanager";
  const SUBMIT_FIELD = "saveanddisplay";
  /**
   * The controls a format change must not alter. A format change replaces the
   * format's own option controls, so it cannot be checked against the protected
   * digest of the whole form; these are the course settings that must come back
   * exactly as they were.
   */
  const IDENTITY_FIELDS = new Set([
    "id", "fullname", "shortname", "idnumber", "visible", "category", "downloadcontent", "relativedatesmode",
    "summary_editor[text]", "summary_editor[format]",
    ...DATE_COMPONENTS.map((component) => `startdate[${component}]`),
    "enddate[enabled]", ...DATE_COMPONENTS.map((component) => `enddate[${component}]`),
  ]);
  /**
   * Every fixed control of `public/course/edit_form.php` that one reviewed
   * change is allowed to write, with the Morrow argument that names it. The
   * course category, the course visibility and the course summary are read here
   * but changed elsewhere, so they stay protected on this route.
   */
  const SETTINGS = Object.freeze([
    Object.freeze({ group: "general", argument: "full_name", field: "fullname", kind: "text" }),
    Object.freeze({ group: "general", argument: "short_name", field: "shortname", kind: "text" }),
    Object.freeze({ group: "general", argument: "id_number", field: "idnumber", kind: "text", allowEmpty: true }),
    Object.freeze({ group: "general", argument: "start_date", field: "startdate", kind: "date" }),
    Object.freeze({ group: "general", argument: "end_date", field: "enddate", kind: "date", optional: true }),
    Object.freeze({ group: "general", argument: "download_content", field: "downloadcontent", kind: "select" }),
    Object.freeze({ group: "general", argument: "relative_dates_mode", field: "relativedatesmode", kind: "select" }),
    Object.freeze({ group: "appearance", argument: "theme", field: "theme", kind: "select", allowEmpty: true }),
    Object.freeze({ group: "appearance", argument: "language", field: "lang", kind: "select", allowEmpty: true }),
    Object.freeze({ group: "appearance", argument: "calendar_type", field: "calendartype", kind: "select", allowEmpty: true }),
    Object.freeze({ group: "appearance", argument: "announcements", field: "newsitems", kind: "select" }),
    Object.freeze({ group: "appearance", argument: "show_grades", field: "showgrades", kind: "select" }),
    Object.freeze({ group: "appearance", argument: "show_activity_reports", field: "showreports", kind: "select" }),
    Object.freeze({ group: "appearance", argument: "show_activity_dates", field: "showactivitydates", kind: "select" }),
    Object.freeze({ group: "files_and_uploads", argument: "legacy_files", field: "legacyfiles", kind: "select" }),
    Object.freeze({ group: "files_and_uploads", argument: "maximum_upload_size", field: "maxbytes", kind: "select" }),
    Object.freeze({ group: "files_and_uploads", argument: "pdf_export_font", field: "pdfexportfont", kind: "select", allowEmpty: true }),
    Object.freeze({ group: "completion", argument: "completion_tracking", field: "enablecompletion", kind: "select" }),
    Object.freeze({ group: "completion", argument: "show_completion_conditions", field: "showcompletionconditions", kind: "select" }),
    Object.freeze({ group: "groups", argument: "group_mode", field: "groupmode", kind: "select" }),
    Object.freeze({ group: "groups", argument: "force_group_mode", field: "groupmodeforce", kind: "select" }),
    Object.freeze({ group: "groups", argument: "default_grouping", field: "defaultgroupingid", kind: "select" }),
    Object.freeze({ group: "ai_tools", argument: "ai_tools", field: "enableaitools", kind: "select" }),
  ]);
  const SETTING_ARGUMENTS = SETTINGS.map((setting) => setting.argument);
  const LIST_ARGUMENTS = ["format_options", "tags", "custom_fields"];
  const definitions = Object.freeze({
    "moodle.form.course.edit.settings.read.v1": { toolName: "moodle_get_course_settings", readOnly: true, kind: "read" },
    "moodle.form.course.edit.settings.write.v1": { toolName: "moodle_update_course_settings", readOnly: false, kind: "settings" },
    "moodle.form.course.edit.format.write.v1": { toolName: "moodle_change_course_format", readOnly: false, kind: "format" },
  });
  const ROUTE = Object.freeze({ path: "/course/edit.php", capability: "moodle/course:update" });
  const PROOF = Object.freeze({
    method: "native_form_read",
    route: ROUTE.path,
    required_capability: ROUTE.capability,
    scope: "course_settings_only",
  });
  const parseInput = () => {
    if (typeof rawInput !== "string") return rawInput;
    try { return JSON.parse(rawInput); } catch { return null; }
  };
  const input = parseInput();
  const failure = (error, status) => ({ ok: false, sent: false, ...(Number.isInteger(status) ? { status } : {}), error });
  const unconfirmedWrite = (error, status) => ({
    ok: false,
    sent: true,
    ...(Number.isInteger(status) ? { status } : {}),
    outcomeUnknown: true,
    verification: { schema: "morrow.browser-verification.v1", status: "unconfirmed", reason: error },
    error,
  });
  const object = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
  const id = (value) => {
    const text = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : typeof value === "string" ? value : "";
    return ID.test(text) ? text : "";
  };
  const validText = (value, maximum = MAX_TEXT) => typeof value === "string" && value.length > 0 && value.length <= maximum
    && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
  const validOptionalText = (value, maximum = MAX_TEXT) => value === "" || validText(value, maximum);
  const stable = (value) => {
    if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
    if (object(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
    return JSON.stringify(value === undefined ? null : value);
  };
  const digest = async (value) => {
    if (!globalThis.crypto?.subtle || typeof globalThis.TextEncoder !== "function") throw new Error("moodle_course_settings_digest_unavailable");
    const bytes = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(stable(value)));
    return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
  };
  const redact = (value) => value.replace(/([?&](?:sesskey|token|csrf|password|secret)=)[^&#\s]+/gi, "$1[redacted]");
  const sanitize = (value, depth = 0) => {
    if (depth > 16) return null;
    if (Array.isArray(value)) return value.slice(0, MAX_STATE_ROWS).map((entry) => sanitize(entry, depth + 1));
    if (!object(value)) return typeof value === "string" ? redact(value.slice(0, MAX_VALUE_BYTES)) : value;
    const output = {};
    for (const [key, child] of Object.entries(value)) {
      if (TRANSIENT_FIELD.test(key)) continue;
      output[key] = sanitize(child, depth + 1);
    }
    return output;
  };
  const currentContext = () => {
    const cfg = globalThis.M?.cfg;
    if (!object(cfg) || typeof cfg.wwwroot !== "string" || !validText(cfg.sesskey, 1024)) return null;
    const principalId = id(cfg.userId);
    if (!principalId) return null;
    let site;
    try { site = new URL(cfg.wwwroot); } catch { return null; }
    if (site.protocol !== "https:" || site.search || site.hash || site.username || site.password) return null;
    const currentOrigin = String(globalThis.location?.origin || "");
    const currentPath = String(globalThis.location?.pathname || "");
    const basePath = site.pathname.replace(/\/$/, "");
    if (site.origin !== currentOrigin || !(currentPath === basePath || currentPath.startsWith(`${basePath}/`))) return null;
    const configuredCourse = id(cfg.courseId);
    const bodyCourse = String(globalThis.document?.body?.className || "").match(/(?:^|\s)course-([1-9][0-9]*)(?:\s|$)/)?.[1] || "";
    if (configuredCourse && bodyCourse && bodyCourse !== configuredCourse) return null;
    const anchorCourseId = configuredCourse || bodyCourse;
    if (!anchorCourseId) return null;
    return { origin: site.origin, siteUrl: site.href, basePath, principalId, anchorCourseId, sesskey: cfg.sesskey };
  };
  const sameContext = (left, right) => left?.origin === right?.origin && left?.siteUrl === right?.siteUrl
    && left?.basePath === right?.basePath && left?.principalId === right?.principalId
    && left?.anchorCourseId === right?.anchorCourseId && left?.sesskey === right?.sesskey;
  const bindingValid = (context, binding) => object(binding) && binding.origin === context.origin && binding.siteUrl === context.siteUrl
    && id(binding.principalId) === context.principalId && Boolean(id(binding.courseId));
  const expectedOperation = (operation) => {
    if (!object(operation) || typeof operation.key !== "string") return null;
    const definition = definitions[operation.key];
    return definition && operation.provider === PROVIDER && operation.toolName === definition.toolName
      && operation.readOnly === definition.readOnly ? definition : null;
  };
  const urlFor = (context, path, params) => {
    const url = new URL(context.siteUrl);
    url.pathname = `${context.basePath}${path}`;
    url.search = new URLSearchParams(params).toString();
    url.hash = "";
    return url;
  };
  const endpointFor = (context, courseId) => urlFor(context, ROUTE.path, { id: courseId });
  const sameRoute = (value, expected) => {
    let received;
    try { received = new URL(value); } catch { return false; }
    if (received.origin !== expected.origin || received.pathname !== expected.pathname || received.hash
      || received.username || received.password) return false;
    const sort = (url) => [...url.searchParams.entries()]
      .sort(([leftName, leftValue], [rightName, rightValue]) => leftName.localeCompare(rightName) || leftValue.localeCompare(rightValue));
    return stable(sort(received)) === stable(sort(expected));
  };
  const validDate = (value) => {
    if (!object(value) || Object.keys(value).length !== DATE_COMPONENTS.length
      || !DATE_COMPONENTS.every((key) => Number.isSafeInteger(value[key]))) return false;
    const { year, month, day, hour, minute } = value;
    if (year < 1970 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31 || hour < 0 || hour > 23 || minute < 0 || minute > 59) return false;
    const date = new Date(Date.UTC(year, month - 1, day, hour, minute));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  };
  const validSelectValue = (value, allowEmpty) => (typeof value === "number" && Number.isSafeInteger(value))
    || (allowEmpty ? validOptionalText(value, 128) : validText(value, 128));
  const validListRows = (value, keys) => Array.isArray(value) && value.length <= MAX_CHANGE_ROWS
    && value.every((entry) => object(entry) && Object.keys(entry).length === keys.length && keys.every((key) => Object.hasOwn(entry, key)));
  const settingsArgumentsFor = (args, courseId) => {
    const allowed = new Set(["course_id", "expected_digest", ...SETTING_ARGUMENTS, ...LIST_ARGUMENTS]);
    if (!object(args) || Object.keys(args).some((key) => !allowed.has(key))) return null;
    if (id(args.course_id) !== courseId || !DIGEST.test(String(args.expected_digest || ""))) return null;
    const requested = [];
    for (const setting of SETTINGS) {
      const value = args[setting.argument];
      if (value === undefined) continue;
      if (setting.kind === "text" && !(setting.allowEmpty ? validOptionalText(value) : validText(value))) return null;
      if (setting.kind === "select" && !validSelectValue(value, setting.allowEmpty === true)) return null;
      if (setting.kind === "date" && !(validDate(value) || (setting.optional === true && value === null))) return null;
      requested.push({ ...setting, value });
    }
    if (args.format_options !== undefined) {
      if (!validListRows(args.format_options, ["name", "value"])) return null;
      const names = args.format_options.map((entry) => entry.name);
      if (new Set(names).size !== names.length) return null;
      for (const entry of args.format_options) {
        if (!validText(entry.name, 100) || FORMAT_RESERVED.has(entry.name) || !validSelectValue(entry.value, true)) return null;
        requested.push({ group: "format_options", argument: "format_options", field: entry.name, kind: "option", value: entry.value });
      }
    }
    if (args.tags !== undefined) {
      if (!Array.isArray(args.tags) || args.tags.length > MAX_CHANGE_ROWS || !args.tags.every((tag) => validText(tag, 128))
        || new Set(args.tags).size !== args.tags.length) return null;
      requested.push({ group: "tags", argument: "tags", field: TAGS_FIELD, kind: "tags", value: args.tags });
    }
    if (args.custom_fields !== undefined) {
      if (!validListRows(args.custom_fields, ["name", "value"])) return null;
      const names = args.custom_fields.map((entry) => entry.name);
      if (new Set(names).size !== names.length) return null;
      for (const entry of args.custom_fields) {
        if (!SHORTNAME.test(String(entry.name)) || !validSelectValue(entry.value, true)) return null;
        requested.push({ group: "custom_fields", argument: "custom_fields", field: `${CUSTOM_FIELD_PREFIX}${entry.name}`, name: entry.name, kind: "option", value: entry.value });
      }
    }
    return requested.length ? { courseId, expectedDigest: args.expected_digest, requested } : null;
  };
  const formatArgumentsFor = (args, courseId) => {
    const allowed = ["course_id", "format", "acknowledge_layout_change", "expected_digest"];
    if (!object(args) || Object.keys(args).length !== allowed.length || allowed.some((key) => !Object.hasOwn(args, key))) return null;
    if (id(args.course_id) !== courseId || !validText(args.format, 100) || !DIGEST.test(String(args.expected_digest || ""))) return null;
    return { courseId, format: args.format, expectedDigest: args.expected_digest, acknowledged: args.acknowledge_layout_change === true };
  };
  const argumentsFor = (definition, args, binding) => {
    const courseId = id(binding?.courseId);
    if (!courseId) return null;
    if (definition.kind === "read") {
      return object(args) && Object.keys(args).length === 1 && id(args.course_id) === courseId ? { courseId } : null;
    }
    return definition.kind === "format" ? formatArgumentsFor(args, courseId) : settingsArgumentsFor(args, courseId);
  };
  const readPage = async (context, endpoint) => {
    let response;
    try {
      response = await fetch(endpoint, { method: "GET", credentials: "include", cache: "no-store", redirect: "error", headers: { Accept: "text/html" } });
    } catch { return { error: "moodle_course_settings_read_unavailable" }; }
    if (!response.ok || !sameRoute(response.url, endpoint) || !sameContext(context, currentContext())) {
      return { error: "moodle_course_settings_read_unavailable", status: response.status };
    }
    let html;
    try { html = await response.text(); } catch { return { error: "moodle_course_settings_read_unavailable", status: response.status }; }
    if (typeof html !== "string" || html.length > 4 * 1024 * 1024 || typeof globalThis.DOMParser !== "function") {
      return { error: "moodle_course_settings_read_unavailable", status: response.status };
    }
    try { return { status: response.status, document: new DOMParser().parseFromString(html, "text/html") }; }
    catch { return { error: "moodle_course_settings_read_unavailable", status: response.status }; }
  };
  const one = (values, expected) => values.length === 1 && values[0] === expected;
  const nativeForm = (documentValue, endpoint) => {
    const matches = [...documentValue.querySelectorAll("form")].filter((form) => {
      if (String(form.getAttribute("method") || "").toLowerCase() !== "post") return false;
      const action = form.getAttribute("action");
      if (!action) return false;
      try { return sameRoute(new URL(action, endpoint).href, endpoint); } catch { return false; }
    });
    return matches.length === 1 ? matches[0] : null;
  };
  const entriesFor = (form) => {
    let values;
    try { values = [...new FormData(form).entries()]; } catch { return null; }
    if (values.length > MAX_FORM_ENTRIES) return null;
    let size = 0;
    const entries = [];
    for (const [name, value] of values) {
      if (typeof name !== "string" || name.length < 1 || name.length > 255 || typeof value !== "string" || value.length > MAX_VALUE_BYTES) return null;
      size += name.length + value.length;
      if (size > MAX_FORM_BYTES) return null;
      entries.push([name, value]);
    }
    return entries;
  };
  const namedControls = (form, name) => [...form.querySelectorAll("[name]")].filter((control) => control.getAttribute("name") === name);
  const draftItemId = (value) => (typeof value === "string" && ID.test(value) ? value : "");
  // Moodle's own draft-area listing. Source:
  // https://github.com/moodle/moodle/blob/v5.2.2/public/repository/draftfiles_ajax.php
  const readDraftListing = async (context, itemId) => {
    let response;
    try {
      response = await fetch(urlFor(context, "/repository/draftfiles_ajax.php", { action: "list" }), {
        method: "POST", credentials: "include", cache: "no-store",
        headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
        body: new URLSearchParams({ sesskey: context.sesskey, itemid: itemId, filepath: "/" }),
      });
    } catch { return null; }
    if (!response.ok) return null;
    let payload;
    try { payload = JSON.parse(await response.text()); } catch { return null; }
    return object(payload) ? payload : null;
  };
  /**
   * A file area reaches the form as a draft item id that changes on every load,
   * so it is never part of a digest or a result. What the digest and the result
   * carry is whether Morrow proved the area empty.
   */
  const inspectFileAreas = async (context, form, entries) => {
    const names = new Set();
    for (const control of form.querySelectorAll('[data-fieldtype="filemanager"] input[type="hidden"][name]')) {
      const name = String(control.getAttribute("name") || "");
      if (name) names.add(name);
    }
    for (const [name] of entries) if (/\[itemid\]$/.test(name)) names.add(name);
    if (names.size > MAX_FILE_AREAS) return null;
    const areas = new Map();
    for (const name of names) {
      const values = entries.filter(([entryName]) => entryName === name).map(([, value]) => value);
      const itemId = values.length === 1 ? draftItemId(values[0]) : "";
      const listing = itemId ? await readDraftListing(context, itemId) : null;
      const state = !listing || !Number.isSafeInteger(listing.filecount) || listing.filecount < 0 || !Array.isArray(listing.list)
        ? "unverified"
        : listing.filecount === 0 && listing.list.length === 0 ? "empty" : "nonempty";
      areas.set(name, state);
    }
    return areas;
  };
  // One POST of this form carries a new draft area for every file area on it,
  // so a change is refused while any of them holds a file, and while any of
  // them cannot be proved empty. The course image is named first because it is
  // the file area a course settings change is most likely to hold.
  const fileAreaRefusal = (areas) => {
    if (areas.get(COURSE_IMAGE_FIELD) === "nonempty") return "moodle_course_image_files_present";
    for (const state of areas.values()) if (state === "nonempty") return "moodle_course_files_present";
    return [...areas.values()].every((state) => state === "empty") ? "" : "moodle_course_files_unverified";
  };
  /**
   * The digest preimage. A native optional date control that is switched off
   * still renders its components, and Moodle ignores them, so an off date is
   * recorded as the toggle alone.
   */
  const snapshotEntries = (form, entries, areas) => {
    const ignored = new Set();
    const disabled = [];
    for (const control of form.querySelectorAll('input[type="checkbox"][name$="[enabled]"]')) {
      if (control.checked) continue;
      const name = String(control.getAttribute("name") || "");
      const prefix = name.slice(0, -"[enabled]".length);
      if (!prefix) continue;
      disabled.push(name);
      for (const component of DATE_COMPONENTS) ignored.add(`${prefix}[${component}]`);
      ignored.add(name);
    }
    const snapshot = [];
    for (const [name, value] of entries) {
      if (areas.has(name)) { snapshot.push([name, `file_area:${areas.get(name)}`]); continue; }
      if (ignored.has(name) || TRANSIENT_FIELD.test(name)) continue;
      snapshot.push([name, value]);
    }
    for (const name of disabled) snapshot.push([name, "0"]);
    return snapshot;
  };
  const optionsOf = (form, name) => {
    const selects = namedControls(form, name).filter((control) => control.tagName === "SELECT");
    if (selects.length !== 1 || selects[0].disabled) return null;
    const options = [...selects[0].options].map((option) => ({
      value: String(option.value ?? ""),
      label: String(option.textContent || "").replace(/\s+/g, " ").trim().slice(0, MAX_LABEL),
    }));
    return { multiple: selects[0].multiple === true, options };
  };
  const availableFor = (form, name) => {
    const control = optionsOf(form, name);
    if (!control) return {};
    return control.options.length > MAX_OPTIONS
      ? { available_count: control.options.length }
      : { available: control.options };
  };
  const offersOption = (form, name, value) => {
    const control = optionsOf(form, name);
    return Boolean(control) && control.options.some((option) => option.value === value);
  };
  // A native control Moodle has frozen renders as static text beside a hidden
  // field, so a writable text control is the single visible input or textarea.
  const writableText = (form, name) => {
    const controls = namedControls(form, name);
    const editable = controls.filter((control) => (control.tagName === "INPUT"
      && ["", "text", "number"].includes(String(control.getAttribute("type") || "").toLowerCase())) || control.tagName === "TEXTAREA");
    return controls.length === 1 && editable.length === 1 && !editable[0].disabled && !editable[0].readOnly;
  };
  const valuesOf = (entries, name) => entries.filter(([field]) => field === name).map(([, value]) => value);
  const currentText = (entries, name) => {
    const values = valuesOf(entries, name);
    return values.length ? values[values.length - 1] : "";
  };
  const dateControls = (form, field, optional) => {
    const components = DATE_COMPONENTS.map((component) => optionsOf(form, `${field}[${component}]`));
    if (components.some((control) => !control || control.multiple)) return null;
    if (!optional) return { components, toggle: null };
    const toggles = namedControls(form, `${field}[enabled]`)
      .filter((control) => control.tagName === "INPUT" && String(control.getAttribute("type") || "").toLowerCase() === "checkbox");
    return toggles.length === 1 && !toggles[0].disabled && toggles[0].value === "1" ? { components, toggle: toggles[0] } : null;
  };
  const dateValue = (form, entries, field, optional) => {
    const controls = dateControls(form, field, optional);
    if (!controls) return null;
    if (optional && !controls.toggle.checked) return null;
    const date = {};
    for (const component of DATE_COMPONENTS) date[component] = Number(currentText(entries, `${field}[${component}]`));
    return validDate(date) ? date : null;
  };
  /**
   * A course format plugin declares its own option controls, and Moodle renders
   * them inside the Course format section of this form. That section is the
   * only source for which controls those are.
   */
  const formatOptionFields = (form, areas) => {
    const fieldset = form.querySelector(FORMAT_FIELDSET);
    if (!fieldset) return null;
    const names = [];
    for (const control of fieldset.querySelectorAll("[name]")) {
      const name = String(control.getAttribute("name") || "");
      if (!name || FORMAT_RESERVED.has(name) || /^mform_isexpanded/.test(name) || TRANSIENT_FIELD.test(name)
        || areas.has(name) || names.includes(name)) continue;
      names.push(name);
    }
    return names;
  };
  // A custom field of a long-text type carries its own draft file area, and
  // that draft item id is a secret that stays in Chrome. It is reported as a
  // file area instead, like every other file area on this form.
  const customFieldNames = (entries, areas) => {
    const names = [];
    for (const [name] of entries) {
      if (!name.startsWith(CUSTOM_FIELD_PREFIX) || names.includes(name) || areas.has(name) || TRANSIENT_FIELD.test(name)) continue;
      names.push(name);
    }
    return names;
  };
  const tagsState = (form, entries) => {
    const control = optionsOf(form, TAGS_FIELD);
    if (!control || !control.multiple) return null;
    const sentinel = namedControls(form, TAGS_FIELD)
      .filter((element) => element.tagName === "INPUT" && String(element.getAttribute("type") || "").toLowerCase() === "hidden")
      .map((element) => String(element.value || ""));
    const offered = control.options.map((option) => option.value).filter((value) => value && !sentinel.includes(value));
    const selected = valuesOf(entries, TAGS_FIELD).filter((value) => value && !sentinel.includes(value));
    return { selected, available: offered.slice(0, MAX_OPTIONS), sentinel };
  };
  const settingValue = (form, entries, setting) => {
    if (setting.kind === "date") return dateValue(form, entries, setting.field, setting.optional === true);
    return currentText(entries, setting.field);
  };
  // A setting this route reports but never changes is returned with the label
  // the native control shows, so the value means something without a second
  // lookup. A control Moodle renders as a hidden field has no label.
  const readOnlySetting = (form, entries, name) => {
    const value = currentText(entries, name);
    const label = optionsOf(form, name)?.options.find((option) => option.value === value)?.label || "";
    return { value, label };
  };
  const output = (courseId, state) => {
    const { form, entries } = state;
    const present = (name) => valuesOf(entries, name).length > 0 || namedControls(form, name).length > 0;
    const settings = SETTINGS.filter((setting) => (setting.kind === "date" ? Boolean(dateControls(form, setting.field, setting.optional === true)) : present(setting.field)))
      .map((setting) => ({
        group: setting.group,
        argument: setting.argument,
        field: setting.field,
        value: settingValue(form, entries, setting),
        ...(setting.kind === "select" ? availableFor(form, setting.field) : {}),
      }));
    const optionFields = formatOptionFields(form, state.fileAreas);
    const tags = tagsState(form, entries);
    return {
      course_id: courseId,
      settings,
      format: { field: FORMAT_FIELD, value: currentText(entries, FORMAT_FIELD), ...availableFor(form, FORMAT_FIELD) },
      format_options: optionFields === null
        ? null
        : optionFields.map((name) => ({ field: name, value: currentText(entries, name), ...availableFor(form, name) })),
      tags: tags === null ? null : { selected: tags.selected, available: tags.available },
      custom_fields: customFieldNames(entries, state.fileAreas).map((name) => ({
        field: name,
        name: name.slice(CUSTOM_FIELD_PREFIX.length),
        value: currentText(entries, name),
        ...availableFor(form, name),
      })),
      // These are read here and changed elsewhere: visibility through
      // moodle_show_course and moodle_hide_course, the summary through
      // moodle_update_course_summary. A course category move is not a Morrow
      // operation.
      read_only_settings: {
        visible: readOnlySetting(form, entries, "visible"),
        category: readOnlySetting(form, entries, "category"),
      },
      file_areas: [...state.fileAreas.entries()].map(([field, fileState]) => ({ field, state: fileState })),
      protected_settings_digest: state.protectedDigest,
      protected_setting_names: state.protectedFields,
      protected_settings: state.protectedSettings,
      proof: PROOF,
    };
  };
  /**
   * `mutable` names the native controls one reviewed change is allowed to
   * write. Everything else the form carries is the protected set, so each
   * change over this one form carries its own protected digest.
   */
  const loadForm = async (context, courseId, mutable = null) => {
    const endpoint = endpointFor(context, courseId);
    const page = await readPage(context, endpoint);
    if (page.error) return { error: page.error, status: page.status };
    const form = nativeForm(page.document, endpoint);
    if (!form) return { error: "moodle_course_settings_form_invalid", status: page.status };
    const entries = entriesFor(form);
    if (!entries) return { error: "moodle_course_settings_form_invalid", status: page.status };
    const byName = (name) => valuesOf(entries, name);
    if (!one(byName("id"), courseId) || !validText(currentText(entries, FORMAT_FIELD), 100)) {
      return { error: "moodle_course_settings_form_invalid", status: page.status };
    }
    if (!one(byName("sesskey"), context.sesskey)) return { error: "moodle_form_session_mismatch", status: page.status };
    const submits = [...form.querySelectorAll(`input[type="submit"][name="${SUBMIT_FIELD}"]`)]
      .filter((control) => !control.disabled && typeof control.value === "string" && control.value && control.value.length <= 500);
    if (submits.length !== 1) return { error: "moodle_course_settings_form_invalid", status: page.status };
    const fileAreas = await inspectFileAreas(context, form, entries);
    if (!fileAreas) return { error: "moodle_course_settings_form_invalid", status: page.status };
    const snapshot = snapshotEntries(form, entries, fileAreas);
    const changeable = mutable instanceof Set ? mutable : new Set();
    const protectedEntries = snapshot.filter(([name]) => !changeable.has(name));
    // A result never carries the session key, whatever the control is called.
    if (protectedEntries.some(([, value]) => value === context.sesskey)) return { error: "moodle_course_settings_form_invalid", status: page.status };
    const identityEntries = snapshot.filter(([name]) => IDENTITY_FIELDS.has(name));
    return {
      status: page.status,
      state: {
        form,
        entries,
        fileAreas,
        action: new URL(form.getAttribute("action"), endpoint).href,
        nativeSesskey: context.sesskey,
        submit: { name: SUBMIT_FIELD, value: submits[0].value },
        format: currentText(entries, FORMAT_FIELD),
        snapshotDigest: await digest({ courseId, entries: snapshot }),
        protectedDigest: await digest({ courseId, entries: protectedEntries }),
        identityDigest: await digest({ courseId, entries: identityEntries }),
        protectedFields: [...new Set(protectedEntries.map(([name]) => name))].sort(),
        // The digest preimage, in its exact order, so a caller can recompute it.
        protectedSettings: protectedEntries.map(([name, value]) => ({ name, value })),
      },
    };
  };
  const readCourseSettings = async (context, courseId) => {
    const loaded = await loadForm(context, courseId);
    if (loaded.error) return failure(loaded.error, loaded.status);
    return { ok: true, sent: true, status: loaded.status, data: output(courseId, loaded.state), snapshot_digest: loaded.state.snapshotDigest };
  };
  /**
   * `changes` maps a native control name to the exact values one reviewed
   * change sends, or to null when the change removes the control from the body,
   * which is how a browser submits a native optional date that is switched off.
   * Every other control of the loaded form is carried through unchanged.
   */
  const postForm = async (context, courseId, state, changes) => {
    const preflight = currentContext();
    if (!sameContext(context, preflight) || state.nativeSesskey !== preflight?.sesskey) return { error: "moodle_form_session_mismatch" };
    const refusal = fileAreaRefusal(state.fileAreas);
    if (refusal) return { error: refusal };
    const body = new URLSearchParams();
    const carried = new Set();
    for (const [field, value] of state.entries) {
      if (!changes.has(field)) { body.append(field, value); continue; }
      if (carried.has(field)) continue;
      carried.add(field);
      for (const replacement of changes.get(field) || []) body.append(field, replacement);
    }
    for (const [field, values] of changes) if (!carried.has(field)) for (const value of values || []) body.append(field, value);
    body.append(state.submit.name, state.submit.value);
    let response;
    try {
      writeAttempted = true;
      response = await fetch(state.action, {
        method: "POST", credentials: "include", cache: "no-store", redirect: "manual",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "text/html" }, body,
      });
    } catch { return unconfirmedWrite("moodle_course_settings_write_unconfirmed"); }
    if (!sameContext(context, currentContext())) return unconfirmedWrite("moodle_course_settings_write_unconfirmed", response.status);
    // Chromium exposes a manual same-origin POST redirect as opaqueredirect. The
    // browser does not follow it, so Morrow never loads the course view page that
    // the native form redirects to. The fixed form endpoint and the exact
    // native-form readback below are the confirmation.
    if (response.type === "opaqueredirect") return { sent: true };
    if (![301, 302, 303, 307, 308].includes(response.status)) return unconfirmedWrite("moodle_course_settings_write_unconfirmed", response.status);
    const location = response.headers.get("location") || "";
    let redirect;
    try { redirect = new URL(location, state.action); } catch { return unconfirmedWrite("moodle_course_settings_write_unconfirmed", response.status); }
    return sameRoute(redirect.href, urlFor(context, "/course/view.php", { id: courseId }))
      ? { sent: true, status: response.status }
      : unconfirmedWrite("moodle_course_settings_write_unconfirmed", response.status);
  };
  /**
   * Turns one reviewed settings request into the exact native control values it
   * would send, or into the reason the loaded form refuses it. Every value must
   * be one the loaded control itself offers or can carry.
   */
  const settingsPlan = (state, requested) => {
    const { form } = state;
    const changes = new Map();
    const applied = [];
    for (const setting of requested) {
      if (setting.kind === "text") {
        if (!writableText(form, setting.field)) return { error: "moodle_course_setting_refused" };
        changes.set(setting.field, [setting.value]);
        applied.push({ argument: setting.argument, field: setting.field, value: setting.value });
        continue;
      }
      if (setting.kind === "select" || setting.kind === "option") {
        const value = String(setting.value);
        // A format option and a course custom field are whatever the plugin
        // declared, so each one is written through the control the loaded form
        // actually renders: one select that offers the value, or one writable
        // text box. Every fixed course setting is a native select.
        const offered = offersOption(form, setting.field, value);
        const writable = setting.kind === "option" && !optionsOf(form, setting.field)
          && writableText(form, setting.field) && (value === "" || validText(value));
        if (!offered && !writable) return { error: setting.group === "custom_fields" ? "moodle_course_custom_field_refused" : "moodle_course_setting_refused" };
        changes.set(setting.field, [value]);
        applied.push({ argument: setting.argument, field: setting.field, ...(setting.name ? { name: setting.name } : {}), value });
        continue;
      }
      if (setting.kind === "date") {
        const controls = dateControls(form, setting.field, setting.optional === true);
        if (!controls) return { error: "moodle_course_setting_refused" };
        if (setting.value === null) {
          changes.set(`${setting.field}[enabled]`, null);
          applied.push({ argument: setting.argument, field: setting.field, value: null });
          continue;
        }
        for (const component of DATE_COMPONENTS) {
          const value = String(setting.value[component]);
          if (!offersOption(form, `${setting.field}[${component}]`, value)) return { error: "moodle_course_setting_refused" };
          changes.set(`${setting.field}[${component}]`, [value]);
        }
        if (controls.toggle) changes.set(`${setting.field}[enabled]`, ["1"]);
        applied.push({ argument: setting.argument, field: setting.field, value: setting.value });
        continue;
      }
      const tags = setting.kind === "tags" ? tagsState(form, state.entries) : null;
      if (!tags) return { error: "moodle_course_setting_refused" };
      // The native tags control offers the tags this site allows here. Morrow
      // applies and removes those; it does not create a tag the control does
      // not already offer.
      if (setting.value.some((tag) => !tags.available.includes(tag))) return { error: "moodle_course_tag_refused" };
      changes.set(TAGS_FIELD, [...tags.sentinel, ...setting.value]);
      applied.push({ argument: setting.argument, field: TAGS_FIELD, value: setting.value });
    }
    return { changes, applied };
  };
  const savedSettings = (state, applied) => {
    const { form, entries } = state;
    const saved = [];
    for (const entry of applied) {
      const setting = SETTINGS.find((candidate) => candidate.field === entry.field);
      if (entry.field === TAGS_FIELD) {
        const tags = tagsState(form, entries);
        if (!tags || stable([...tags.selected].sort()) !== stable([...entry.value].sort())) return null;
        saved.push({ argument: entry.argument, field: entry.field, value: tags.selected });
        continue;
      }
      if (setting?.kind === "date") {
        const value = dateValue(form, entries, entry.field, setting.optional === true);
        if (stable(value) !== stable(entry.value)) return null;
        saved.push({ argument: entry.argument, field: entry.field, value });
        continue;
      }
      const value = currentText(entries, entry.field);
      if (value !== String(entry.value)) return null;
      saved.push({ argument: entry.argument, field: entry.field, ...(entry.name ? { name: entry.name } : {}), value });
    }
    return saved;
  };
  const mutableFields = (requested) => {
    const fields = new Set();
    for (const setting of requested) {
      if (setting.kind !== "date") { fields.add(setting.field); continue; }
      fields.add(`${setting.field}[enabled]`);
      for (const component of DATE_COMPONENTS) fields.add(`${setting.field}[${component}]`);
    }
    return fields;
  };
  const runSettingsWrite = async (context, args) => {
    const mutable = mutableFields(args.requested);
    // One load, immediately before the one POST: the reviewed digest is checked
    // against the exact form this change carries and sends.
    const loaded = await loadForm(context, args.courseId, mutable);
    if (loaded.error) return failure(loaded.error, loaded.status);
    if (loaded.state.snapshotDigest !== args.expectedDigest) return failure("moodle_expected_digest_mismatch", loaded.status);
    const refusal = fileAreaRefusal(loaded.state.fileAreas);
    if (refusal) return failure(refusal, loaded.status);
    const plan = settingsPlan(loaded.state, args.requested);
    if (plan.error) return failure(plan.error, loaded.status);
    const posted = await postForm(context, args.courseId, loaded.state, plan.changes);
    if (posted.error) return posted.sent === true ? posted : failure(posted.error, posted.status);
    const after = await loadForm(context, args.courseId, mutable);
    if (after.error) return unconfirmedWrite("moodle_course_settings_readback_unconfirmed", posted.status);
    const saved = savedSettings(after.state, plan.applied);
    if (!saved || after.state.protectedDigest !== loaded.state.protectedDigest) {
      return unconfirmedWrite("moodle_course_settings_write_not_verified", posted.status);
    }
    return {
      ok: true,
      sent: true,
      status: posted.status ?? after.status,
      data: { ...output(args.courseId, after.state), changed_settings: saved },
      snapshot_digest: after.state.snapshotDigest,
      verification: { schema: "morrow.browser-verification.v1", status: "verified" },
    };
  };
  /**
   * The complete course state: the course, every section and every activity, as
   * Moodle's own course-format state reader returns them. It saves no course or
   * learner state. Source:
   * https://github.com/moodle/moodle/blob/v5.2.2/public/course/format/classes/external/get_state.php
   */
  const courseState = async (context, courseId) => {
    let response;
    try {
      response = await fetch(urlFor(context, "/lib/ajax/service.php", { sesskey: context.sesskey, info: "core_courseformat_get_state" }), {
        method: "POST", credentials: "include", cache: "no-store",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify([{ index: 0, methodname: "core_courseformat_get_state", args: { courseid: Number(courseId) } }]),
      });
    } catch { return { error: "moodle_course_state_unavailable" }; }
    let payload;
    try { payload = JSON.parse(await response.text()); } catch { return { error: "moodle_course_state_unavailable", status: response.status }; }
    const entry = Array.isArray(payload) && payload.length === 1 && object(payload[0]) ? payload[0] : null;
    if (!response.ok || !entry || entry.error || entry.exception || typeof entry.data !== "string") {
      return { error: "moodle_course_state_unavailable", status: response.status };
    }
    let value;
    try { value = JSON.parse(entry.data); } catch { return { error: "moodle_course_state_unavailable", status: response.status }; }
    if (!object(value) || !object(value.course) || id(value.course.id) !== courseId
      || !Array.isArray(value.section) || !Array.isArray(value.cm)) return { error: "moodle_course_state_unavailable", status: response.status };
    if (value.section.length > MAX_STATE_ROWS || value.cm.length > MAX_STATE_ROWS) return { error: "moodle_course_state_incomplete", status: response.status };
    const data = {
      course: sanitize(value.course),
      sections: value.section.map((section) => sanitize(section)),
      activities: value.cm.map((activity) => sanitize(activity)),
    };
    return { data, digest: await digest(data) };
  };
  const runFormatChange = async (context, args) => {
    if (!args.acknowledged) return failure("moodle_course_format_approval_required");
    // The complete placement this change is about to move, read before anything
    // is loaded or sent.
    const before = await courseState(context, args.courseId);
    if (before.error) return failure(before.error, before.status);
    const mutable = new Set([FORMAT_FIELD]);
    const loaded = await loadForm(context, args.courseId, mutable);
    if (loaded.error) return failure(loaded.error, loaded.status);
    if (loaded.state.snapshotDigest !== args.expectedDigest) return failure("moodle_expected_digest_mismatch", loaded.status);
    if (loaded.state.format === args.format) return failure("moodle_course_format_unchanged", loaded.status);
    if (!offersOption(loaded.state.form, FORMAT_FIELD, args.format)) return failure("moodle_course_format_refused", loaded.status);
    const refusal = fileAreaRefusal(loaded.state.fileAreas);
    if (refusal) return failure(refusal, loaded.status);
    const posted = await postForm(context, args.courseId, loaded.state, new Map([[FORMAT_FIELD, [args.format]]]));
    if (posted.error) return posted.sent === true ? posted : failure(posted.error, posted.status);
    const after = await loadForm(context, args.courseId, mutable);
    if (after.error) return unconfirmedWrite("moodle_course_settings_readback_unconfirmed", posted.status);
    // The new format brings its own option controls, so the whole-form
    // protected digest cannot apply. These are the course settings a format
    // change must leave exactly as they were.
    if (after.state.format !== args.format || after.state.identityDigest !== loaded.state.identityDigest) {
      return unconfirmedWrite("moodle_course_settings_write_not_verified", posted.status);
    }
    const afterState = await courseState(context, args.courseId);
    if (afterState.error) return unconfirmedWrite("moodle_course_state_readback_unconfirmed", posted.status);
    return {
      ok: true,
      sent: true,
      status: posted.status ?? after.status,
      data: {
        ...output(args.courseId, after.state),
        format_before: loaded.state.format,
        format_after: after.state.format,
        course_state_before: before.data,
        course_state_after: afterState.data,
        course_state_changed: before.digest !== afterState.digest,
      },
      snapshot_digest: after.state.snapshotDigest,
      verification: { schema: "morrow.browser-verification.v1", status: "verified" },
    };
  };
  let writeAttempted = false;
  try {
    const context = currentContext();
    if (input?.mode !== "execute" || !context) return failure("moodle_session_unavailable");
    if (!Number.isFinite(input.expiresAt) || Date.now() >= input.expiresAt) return failure("moodle_execution_expired");
    const definition = expectedOperation(input.operation);
    if (!definition) return failure("moodle_operation_refused");
    if (!bindingValid(context, input.binding)) return failure("moodle_binding_mismatch");
    const args = argumentsFor(definition, input.arguments, input.binding);
    if (!args) return failure("moodle_course_settings_arguments_invalid");
    if (definition.kind === "read") return await readCourseSettings(context, args.courseId);
    return definition.kind === "format" ? await runFormatChange(context, args) : await runSettingsWrite(context, args);
  } catch (error) {
    if (writeAttempted) return unconfirmedWrite("moodle_course_settings_write_unconfirmed");
    return failure(String(error?.message || error).startsWith("moodle_") ? String(error.message) : "moodle_course_settings_execution_failed");
  }
}
