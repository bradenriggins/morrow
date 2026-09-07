/**
 * Reads and changes activity completion for one activity, and course completion
 * for one course, through the two native Moodle forms that own them.
 *
 * Activity completion lives in the Activity completion section of the native
 * activity settings form, `public/course/modedit.php`. Moodle builds that
 * section in `core_completion\form\form_trait::add_completion_elements`, so its
 * controls are the tracking mode, the view and grade conditions, the conditions
 * the module type declares for itself, and the expected completion date.
 * https://github.com/moodle/moodle/blob/v5.2.2/public/completion/classes/form/form_trait.php
 * https://github.com/moodle/moodle/blob/v5.2.2/public/course/moodleform_mod.php
 *
 * Course completion lives on `public/course/completion.php`, whose form is
 * `public/course/completion_form.php`. One POST of that form deletes every
 * existing course completion criterion and writes back exactly what the body
 * carries, so a change must send the complete condition set. Morrow does that
 * by carrying every control of the loaded form through unchanged and replacing
 * only the controls the approved change names.
 * https://github.com/moodle/moodle/blob/v5.2.2/public/course/completion.php
 * https://github.com/moodle/moodle/blob/v5.2.2/public/course/completion_form.php
 *
 * Three facts shape every operation here.
 *
 * 1. A completion condition change is retroactive. Moodle re-evaluates the
 *    condition set for everyone the course tracks, so a saved change can mark
 *    enrolled learners complete or incomplete without anyone opening the
 *    activity. Every change therefore states the number of enrolled
 *    participants in the course, and refuses when Morrow cannot establish that
 *    number or when it is no longer the number that was approved.
 * 2. Reading must not cause completion. Moodle can record a completion, an
 *    attendance or a launch from an activity view, so nothing here opens
 *    `view.php` for any module or for the course. Both reads use the native
 *    settings form, and both writes send one POST to that same form and never
 *    follow the redirect Moodle answers with.
 * 3. Moodle locks completion settings once learner completion data exists. The
 *    native form then freezes its completion controls and offers an unlock
 *    button, and pressing it deletes or recalculates the completion data that
 *    already exists. Morrow never presses it: a locked form is reported as
 *    locked, and a change against it is refused before anything is sent.
 *
 * Chrome serializes this function for a MAIN-world injection. Keep every
 * dependency inside the function body.
 */
export async function executeMoodleCompletionInPage(rawInput) {
  const PROVIDER = "moodle";
  const MAX_FORM_ENTRIES = 600;
  // An activity settings form carries the activity description, so it needs the
  // same byte bound the course settings form does.
  const MAX_FORM_BYTES = 512 * 1024;
  const MAX_VALUE_BYTES = 64 * 1024;
  const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
  const MAX_OPTIONS = 300;
  const MAX_FILE_AREAS = 20;
  const MAX_CONDITIONS = 200;
  const MAX_CHANGE_ROWS = 50;
  const MAX_TEXT = 255;
  const MAX_LABEL = 200;
  const MAX_PARTICIPANTS = 10_000_000;
  const ID = /^[1-9][0-9]{0,18}$/;
  const DIGEST = /^[a-f0-9]{64}$/;
  const COUNT = /^(?:0|[1-9][0-9]{0,6})$/;
  const CONDITION_NAME = /^[A-Za-z][A-Za-z0-9_]{0,99}(?:\[[A-Za-z0-9_-]{1,50}\])?$/;
  const DATE_COMPONENTS = ["year", "month", "day", "hour", "minute"];
  const REQUIRED_DATE_COMPONENTS = ["year", "month", "day"];
  // A draft item id, a session key and mform's own state fields change on every
  // load of the same form, so they are never part of a digest or a result.
  const TRANSIENT_FIELD = /(?:sesskey|statekey|_qf__|csrf|token|secret|password|authorization|cookie|(?:^|[\[_-])(?:draft|itemid)(?:$|[\]_-]))/i;
  const RESERVED_PREFIX = /^(?:mform_isexpanded|checkbox_controller)/;
  const NON_VALUE_INPUT = new Set(["submit", "button", "reset", "image", "file"]);
  // Moodle's own participants table. Its wrapper declares the exact number of
  // enrolled participants in the course, which is the number a completion
  // condition change reaches. Only that number leaves this function; the row
  // markup the table returns stays in the page.
  // https://github.com/moodle/moodle/blob/v5.2.2/public/user/classes/table/participants.php
  const PARTICIPANTS_METHOD = "core_table_get_dynamic_table_content";
  const PARTICIPANTS_CAPABILITY = "moodle/course:viewparticipants";
  const definitions = Object.freeze({
    "moodle.form.course.modedit.completion.read.v1": { toolName: "moodle_get_activity_completion", readOnly: true, kind: "read", route: "activity" },
    "moodle.form.course.modedit.completion.write.v1": { toolName: "moodle_update_activity_completion", readOnly: false, kind: "write", route: "activity" },
    "moodle.form.course.completion.read.v1": { toolName: "moodle_get_course_completion", readOnly: true, kind: "read", route: "course" },
    "moodle.form.course.completion.write.v1": { toolName: "moodle_update_course_completion", readOnly: false, kind: "write", route: "course" },
  });
  const ROUTES = Object.freeze({
    activity: Object.freeze({
      name: "activity",
      prefix: "moodle_activity_completion",
      path: "/course/modedit.php",
      capability: "moodle/course:manageactivities",
      scope: "activity_completion_only",
      // Save and return to the course. The other native submit, `submitbutton`,
      // redirects to the activity's own view page, which Moodle can treat as a
      // learner-visible view.
      submitField: "submitbutton2",
      section: "fieldset#id_activitycompletionheader",
      trackingField: "completion",
      dateArgument: "completion_expected",
      dateField: "completionexpected",
      dateOptional: true,
      lockSubmit: "unlockcompletion",
      lockFlag: "completionunlocked",
      reserved: Object.freeze(["completion", "completionunlocked", "unlockcompletion", "coursecontentnotification"]),
      // Moodle hides a grade condition while its own checkbox is off, so the
      // hidden value is not part of the saved condition set.
      governors: Object.freeze({ completionpassgrade: "completionusegrade", completiongradeitemnumber: "completionusegrade" }),
      readOnlyPrefixes: Object.freeze([]),
      // The native "Send content change notification" checkbox mails every
      // enrolled learner. Morrow never sends it.
      neverSend: Object.freeze(["coursecontentnotification"]),
    }),
    course: Object.freeze({
      name: "course",
      prefix: "moodle_course_completion",
      path: "/course/completion.php",
      capability: "moodle/course:update",
      scope: "course_completion_only",
      submitField: "submitbutton",
      section: "",
      trackingField: "",
      dateArgument: "completion_date",
      dateField: "criteria_date_value",
      dateOptional: false,
      lockSubmit: "settingsunlock",
      lockFlag: "",
      reserved: Object.freeze(["id", "submitbutton", "cancel", "settingsunlock"]),
      // completion_criteria_date.php, completion_criteria_duration.php and
      // completion_criteria_grade.php each disable their value control while
      // their own checkbox is off, and Moodle re-defaults an unused completion
      // date on every load, so an inactive value is not saved state.
      governors: Object.freeze({ criteria_date_value: "criteria_date", criteria_duration_days: "criteria_duration", criteria_grade_value: "criteria_grade" }),
      // Prerequisite courses name other courses, which is outside the exact
      // course this operation is bound to. They are reported and carried
      // through, never changed.
      readOnlyPrefixes: Object.freeze(["criteria_course"]),
      neverSend: Object.freeze([]),
    }),
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
  const label = (value) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_LABEL);
  const validText = (value, maximum = MAX_TEXT) => typeof value === "string" && value.length > 0 && value.length <= maximum
    && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
  const validOptionalText = (value, maximum = MAX_TEXT) => value === "" || validText(value, maximum);
  const stable = (value) => {
    if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
    if (object(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
    return JSON.stringify(value === undefined ? null : value);
  };
  const digest = async (value) => {
    if (!globalThis.crypto?.subtle || typeof globalThis.TextEncoder !== "function") throw new Error("moodle_completion_digest_unavailable");
    const bytes = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(stable(value)));
    return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
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
  const sameRoute = (value, expected) => {
    let received;
    try { received = new URL(value); } catch { return false; }
    if (received.origin !== expected.origin || received.pathname !== expected.pathname || received.hash
      || received.username || received.password) return false;
    const sort = (url) => [...url.searchParams.entries()]
      .sort(([leftName, leftValue], [rightName, rightValue]) => leftName.localeCompare(rightName) || leftValue.localeCompare(rightValue));
    return stable(sort(received)) === stable(sort(expected));
  };
  // The native form answers a saved change with a redirect to the course page.
  // Morrow never follows it, and it never opens an activity view page, so the
  // redirect target is checked and discarded.
  const courseRedirect = (context, courseId, value, base) => {
    let received;
    try { received = new URL(value, base); } catch { return false; }
    const expected = urlFor(context, "/course/view.php", { id: courseId });
    return received.origin === expected.origin && received.pathname === expected.pathname
      && received.searchParams.get("id") === courseId;
  };
  const validDate = (value) => {
    if (!object(value)) return false;
    const keys = Object.keys(value);
    if (keys.length < REQUIRED_DATE_COMPONENTS.length || keys.length > DATE_COMPONENTS.length) return false;
    if (!REQUIRED_DATE_COMPONENTS.every((key) => keys.includes(key)) || !keys.every((key) => DATE_COMPONENTS.includes(key))) return false;
    if (!keys.every((key) => Number.isSafeInteger(value[key]))) return false;
    const { year, month, day } = value;
    const hour = value.hour ?? 0;
    const minute = value.minute ?? 0;
    if (year < 1970 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31 || hour < 0 || hour > 23 || minute < 0 || minute > 59) return false;
    const date = new Date(Date.UTC(year, month - 1, day, hour, minute));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  };
  const readPage = async (context, endpoint, prefix) => {
    let response;
    try {
      response = await fetch(endpoint, { method: "GET", credentials: "include", cache: "no-store", redirect: "error", headers: { Accept: "text/html" } });
    } catch { return { error: `${prefix}_read_unavailable` }; }
    if (!response.ok || !sameRoute(response.url, endpoint) || !sameContext(context, currentContext())) {
      return { error: `${prefix}_read_unavailable`, status: response.status };
    }
    let html;
    try { html = await response.text(); } catch { return { error: `${prefix}_read_unavailable`, status: response.status }; }
    if (typeof html !== "string" || html.length > MAX_RESPONSE_BYTES || typeof globalThis.DOMParser !== "function") {
      return { error: `${prefix}_read_unavailable`, status: response.status };
    }
    try { return { status: response.status, document: new DOMParser().parseFromString(html, "text/html") }; }
    catch { return { error: `${prefix}_read_unavailable`, status: response.status }; }
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
  const submitControls = (form, name) => [...form.querySelectorAll('input[type="submit"]')]
    .filter((control) => control.getAttribute("name") === name && !control.disabled
      && typeof control.value === "string" && control.value && control.value.length <= 500);
  const valuesOf = (entries, name) => entries.filter(([field]) => field === name).map(([, value]) => value);
  const currentText = (entries, name) => {
    const values = valuesOf(entries, name);
    return values.length ? values[values.length - 1] : "";
  };
  const labelFor = (form, element) => {
    const elementId = String(element.getAttribute("id") || "");
    if (!elementId) return "";
    const node = [...form.querySelectorAll("label[for]")].find((candidate) => candidate.getAttribute("for") === elementId);
    return node ? label(node.textContent) : "";
  };
  /**
   * What the loaded form renders for one native control name. A control Moodle
   * has frozen renders as static text beside a hidden field of the same name,
   * so it is reported as frozen and never written.
   */
  const controlOf = (form, name) => {
    const controls = namedControls(form, name);
    if (!controls.length) return null;
    const selects = controls.filter((control) => control.tagName === "SELECT");
    if (selects.length === 1 && controls.length === 1) {
      const select = selects[0];
      if (select.disabled || select.multiple) return { kind: "unsupported", writable: false };
      const options = [...select.options].map((option) => ({ value: String(option.value ?? ""), label: label(option.textContent) }));
      return { kind: "select", options, writable: true };
    }
    if (selects.length) return { kind: "unsupported", writable: false };
    const inputs = controls.filter((control) => control.tagName === "INPUT");
    if (inputs.length !== controls.length) return { kind: "unsupported", writable: false };
    const typeOf = (control) => String(control.getAttribute("type") || "text").toLowerCase();
    const radios = inputs.filter((control) => typeOf(control) === "radio");
    if (radios.length > 1 && radios.length === inputs.length) {
      if (radios.some((control) => control.disabled)) return { kind: "unsupported", writable: false };
      return { kind: "radio", options: radios.map((control) => ({ value: String(control.value ?? ""), label: labelFor(form, control) })), writable: true };
    }
    const boxes = inputs.filter((control) => typeOf(control) === "checkbox");
    const hidden = inputs.filter((control) => typeOf(control) === "hidden");
    // A native advanced checkbox renders a hidden off value before the box, so
    // the browser always submits the off value and adds the on value when the
    // box is checked.
    if (boxes.length === 1 && hidden.length <= 1 && boxes.length + hidden.length === inputs.length) {
      if (boxes[0].disabled) return { kind: "unsupported", writable: false };
      return {
        kind: "checkbox",
        onValue: String(boxes[0].value ?? "") || "1",
        offValue: hidden.length === 1 ? String(hidden[0].value ?? "") : null,
        label: labelFor(form, boxes[0]),
        writable: true,
      };
    }
    if (hidden.length === inputs.length) return { kind: "frozen", writable: false };
    const texts = inputs.filter((control) => ["text", "number"].includes(typeOf(control)));
    if (texts.length === 1 && inputs.length === 1) {
      return { kind: "text", writable: !texts[0].disabled && !texts[0].readOnly };
    }
    return { kind: "unsupported", writable: false };
  };
  const controlOn = (entries, name, control) => {
    if (!control || control.kind !== "checkbox") return false;
    return control.offValue === null ? valuesOf(entries, name).length > 0 : currentText(entries, name) !== control.offValue;
  };
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
  // One POST of a native form carries a new draft area for every file area on
  // it, so a change is refused while any of them holds a file, and while any of
  // them cannot be proved empty.
  const fileAreaRefusal = (areas, prefix) => {
    for (const state of areas.values()) if (state === "nonempty") return `${prefix}_files_present`;
    return [...areas.values()].every((state) => state === "empty") ? "" : `${prefix}_files_unverified`;
  };
  const dateControls = (form, field, optional) => {
    const components = [];
    for (const component of DATE_COMPONENTS) {
      const control = controlOf(form, `${field}[${component}]`);
      if (!control) {
        if (REQUIRED_DATE_COMPONENTS.includes(component)) return null;
        continue;
      }
      if (control.kind !== "select") return null;
      components.push(component);
    }
    if (!optional) return { components, toggle: null };
    const toggles = namedControls(form, `${field}[enabled]`)
      .filter((control) => control.tagName === "INPUT" && String(control.getAttribute("type") || "").toLowerCase() === "checkbox");
    return toggles.length === 1 && !toggles[0].disabled && toggles[0].value === "1" ? { components, toggle: toggles[0] } : null;
  };
  const dateValueOf = (form, entries, route) => {
    const controls = dateControls(form, route.dateField, route.dateOptional);
    if (!controls) return null;
    if (controls.toggle && !controls.toggle.checked) return null;
    const value = {};
    for (const component of controls.components) value[component] = Number(currentText(entries, `${route.dateField}[${component}]`));
    return validDate(value) ? value : null;
  };
  const offersOption = (form, name, value) => {
    const control = controlOf(form, name);
    return Boolean(control) && Array.isArray(control.options) && control.options.some((option) => option.value === value);
  };
  const availableFor = (control) => {
    if (!Array.isArray(control?.options)) return {};
    return control.options.length > MAX_OPTIONS ? { available_count: control.options.length } : { available: control.options };
  };
  /**
   * The completion condition controls the loaded form renders, in the order the
   * form renders them. The tracking mode, the expected date, the prerequisite
   * courses and every non-value control are named separately, so they are not
   * part of this list.
   */
  const conditionNames = (form, route, areas) => {
    const root = route.section ? form.querySelector(route.section) : form;
    // The activity settings form carries a completion section only while the
    // course has completion tracking switched on. A form with more completion
    // controls than this route reads is a form Morrow does not understand, and
    // that is a different fact from a course that tracks no completion.
    if (!root) return { absent: true };
    const names = [];
    for (const control of root.querySelectorAll("[name]")) {
      const name = String(control.getAttribute("name") || "");
      if (!name || names.includes(name) || route.reserved.includes(name) || route.neverSend.includes(name)) continue;
      if (TRANSIENT_FIELD.test(name) || RESERVED_PREFIX.test(name) || areas.has(name)) continue;
      if (name === route.dateField || name.startsWith(`${route.dateField}[`)) continue;
      if (route.readOnlyPrefixes.some((prefix) => name === prefix || name.startsWith(`${prefix}[`))) continue;
      if (control.tagName === "INPUT" && NON_VALUE_INPUT.has(String(control.getAttribute("type") || "text").toLowerCase())) continue;
      names.push(name);
      if (names.length > MAX_CONDITIONS) return { bounded: true };
    }
    return { names };
  };
  const conditionRow = (form, entries, route, name) => {
    const control = controlOf(form, name);
    if (!control) return null;
    const governor = route.governors[name] || "";
    const active = governor ? controlOn(entries, governor, controlOf(form, governor)) : true;
    return {
      field: name,
      kind: control.kind,
      value: control.kind === "checkbox" ? controlOn(entries, name, control) : currentText(entries, name),
      ...(control.kind === "checkbox" && control.label ? { label: control.label } : {}),
      ...availableFor(control),
      ...(governor ? { governed_by: governor, active } : {}),
    };
  };
  /**
   * The canonical value of every completion control on one loaded form, which
   * is what a saved change is compared against.
   */
  const conditionValues = (state) => {
    const { form, entries, route } = state;
    const values = {};
    if (route.trackingField) values[route.trackingField] = currentText(entries, route.trackingField);
    for (const name of state.conditionNames) {
      const control = controlOf(form, name);
      values[name] = control?.kind === "checkbox" ? (controlOn(entries, name, control) ? "1" : "0") : currentText(entries, name);
    }
    values[route.dateField] = stable(state.dateValue);
    return values;
  };
  // A value control whose own checkbox is off is `inactive`: Moodle neither
  // saves it nor keeps it stable across loads, so it is not compared.
  const maskInactive = (values, route) => {
    const masked = { ...values };
    for (const [field, governor] of Object.entries(route.governors)) {
      if (!Object.hasOwn(masked, field)) continue;
      if (masked[governor] === "1") continue;
      masked[field] = "inactive";
    }
    return masked;
  };
  const validSelectValue = (value) => (typeof value === "number" && Number.isSafeInteger(value)) || validOptionalText(value, 128);
  const validConditionRows = (value) => Array.isArray(value) && value.length > 0 && value.length <= MAX_CHANGE_ROWS
    && value.every((entry) => object(entry) && Object.keys(entry).length === 2 && Object.hasOwn(entry, "name") && Object.hasOwn(entry, "value")
      && typeof entry.name === "string" && CONDITION_NAME.test(entry.name)
      && (typeof entry.value === "boolean" || validSelectValue(entry.value)))
    && new Set(value.map((entry) => entry.name)).size === value.length;
  const changeArgumentsFor = (route, args, courseId, moduleId) => {
    const allowed = new Set(["course_id", "conditions", route.dateArgument, "acknowledge_participant_count", "expected_digest",
      ...(route.name === "activity" ? ["module_id", "completion_tracking"] : [])]);
    if (!object(args) || Object.keys(args).some((key) => !allowed.has(key))) return null;
    if (id(args.course_id) !== courseId || !DIGEST.test(String(args.expected_digest || ""))) return null;
    if (route.name === "activity" && id(args.module_id) !== moduleId) return null;
    if (!Number.isSafeInteger(args.acknowledge_participant_count) || args.acknowledge_participant_count < 0
      || args.acknowledge_participant_count > MAX_PARTICIPANTS) return null;
    const requested = [];
    if (args.completion_tracking !== undefined) {
      if (!Number.isSafeInteger(args.completion_tracking) || args.completion_tracking < 0 || args.completion_tracking > 1_000_000_000) return null;
      requested.push({ argument: "completion_tracking", field: route.trackingField, kind: "tracking", value: String(args.completion_tracking) });
    }
    if (args.conditions !== undefined) {
      if (!validConditionRows(args.conditions)) return null;
      for (const entry of args.conditions) {
        if (route.reserved.includes(entry.name) || route.neverSend.includes(entry.name)) return null;
        requested.push({ argument: "conditions", field: entry.name, kind: "condition", value: entry.value });
      }
    }
    if (args[route.dateArgument] !== undefined) {
      const value = args[route.dateArgument];
      if (!(validDate(value) || (route.dateOptional && value === null))) return null;
      requested.push({ argument: route.dateArgument, field: route.dateField, kind: "date", value });
    }
    return requested.length
      ? { courseId, moduleId, expectedDigest: args.expected_digest, acknowledgedParticipants: args.acknowledge_participant_count, requested }
      : null;
  };
  const argumentsFor = (definition, route, args, binding) => {
    const courseId = id(binding?.courseId);
    if (!courseId) return null;
    const moduleId = route.name === "activity" ? id(args?.module_id) : "";
    if (route.name === "activity" && !moduleId) return null;
    if (definition.kind === "read") {
      const expected = route.name === "activity" ? ["course_id", "module_id"] : ["course_id"];
      return object(args) && Object.keys(args).length === expected.length && expected.every((key) => Object.hasOwn(args, key))
        && id(args.course_id) === courseId ? { courseId, moduleId } : null;
    }
    return changeArgumentsFor(route, args, courseId, moduleId);
  };
  const endpointFor = (context, route, courseId, moduleId) => (route.name === "activity"
    ? urlFor(context, route.path, { update: moduleId, return: 0 })
    : urlFor(context, route.path, { id: courseId }));
  /**
   * The number of enrolled participants in the exact course, read from the
   * declared total of Moodle's own participants table. Only the number leaves
   * this function.
   */
  const enrolledParticipants = async (context, courseId) => {
    let response;
    try {
      response = await fetch(urlFor(context, "/lib/ajax/service.php", { sesskey: context.sesskey, info: PARTICIPANTS_METHOD }), {
        method: "POST", credentials: "include", cache: "no-store",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify([{
          index: 0,
          methodname: PARTICIPANTS_METHOD,
          args: {
            component: "core_user",
            handler: "participants",
            uniqueid: `user-index-participants-${courseId}`,
            sortdata: [{ sortby: "lastname", sortorder: 4 }],
            filters: [{ name: "courseid", jointype: 1, values: [Number(courseId)] }],
            jointype: 1,
            firstinitial: "",
            lastinitial: "",
            pagenumber: 1,
            pagesize: 1,
            hiddencolumns: [],
            resetpreferences: false,
          },
        }]),
      });
    } catch { return null; }
    if (!response.ok) return null;
    let raw;
    try { raw = await response.text(); } catch { return null; }
    if (typeof raw !== "string" || raw.length > MAX_RESPONSE_BYTES || typeof globalThis.DOMParser !== "function") return null;
    let html;
    try {
      const payload = JSON.parse(raw);
      const entry = Array.isArray(payload) && payload.length === 1 && object(payload[0]) ? payload[0] : null;
      if (!entry || entry.error || entry.exception) return null;
      const data = typeof entry.data === "string" ? JSON.parse(entry.data) : entry.data;
      if (!object(data) || typeof data.html !== "string") return null;
      html = data.html;
    } catch { return null; }
    let documentValue;
    try { documentValue = new DOMParser().parseFromString(html, "text/html"); } catch { return null; }
    const wrappers = [...documentValue.querySelectorAll('div[data-region="core_table/dynamic"]')].filter((node) => (
      node.getAttribute("data-table-component") === "core_user"
      && node.getAttribute("data-table-handler") === "participants"
      && node.getAttribute("data-table-uniqueid") === `user-index-participants-${courseId}`
    ));
    if (wrappers.length !== 1) return null;
    const declared = wrappers[0].getAttribute("data-table-total-rows") || "";
    return COUNT.test(declared) ? Number(declared) : null;
  };
  /**
   * The digest preimage. A native optional date that is switched off still
   * renders its components, and Moodle ignores them, so an off date is recorded
   * as the toggle alone. The route's own date control is left out while its
   * checkbox is off for the same reason: Moodle re-defaults an unused course
   * completion date to tomorrow on every load.
   */
  const snapshotEntries = (form, entries, areas, route) => {
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
    const dateGovernor = route.governors[route.dateField] || "";
    if (dateGovernor && !controlOn(entries, dateGovernor, controlOf(form, dateGovernor))) {
      ignored.add(route.dateField);
      for (const component of DATE_COMPONENTS) ignored.add(`${route.dateField}[${component}]`);
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
  /**
   * `mutable` names the native controls one reviewed change is allowed to
   * write. Everything else the form carries is the protected set.
   */
  const loadForm = async (context, route, courseId, moduleId, mutable = null) => {
    const prefix = route.prefix;
    const endpoint = endpointFor(context, route, courseId, moduleId);
    const page = await readPage(context, endpoint, prefix);
    if (page.error) return { error: page.error, status: page.status };
    const form = nativeForm(page.document, endpoint);
    if (!form) return { error: `${prefix}_form_invalid`, status: page.status };
    const entries = entriesFor(form);
    if (!entries) return { error: `${prefix}_form_invalid`, status: page.status };
    if (route.name === "activity") {
      if (!one(valuesOf(entries, "update"), moduleId) || !one(valuesOf(entries, "coursemodule"), moduleId)
        || !one(valuesOf(entries, "course"), courseId) || !validText(currentText(entries, "modulename"), 100)) {
        return { error: `${prefix}_form_invalid`, status: page.status };
      }
    } else if (!one(valuesOf(entries, "id"), courseId)) {
      return { error: `${prefix}_form_invalid`, status: page.status };
    }
    if (!one(valuesOf(entries, "sesskey"), context.sesskey)) return { error: "moodle_form_session_mismatch", status: page.status };
    const submits = submitControls(form, route.submitField);
    if (submits.length !== 1) return { error: `${prefix}_form_invalid`, status: page.status };
    const fileAreas = await inspectFileAreas(context, form, entries);
    if (!fileAreas) return { error: `${prefix}_form_invalid`, status: page.status };
    const found = conditionNames(form, route, fileAreas);
    if (found.bounded) return { error: `${prefix}_form_invalid`, status: page.status };
    const snapshot = snapshotEntries(form, entries, fileAreas, route);
    const changeable = mutable instanceof Set ? mutable : new Set();
    const protectedEntries = snapshot.filter(([name]) => !changeable.has(name));
    // A result never carries the session key, whatever the control is called.
    if (protectedEntries.some(([, value]) => value === context.sesskey)) return { error: `${prefix}_form_invalid`, status: page.status };
    const state = {
      form,
      entries,
      route,
      fileAreas,
      available: found.absent !== true,
      locked: submitControls(form, route.lockSubmit).length > 0
        || (route.lockFlag ? currentText(entries, route.lockFlag) !== "1" : false),
      conditionNames: found.names || [],
      dateValue: found.absent === true ? null : dateValueOf(form, entries, route),
      moduleType: route.name === "activity" ? currentText(entries, "modulename") : "",
      activityName: route.name === "activity" ? label(currentText(entries, "name")) : "",
      action: new URL(form.getAttribute("action"), endpoint).href,
      nativeSesskey: context.sesskey,
      submit: { name: route.submitField, value: submits[0].value },
      protectedDigest: await digest({ courseId, moduleId, entries: protectedEntries }),
      protectedFields: [...new Set(protectedEntries.map(([name]) => name))].sort(),
      // The digest preimage, in its exact order, so a caller can recompute it.
      protectedSettings: protectedEntries.map(([name, value]) => ({ name, value })),
      snapshotDigest: await digest({ courseId, moduleId, entries: snapshot }),
    };
    return { status: page.status, state };
  };
  const output = (courseId, moduleId, state, participants) => {
    const { form, entries, route } = state;
    const trackingControl = route.trackingField ? controlOf(form, route.trackingField) : null;
    const readOnly = [];
    for (const [name] of entries) {
      if (!route.readOnlyPrefixes.some((prefix) => name === prefix || name.startsWith(`${prefix}[`))) continue;
      if (readOnly.some((row) => row.field === name)) continue;
      readOnly.push({ field: name, values: valuesOf(entries, name) });
    }
    return {
      course_id: courseId,
      ...(route.name === "activity" ? { module_id: moduleId, module_type: state.moduleType, activity_name: state.activityName } : {}),
      completion_available: state.available,
      settings_locked: state.locked,
      ...(trackingControl
        ? { completion_tracking: { field: route.trackingField, value: currentText(entries, route.trackingField), ...availableFor(trackingControl) } }
        : {}),
      conditions: state.conditionNames.map((name) => conditionRow(form, entries, route, name)).filter(Boolean),
      [route.dateArgument]: { field: route.dateField, value: state.dateValue },
      read_only_conditions: readOnly,
      enrolled_participants: participants === null ? null : { count: participants, source: "participants_table" },
      file_areas: [...state.fileAreas.entries()].map(([field, fileState]) => ({ field, state: fileState })),
      protected_settings_digest: state.protectedDigest,
      protected_setting_names: state.protectedFields,
      protected_settings: state.protectedSettings,
      proof: {
        method: "native_form_read",
        route: route.path,
        required_capability: route.capability,
        participant_count_capability: PARTICIPANTS_CAPABILITY,
        scope: route.scope,
      },
    };
  };
  const runRead = async (context, route, args) => {
    const loaded = await loadForm(context, route, args.courseId, args.moduleId);
    if (loaded.error) return failure(loaded.error, loaded.status);
    const participants = await enrolledParticipants(context, args.courseId);
    return {
      ok: true,
      sent: true,
      status: loaded.status,
      data: output(args.courseId, args.moduleId, loaded.state, participants),
      snapshot_digest: loaded.state.snapshotDigest,
    };
  };
  /**
   * The native controls one reviewed change is allowed to write: the controls it
   * names, the controls Moodle disables while one of those is off, because
   * Moodle can rewrite a disabled value with its own, and the route's own date
   * control, which Moodle re-defaults on every load while its checkbox is off.
   * Each one of them is a completion control, so the exact saved condition set
   * is what proves the result; the protected digest proves nothing else moved.
   */
  const mutableFields = (route, requested) => {
    const fields = new Set();
    const add = (field) => {
      fields.add(field);
      fields.add(`${field}[enabled]`);
      for (const component of DATE_COMPONENTS) fields.add(`${field}[${component}]`);
    };
    add(route.dateField);
    for (const setting of requested) {
      add(setting.field);
      for (const [field, governor] of Object.entries(route.governors)) if (governor === setting.field) add(field);
    }
    return fields;
  };
  /**
   * Turns one reviewed change into the exact native control values it would
   * send, or into the reason the loaded form refuses it. Every value must be
   * one the loaded control itself offers or can carry.
   */
  const changePlan = (state, requested) => {
    const { form, route } = state;
    const refused = `${route.prefix}_condition_refused`;
    const changes = new Map();
    const applied = [];
    const values = { ...conditionValues(state) };
    for (const setting of requested) {
      if (setting.kind === "date") {
        const controls = dateControls(form, route.dateField, route.dateOptional);
        if (!controls) return { error: refused };
        if (setting.value === null) {
          changes.set(`${route.dateField}[enabled]`, null);
          applied.push({ argument: setting.argument, field: route.dateField, value: null });
          values[route.dateField] = stable(null);
          continue;
        }
        if (stable(Object.keys(setting.value).sort()) !== stable([...controls.components].sort())) return { error: refused };
        for (const component of controls.components) {
          const value = String(setting.value[component]);
          if (!offersOption(form, `${route.dateField}[${component}]`, value)) return { error: refused };
          changes.set(`${route.dateField}[${component}]`, [value]);
        }
        if (controls.toggle) changes.set(`${route.dateField}[enabled]`, ["1"]);
        applied.push({ argument: setting.argument, field: route.dateField, value: setting.value });
        values[route.dateField] = stable(setting.value);
        continue;
      }
      if (setting.kind === "tracking") {
        if (!offersOption(form, route.trackingField, setting.value)) return { error: refused };
        changes.set(route.trackingField, [setting.value]);
        applied.push({ argument: setting.argument, field: route.trackingField, value: setting.value });
        values[route.trackingField] = setting.value;
        continue;
      }
      if (!state.conditionNames.includes(setting.field)) return { error: refused };
      const control = controlOf(form, setting.field);
      if (!control || control.writable !== true) return { error: refused };
      if (control.kind === "checkbox") {
        if (typeof setting.value !== "boolean") return { error: refused };
        const on = setting.value === true;
        changes.set(setting.field, control.offValue === null
          ? (on ? [control.onValue] : null)
          : (on ? [control.offValue, control.onValue] : [control.offValue]));
        applied.push({ argument: setting.argument, field: setting.field, value: on });
        values[setting.field] = on ? "1" : "0";
        continue;
      }
      if (typeof setting.value === "boolean") return { error: refused };
      const value = String(setting.value);
      if (control.kind === "select" || control.kind === "radio") {
        if (!offersOption(form, setting.field, value)) return { error: refused };
      } else if (control.kind !== "text" || !validOptionalText(value)) {
        return { error: refused };
      }
      changes.set(setting.field, [value]);
      applied.push({ argument: setting.argument, field: setting.field, value });
      values[setting.field] = value;
    }
    // Moodle disables a completion value while its own checkbox is off, so a
    // change that names one without that checkbox on is not saved.
    for (const setting of applied) {
      const governor = route.governors[setting.field];
      if (governor && values[governor] !== "1") return { error: refused };
    }
    if (route.trackingField) {
      const automatic = offersOption(form, route.trackingField, "2") ? "2" : "";
      const tracking = values[route.trackingField];
      if (applied.some((setting) => setting.argument === "conditions") && (!automatic || tracking !== automatic)) {
        return { error: `${route.prefix}_conditions_require_automatic` };
      }
      if (applied.some((setting) => setting.argument === route.dateArgument) && tracking === "0") {
        return { error: `${route.prefix}_date_requires_tracking` };
      }
      // Moodle refuses automatic completion with no condition switched on.
      // core_completion\form\form_trait::validate_completion
      if (automatic && tracking === automatic) {
        const enabled = state.conditionNames.some((name) => {
          const governor = route.governors[name];
          if (governor && values[governor] !== "1") return false;
          return values[name] !== "" && values[name] !== "0";
        });
        if (!enabled) return { error: `${route.prefix}_no_condition` };
      }
    }
    return { changes, applied, expected: maskInactive(values, route) };
  };
  /**
   * `changes` maps a native control name to the exact values one reviewed
   * change sends, or to null when the change removes the control from the body,
   * which is how a browser submits a native checkbox that is switched off.
   * Every other control of the loaded form is carried through unchanged.
   */
  const postForm = async (context, route, courseId, state, changes) => {
    const preflight = currentContext();
    if (!sameContext(context, preflight) || state.nativeSesskey !== preflight?.sesskey) return { error: "moodle_form_session_mismatch" };
    // The approval window is checked again here, not only on entry, so a change
    // whose window closed while Morrow was reading the form is never sent.
    if (!Number.isFinite(input.expiresAt) || Date.now() >= input.expiresAt) return { error: "moodle_execution_expired" };
    const refusal = fileAreaRefusal(state.fileAreas, route.prefix);
    if (refusal) return { error: refusal };
    const body = new URLSearchParams();
    const carried = new Set();
    for (const [field, value] of state.entries) {
      if (route.neverSend.includes(field)) continue;
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
    } catch { return unconfirmedWrite(`${route.prefix}_write_unconfirmed`); }
    if (!sameContext(context, currentContext())) return unconfirmedWrite(`${route.prefix}_write_unconfirmed`, response.status);
    // Chromium exposes a manual same-origin POST redirect as opaqueredirect. The
    // browser does not follow it, so Morrow never loads the course page that the
    // native form redirects to. The fixed form endpoint and the exact native
    // readback below are the confirmation.
    if (response.type === "opaqueredirect") return { sent: true };
    if (![301, 302, 303, 307, 308].includes(response.status)) return unconfirmedWrite(`${route.prefix}_write_unconfirmed`, response.status);
    return courseRedirect(context, courseId, response.headers.get("location") || "", state.action)
      ? { sent: true, status: response.status }
      : unconfirmedWrite(`${route.prefix}_write_unconfirmed`, response.status);
  };
  const runWrite = async (context, route, args) => {
    const prefix = route.prefix;
    const mutable = mutableFields(route, args.requested);
    // One load, immediately before the one POST: the reviewed digest is checked
    // against the exact form this change carries and sends.
    const loaded = await loadForm(context, route, args.courseId, args.moduleId, mutable);
    if (loaded.error) return failure(loaded.error, loaded.status);
    const state = loaded.state;
    if (!state.available) return failure(`${prefix}_unavailable`, loaded.status);
    if (state.locked) return failure(`${prefix}_locked`, loaded.status);
    if (state.snapshotDigest !== args.expectedDigest) return failure("moodle_expected_digest_mismatch", loaded.status);
    const refusal = fileAreaRefusal(state.fileAreas, prefix);
    if (refusal) return failure(refusal, loaded.status);
    // The number of enrolled participants this change reaches, established
    // again immediately before the change and compared with the number that was
    // approved.
    const participants = await enrolledParticipants(context, args.courseId);
    if (participants === null) return failure("moodle_completion_participant_count_unavailable", loaded.status);
    if (participants !== args.acknowledgedParticipants) return failure("moodle_completion_participant_count_mismatch", loaded.status);
    const plan = changePlan(state, args.requested);
    if (plan.error) return failure(plan.error, loaded.status);
    const posted = await postForm(context, route, args.courseId, state, plan.changes);
    if (posted.error) return posted.sent === true ? posted : failure(posted.error, posted.status);
    const after = await loadForm(context, route, args.courseId, args.moduleId, mutable);
    if (after.error) return unconfirmedWrite(`${prefix}_readback_unconfirmed`, posted.status);
    const saved = after.state.available && !after.state.locked ? maskInactive(conditionValues(after.state), route) : null;
    if (!saved || stable(after.state.conditionNames) !== stable(state.conditionNames)
      || stable(saved) !== stable(plan.expected)
      || after.state.protectedDigest !== state.protectedDigest) {
      return unconfirmedWrite(`${prefix}_write_not_verified`, posted.status);
    }
    return {
      ok: true,
      sent: true,
      status: posted.status ?? after.status,
      data: {
        ...output(args.courseId, args.moduleId, after.state, participants),
        changed_conditions: plan.applied,
        // One POST of the course completion form replaces the complete set of
        // saved course completion criteria.
        replaces_condition_set: route.name === "course",
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
    const route = ROUTES[definition.route];
    const args = argumentsFor(definition, route, input.arguments, input.binding);
    if (!args) return failure("moodle_completion_arguments_invalid");
    return definition.kind === "read" ? await runRead(context, route, args) : await runWrite(context, route, args);
  } catch (error) {
    if (writeAttempted) return unconfirmedWrite("moodle_completion_write_unconfirmed");
    return failure(String(error?.message || error).startsWith("moodle_") ? String(error.message) : "moodle_completion_execution_failed");
  }
}
