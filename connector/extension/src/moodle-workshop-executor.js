/**
 * Reads one Moodle Workshop, prepares a Workshop creation form, creates one
 * hidden Workshop, changes a bounded set of its settings, and reads which phase
 * it is in.
 *
 * A Workshop is Moodle's peer-assessment activity. Its phase decides what every
 * learner may do: submit, assess a peer, or read the grades. None of the five
 * operations here changes that phase, allocates a submission to a reviewer,
 * writes an assessment, or calculates a grade.
 *
 * Routes, read from Moodle v5.2.2 source:
 * - The settings read, the creation form, the create and the settings change all
 *   use the native activity settings form, `public/course/modedit.php`, with the
 *   Workshop form `mod_workshop_mod_form`.
 *   https://github.com/moodle/moodle/blob/v5.2.2/public/mod/workshop/mod_form.php
 *   https://github.com/moodle/moodle/blob/v5.2.2/public/course/modedit.php
 *   Every write sends `submitbutton2`, the native Save and return to course
 *   control, so Moodle's own redirect names `course/view.php`. Morrow never
 *   follows that redirect.
 *   https://github.com/moodle/moodle/blob/v5.2.2/public/course/modedit.php#L195-L212
 * - The course state before and after a create comes from the same-site AJAX
 *   method `core_courseformat_get_state`, which the course page itself uses.
 * - The phase read comes from the same-site AJAX method
 *   `core_courseformat_get_overview_information`. Moodle declares it
 *   `'type' => 'read'` with `'ajax' => true`, it triggers no event, and the
 *   Workshop overview states the stored phase as its own item.
 *   https://github.com/moodle/moodle/blob/v5.2.2/public/lib/db/services.php
 *   https://github.com/moodle/moodle/blob/v5.2.2/public/mod/workshop/classes/courseformat/overview.php#L135-L145
 *
 * `/mod/workshop/view.php` is never opened. That route records a module view and
 * a completion state, and it is the screen that carries the phase switch,
 * allocation, assessment and grade-calculation controls.
 *
 * Required capability: `moodle/course:manageactivities` at the course context to
 * create, and at the module context to read or change one Workshop. The phase
 * read needs `moodle/course:viewoverview` at the course context.
 *
 * Five facts shape these operations, and each one is stated in the catalog text.
 *
 * 1. A new Workshop is created hidden and in the setup phase. Moodle's own
 *    `workshop_add_instance` sets `phase = PHASE_SETUP`, so a created Workshop
 *    accepts no submission and no assessment until a person moves it on in
 *    Moodle.
 *    https://github.com/moodle/moodle/blob/v5.2.2/public/mod/workshop/lib.php
 * 2. The settings change carries every other control of the loaded form through
 *    unchanged and compares a digest of them after the save. The grading
 *    strategy, both maximum grades, the submission types, the example
 *    submissions and the file settings are outside its scope, because each of
 *    them changes what an existing submission or assessment means.
 * 3. Moodle can switch a Workshop from the submission phase to the assessment
 *    phase by itself when `phaseswitchassessment` is set and the submission
 *    deadline passes. A change to any of the four availability dates while that
 *    setting is on is therefore refused: it would schedule a phase change.
 *    https://github.com/moodle/moodle/blob/v5.2.2/public/mod/workshop/classes/task/cron_task.php#L56-L86
 * 4. Morrow rewrites the four rich-text controls as text. A form whose editor or
 *    file area holds a file, or whose text names a Moodle file, is refused
 *    before anything is sent, because Morrow cannot carry that file with the
 *    text.
 * 5. The phase read returns the stored phase and nothing else about the
 *    Workshop's people. It reports no submission, no assessment, no reviewer and
 *    no learner identity, and Morrow has no operation that changes the phase.
 *
 * A lost response, a saved form that is not the approved one, and a created
 * activity Morrow cannot find exactly once are all `applied_or_unknown`. Nothing
 * is ever sent twice.
 *
 * No signed-in Moodle site has run any of these five operations.
 *
 * Chrome serializes this function for a MAIN-world injection. Keep every
 * dependency inside the function body.
 */
export async function executeMoodleWorkshopInPage(rawInput) {
  const PROVIDER = "moodle";
  const MODULE = "workshop";
  const MODEDIT_PATH = "/course/modedit.php";
  const MAX_BYTES = 2 * 1024 * 1024;
  const MAX_FORM_ENTRIES = 600;
  const MAX_VALUE_BYTES = 64 * 1024;
  const MAX_NAME = 1333;
  const MAX_RICH_TEXT = 40_000;
  const MAX_STATE_ENTRIES = 10_000;
  const MAX_OVERVIEW_ACTIVITIES = 1_000;
  const MAX_OVERVIEW_ITEMS = 40;
  const ID = /^[1-9][0-9]{0,18}$/;
  const DIGEST = /^[a-f0-9]{64}$/;
  const DATE_PARTS = ["year", "month", "day", "hour", "minute"];
  // workshop::PHASE_* in mod/workshop/locallib.php, Moodle v5.2.2.
  const PHASE_KEYS = { 10: "setup", 20: "submission", 30: "assessment", 40: "grading_evaluation", 50: "closed" };
  // The four rich-text controls of the Workshop form, named as an instructor
  // reads them, with the native editor each one belongs to.
  const EDITORS = Object.freeze([
    ["instructions", "introeditor"],
    ["submission_instructions", "instructauthorseditor"],
    ["assessment_instructions", "instructreviewerseditor"],
    ["conclusion", "conclusioneditor"],
  ]);
  // The four availability dates. Each one is a native optional date_time_selector.
  const DATES = Object.freeze([
    ["submission_start", "submissionstart"],
    ["submission_end", "submissionend"],
    ["assessment_start", "assessmentstart"],
    ["assessment_end", "assessmentend"],
  ]);
  // Read-only settings the result reports so a person can judge the Workshop
  // before changing anything. None of them is writable here.
  const REPORTED_SELECTS = ["strategy", "grade", "gradinggrade", "gradedecimals", "nattachments", "maxbytes", "overallfeedbackmode", "overallfeedbackfiles", "overallfeedbackmaxbytes", "examplesmode"];
  const REPORTED_CHECKBOXES = ["latesubmissions", "useselfassessment", "useexamples", "phaseswitchassessment"];
  const REPORTED_TEXTS = ["submissionfiletypes", "overallfeedbackfiletypes", "submissiongradepass", "gradinggradepass"];
  const SUBMISSION_TYPES = [["text_available", "submissiontypetextavailable"], ["text_required", "submissiontypetextrequired"], ["file_available", "submissiontypefileavailable"], ["file_required", "submissiontypefilerequired"]];
  // Controls that must be on the loaded form for it to be the Workshop form.
  const REQUIRED_CONTROLS = ["name", "strategy", "grade", "gradinggrade", "visible",
    ...EDITORS.map(([, editor]) => `${editor}[text]`), ...DATES.map(([, field]) => `${field}[enabled]`)];
  // Controls the create readback compares by name only, because the add form and
  // the saved update form do not carry the same identity controls.
  const CREATE_IGNORED = new Set(["add", "update", "course", "coursemodule", "instance", "modulename", "revision", "return", "sr", "beforemod", "section", "showonly", "coursecontentnotification", "submitbutton", "submitbutton2"]);
  const definitions = Object.freeze({
    "moodle.form.course.modedit.workshop.read.v1": { toolName: "moodle_get_workshop", readOnly: true, kind: "read", capability: "moodle/course:manageactivities" },
    "moodle.form.course.modedit.workshop.create.read.v1": { toolName: "moodle_get_workshop_creation_form", readOnly: true, kind: "create-read", capability: "moodle/course:manageactivities" },
    "moodle.form.course.modedit.workshop.create.write.v1": { toolName: "moodle_create_workshop", readOnly: false, kind: "create", capability: "moodle/course:manageactivities" },
    "moodle.form.course.modedit.workshop.write.v1": { toolName: "moodle_update_workshop", readOnly: false, kind: "update", capability: "moodle/course:manageactivities" },
    "moodle.form.workshop.phase.read.v1": { toolName: "moodle_get_workshop_phase", readOnly: true, kind: "phase", capability: "moodle/course:viewoverview" },
  });
  const parseInput = () => {
    if (typeof rawInput !== "string") return rawInput;
    try { return JSON.parse(rawInput); } catch { return null; }
  };
  const input = parseInput();
  let writeAttempted = false;
  const failure = (error, status) => ({ ok: false, sent: false, ...(Number.isInteger(status) ? { status } : {}), error });
  const unconfirmed = (error, status) => ({
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
  const sectionNumberOf = (value) => {
    const text = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : typeof value === "string" ? value : "";
    return /^(?:0|[1-9][0-9]{0,5})$/.test(text) ? text : "";
  };
  const validString = (value, maximum) => typeof value === "string" && value.length <= maximum && !value.includes("\u0000");
  const hasEmbeddedFile = (value) => /(?:draftfile\.php\/|@@PLUGINFILE@@|<\s*(?:img|audio|video|source|track|object|embed|iframe)\b|\b(?:src|poster)\s*=\s*["']?\s*(?:data:|blob:))/i.test(String(value));
  const validDate = (value) => {
    if (!object(value) || Object.keys(value).length !== 5 || !DATE_PARTS.every((key) => Number.isSafeInteger(value[key]))) return false;
    const { year, month, day, hour, minute } = value;
    if (year < 1970 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31 || hour < 0 || hour > 23 || minute < 0 || minute > 59) return false;
    const date = new Date(Date.UTC(year, month - 1, day, hour, minute));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  };
  const compareDate = (left, right) => Date.UTC(left.year, left.month - 1, left.day, left.hour, left.minute) - Date.UTC(right.year, right.month - 1, right.day, right.hour, right.minute);
  const transientField = (name) => /(?:sesskey|statekey|_qf__|csrf|token|secret|password|authorization|cookie|(?:^|[\[_-])(?:draft|itemid)(?:$|[\]_-]))/i.test(name);
  const redact = (value) => value.replace(/([?&](?:sesskey|token|csrf|password|secret)=)[^&#\s]+/gi, "$1[redacted]");
  const stable = (value) => {
    if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
    if (object(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
    return JSON.stringify(value === undefined ? null : value);
  };
  const digest = async (value) => {
    if (!globalThis.crypto?.subtle || typeof globalThis.TextEncoder !== "function") throw new Error("moodle_workshop_digest_unavailable");
    const bytes = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(stable(value)));
    return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
  };
  const currentContext = () => {
    const cfg = globalThis.M?.cfg;
    if (!object(cfg) || typeof cfg.wwwroot !== "string" || !validString(cfg.sesskey, 1024) || !cfg.sesskey) return null;
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
    if (configuredCourse && bodyCourse && configuredCourse !== bodyCourse) return null;
    return { origin: site.origin, siteUrl: site.href, basePath, principalId, anchorCourseId: configuredCourse || bodyCourse || "", sesskey: cfg.sesskey };
  };
  const sameContext = (left, right) => left?.origin === right?.origin && left?.siteUrl === right?.siteUrl
    && left?.basePath === right?.basePath && left?.principalId === right?.principalId
    && left?.anchorCourseId === right?.anchorCourseId && left?.sesskey === right?.sesskey;
  const bindingValid = (context, binding) => object(binding) && binding.origin === context.origin && binding.siteUrl === context.siteUrl
    && String(binding.principalId || "") === context.principalId && Boolean(id(binding.courseId));
  const urlFor = (context, path, params = {}) => {
    const url = new URL(context.siteUrl);
    url.pathname = `${context.basePath}${path}`;
    url.search = new URLSearchParams(params).toString();
    url.hash = "";
    return url.toString();
  };
  const expectedOperation = (operation) => {
    if (!object(operation) || typeof operation.key !== "string") return null;
    const definition = definitions[operation.key];
    return definition && operation.provider === PROVIDER && operation.toolName === definition.toolName
      && operation.readOnly === definition.readOnly ? definition : null;
  };
  const exactKeys = (value, required, optional = []) => object(value)
    && required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
  const authoredNames = [...EDITORS.map(([argument]) => argument), ...DATES.map(([argument]) => argument)];
  const authoredValid = (value, withName) => {
    if (withName && Object.hasOwn(value, "name") && (!validString(value.name, MAX_NAME) || !value.name.trim())) return false;
    for (const [argument] of EDITORS) {
      if (!Object.hasOwn(value, argument)) continue;
      if (!validString(value[argument], MAX_RICH_TEXT) || hasEmbeddedFile(value[argument])) return false;
    }
    for (const [argument] of DATES) {
      if (Object.hasOwn(value, argument) && value[argument] !== null && !validDate(value[argument])) return false;
    }
    const start = value.submission_start;
    const end = value.submission_end;
    if (start && end && compareDate(end, start) <= 0) return false;
    const assessStart = value.assessment_start;
    const assessEnd = value.assessment_end;
    if (assessStart && assessEnd && compareDate(assessEnd, assessStart) <= 0) return false;
    return true;
  };
  const moduleArguments = (value, courseId) => {
    if (!exactKeys(value, ["course_id", "module_id"]) || id(value.course_id) !== courseId || !id(value.module_id)) return null;
    return { courseId, moduleId: id(value.module_id) };
  };
  const creationFormArguments = (value, courseId) => {
    if (!exactKeys(value, ["course_id", "section_id"]) || id(value.course_id) !== courseId || !id(value.section_id)) return null;
    return { courseId, sectionId: id(value.section_id) };
  };
  const createArguments = (value, courseId) => {
    if (!exactKeys(value, ["course_id", "section_id", "name", "expected_digest"], authoredNames)) return null;
    if (id(value.course_id) !== courseId || !id(value.section_id) || !DIGEST.test(String(value.expected_digest || ""))) return null;
    if (!validString(value.name, MAX_NAME) || !value.name.trim() || !authoredValid(value, false)) return null;
    return { courseId, sectionId: id(value.section_id), settings: value };
  };
  const settingsArguments = (value, courseId) => {
    const optional = ["name", ...authoredNames];
    if (!exactKeys(value, ["course_id", "module_id", "expected_digest"], optional)) return null;
    if (id(value.course_id) !== courseId || !id(value.module_id) || !DIGEST.test(String(value.expected_digest || ""))) return null;
    if (!optional.some((key) => Object.hasOwn(value, key)) || !authoredValid(value, true)) return null;
    return { courseId, moduleId: id(value.module_id), expectedDigest: value.expected_digest, settings: value };
  };
  const readText = async (response) => {
    const declared = Number(response.headers?.get?.("content-length") || 0);
    if (Number.isSafeInteger(declared) && declared > MAX_BYTES) throw new Error("moodle_workshop_response_too_large");
    const text = await response.text();
    if (typeof text !== "string" || text.length > MAX_BYTES) throw new Error("moodle_workshop_response_too_large");
    return text;
  };
  const draftItemId = (value) => typeof value === "string" && ID.test(value) && Number.isSafeInteger(Number(value)) ? value : "";
  const readDraftListing = async (context, itemId) => {
    let response;
    try {
      response = await fetch(urlFor(context, "/repository/draftfiles_ajax.php", { action: "list" }), {
        method: "POST",
        credentials: "include",
        cache: "no-store",
        redirect: "error",
        headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
        body: new URLSearchParams({ sesskey: context.sesskey, itemid: itemId, filepath: "/" }),
      });
    } catch { return null; }
    let text;
    try { text = await readText(response); } catch { return null; }
    if (!response.ok) return null;
    let payload;
    try { payload = JSON.parse(text); } catch { return null; }
    return object(payload) ? payload : null;
  };
  const managerState = (listing) => !listing || !Number.isSafeInteger(listing.filecount) || listing.filecount < 0 || !Array.isArray(listing.list)
    ? "unverified" : listing.filecount === 0 && listing.list.length === 0 ? "empty" : "nonempty";
  const inspectFileManagers = async (context, form, formData) => {
    const managers = [];
    const seen = new Set();
    const inspect = async (name, value) => {
      seen.add(name);
      const itemId = draftItemId(value);
      const listing = itemId ? await readDraftListing(context, itemId) : null;
      managers.push({ name, itemId, state: managerState(listing) });
    };
    for (const control of form.querySelectorAll('[data-fieldtype="filemanager"] input[type="hidden"][name]')) {
      const name = String(control.getAttribute("name") || "");
      if (!name || seen.has(name)) continue;
      await inspect(name, formData.get(name));
    }
    for (const name of new Set(Array.from(formData.keys()).filter((entry) => /\[itemid\]$/.test(entry)))) {
      if (seen.has(name)) continue;
      const values = formData.getAll(name);
      await inspect(name, values.length === 1 ? values[0] : "");
    }
    return managers;
  };
  const valuesFromForm = (formData, form, fileManagers) => {
    const states = new Map(fileManagers.map(({ name, state }) => [name, state]));
    const values = {};
    for (const [name, value] of formData.entries()) {
      const managerStateValue = states.get(name);
      if (managerStateValue) {
        if (values[name] === undefined) values[name] = { filemanager: { state: managerStateValue } };
        continue;
      }
      if (transientField(name)) continue;
      if (typeof File !== "undefined" && value instanceof File) {
        if (value.size > 0) throw new Error("moodle_workshop_form_invalid");
        continue;
      }
      if (typeof value !== "string") throw new Error("moodle_workshop_form_invalid");
      const safeValue = redact(value);
      if (values[name] === undefined) values[name] = safeValue;
      else if (Array.isArray(values[name])) values[name].push(safeValue);
      else values[name] = [values[name], safeValue];
    }
    for (const control of form.querySelectorAll('input[type="checkbox"][name$="[enabled]"]')) {
      if (control.checked) continue;
      values[control.name] = "0";
      const prefix = control.name.slice(0, -"[enabled]".length);
      for (const part of DATE_PARTS) delete values[`${prefix}[${part}]`];
    }
    return values;
  };
  const one = (values, name) => typeof values[name] === "string" ? values[name] : "";
  // Moodle renders an advanced checkbox as a hidden zero followed by the checkbox
  // itself, so a checked one carries two values and the last one decides.
  const lastValue = (values, name) => {
    const value = values[name];
    if (!Array.isArray(value)) return one(values, name);
    const last = value[value.length - 1];
    return typeof last === "string" ? last : "";
  };
  const checkboxOn = (values, name) => Object.hasOwn(values, name) && lastValue(values, name) === "1";
  const dateFromValues = (values, field) => {
    if (one(values, `${field}[enabled]`) !== "1") return null;
    const date = Object.fromEntries(DATE_PARTS.map((part) => [part, Number(one(values, `${field}[${part}]`))]));
    return validDate(date) ? date : null;
  };
  const namedControls = (documentValue, name) => Array.from(documentValue?.querySelectorAll?.("[name]") || [])
    .filter((control) => control.getAttribute("name") === name);
  const selectAllows = (documentValue, name, value) => {
    const selects = namedControls(documentValue, name).filter((control) => control.tagName === "SELECT");
    if (selects.length !== 1 || selects[0].disabled || selects[0].multiple) return false;
    return Array.from(selects[0].options || []).some((option) => String(option.value || "") === value);
  };
  const selectedValue = (documentValue, values, name) => {
    const current = one(values, name);
    if (current) return current;
    const selects = namedControls(documentValue, name).filter((control) => control.tagName === "SELECT");
    if (selects.length !== 1) return "";
    const selected = Array.from(selects[0].options || []).filter((option) => option.selected);
    return selected.length === 1 ? String(selected[0].value || "") : "";
  };
  const textWritable = (documentValue, name) => {
    const controls = namedControls(documentValue, name).filter((control) => ["INPUT", "TEXTAREA"].includes(control.tagName));
    return controls.length === 1 && !controls[0].disabled;
  };
  const dateWritable = (documentValue, field) => {
    const toggles = namedControls(documentValue, `${field}[enabled]`)
      .filter((control) => String(control.getAttribute("type") || "").toLowerCase() === "checkbox");
    if (toggles.length !== 1 || toggles[0].disabled) return false;
    return DATE_PARTS.every((part) => {
      const selects = namedControls(documentValue, `${field}[${part}]`).filter((control) => control.tagName === "SELECT");
      return selects.length === 1 && !selects[0].disabled;
    });
  };
  const routeMatches = (value, endpoint, required) => {
    let actual;
    let expected;
    try { actual = new URL(value || endpoint); expected = new URL(endpoint); } catch { return false; }
    return actual.origin === expected.origin && actual.pathname === expected.pathname
      && [...actual.searchParams.keys()].length === Object.keys(required).length
      && Object.entries(required).every(([name, item]) => actual.searchParams.getAll(name).length === 1 && actual.searchParams.get(name) === String(item));
  };
  const ajax = async (context, methodName, args) => {
    let response;
    try {
      response = await fetch(urlFor(context, "/lib/ajax/service.php", { sesskey: context.sesskey, info: methodName }), {
        method: "POST",
        credentials: "include",
        cache: "no-store",
        redirect: "error",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify([{ index: 0, methodname: methodName, args }]),
      });
    } catch { return { error: "moodle_workshop_ajax_failed" }; }
    let text;
    try { text = await readText(response); } catch { return { error: "moodle_workshop_ajax_failed", status: response.status }; }
    let payload;
    try { payload = JSON.parse(text); } catch { return { error: "moodle_workshop_ajax_failed", status: response.status }; }
    const entry = Array.isArray(payload) && payload.length === 1 && object(payload[0]) ? payload[0] : null;
    if (!response.ok || !entry || entry.error || entry.exception) return { error: "moodle_workshop_ajax_failed", status: response.status };
    return { status: response.status, data: entry.data };
  };
  const courseState = async (context, courseId) => {
    const response = await ajax(context, "core_courseformat_get_state", { courseid: Number(courseId) });
    if (response.error) return response;
    let value;
    try { value = JSON.parse(response.data); } catch { return { error: "moodle_workshop_state_invalid", status: response.status }; }
    if (!object(value) || !object(value.course) || id(value.course.id) !== courseId
      || !Array.isArray(value.section) || value.section.length > MAX_STATE_ENTRIES
      || !Array.isArray(value.cm) || value.cm.length > MAX_STATE_ENTRIES) return { error: "moodle_workshop_state_invalid", status: response.status };
    return { status: response.status, sections: value.section, activities: value.cm };
  };
  const loadForm = async (context, descriptor) => {
    const endpoint = urlFor(context, MODEDIT_PATH, descriptor.route);
    let response;
    try {
      response = await fetch(endpoint, { method: "GET", credentials: "include", cache: "no-store", headers: { Accept: "text/html" } });
    } catch { return { error: "moodle_workshop_form_read_failed" }; }
    let text;
    try { text = await readText(response); } catch { return { error: "moodle_workshop_form_read_failed", status: response.status }; }
    const routeParams = Object.fromEntries(Object.entries(descriptor.route).map(([name, value]) => [name, String(value)]));
    if (!response.ok || typeof DOMParser === "undefined" || typeof FormData === "undefined" || !routeMatches(response.url, endpoint, routeParams)) {
      return { error: "moodle_workshop_form_read_failed", status: response.status };
    }
    const status = response.status;
    let documentValue;
    try { documentValue = new DOMParser().parseFromString(text, "text/html"); } catch { return { error: "moodle_workshop_form_read_failed", status }; }
    const forms = Array.from(documentValue.querySelectorAll("form")).filter((candidate) => {
      if (String(candidate.getAttribute("method") || "get").toLowerCase() !== "post") return false;
      try {
        const values = new FormData(candidate);
        return Object.entries(descriptor.identity).every(([name, item]) => values.getAll(name).length === 1 && String(values.get(name) || "") === item);
      } catch { return false; }
    });
    if (forms.length !== 1) return { error: "moodle_workshop_form_target_invalid", status };
    const form = forms[0];
    let action;
    try { action = new URL(form.getAttribute("action") || endpoint, endpoint); } catch { return { error: "moodle_workshop_form_target_invalid", status }; }
    const expected = new URL(endpoint);
    if (action.origin !== expected.origin || action.pathname !== expected.pathname || action.hash
      || (action.search && !routeMatches(action.toString(), endpoint, routeParams))) return { error: "moodle_workshop_form_target_invalid", status };
    const submits = Array.from(form.querySelectorAll('input[type="submit"][name], button[type="submit"][name]'))
      .filter((control) => control.name === "submitbutton2" && !control.disabled && typeof control.value === "string" && control.value && control.value.length <= 500);
    if (submits.length !== 1) return { error: "moodle_workshop_form_target_invalid", status };
    let formData;
    try { formData = new FormData(form); } catch { return { error: "moodle_workshop_form_read_failed", status }; }
    const entries = [...formData.entries()];
    if (entries.length > MAX_FORM_ENTRIES
      || entries.some(([name, value]) => typeof name !== "string" || !name || name.length > 255 || (typeof value === "string" && value.length > MAX_VALUE_BYTES))) {
      return { error: "moodle_workshop_form_target_invalid", status };
    }
    const sesskeys = formData.getAll("sesskey");
    if (sesskeys.length !== 1 || sesskeys[0] !== context.sesskey) return { error: "moodle_form_session_mismatch", status };
    let fileManagers;
    let values;
    try {
      fileManagers = await inspectFileManagers(context, form, formData);
      values = valuesFromForm(formData, form, fileManagers);
    } catch { return { error: "moodle_workshop_form_read_failed", status }; }
    if (!REQUIRED_CONTROLS.every((name) => Object.hasOwn(values, name))) return { error: "moodle_workshop_form_target_invalid", status };
    return {
      status,
      document: documentValue,
      form,
      formData,
      values,
      fileManagers,
      identity: descriptor.identity,
      action: action.toString(),
      submit: { name: submits[0].name, value: submits[0].value },
      visible: one(values, "visible") === "1",
      snapshotDigest: await digest(values),
    };
  };
  const settingsDescriptor = (courseId, moduleId) => ({
    route: { update: moduleId, return: 0 },
    identity: { update: moduleId, course: courseId, modulename: MODULE },
  });
  const creationDescriptor = (courseId, sectionId, sectionNumber) => ({
    route: { add: MODULE, course: courseId, sectionid: sectionId, return: 0 },
    identity: { course: courseId, add: MODULE, modulename: MODULE, section: sectionNumber, return: "0" },
  });
  const sectionFor = async (context, courseId, sectionId) => {
    const state = await courseState(context, courseId);
    if (state.error) return state;
    const matches = state.sections.filter((entry) => id(entry?.id) === sectionId);
    if (matches.length !== 1) return { error: "moodle_workshop_section_target_invalid", status: state.status };
    const number = sectionNumberOf(matches[0].number);
    if (!number) return { error: "moodle_workshop_section_target_invalid", status: state.status };
    return { status: state.status, sectionNumber: number };
  };
  const filesRefusal = (form) => {
    if (form.fileManagers.some(({ state }) => state === "nonempty")) return "moodle_workshop_form_files_refused";
    return form.fileManagers.some(({ state }) => state !== "empty") ? "moodle_workshop_form_files_unverified" : "";
  };
  const output = (courseId, form, extra) => ({
    course_id: Number(courseId),
    ...extra,
    name: one(form.values, "name"),
    ...Object.fromEntries(EDITORS.flatMap(([argument, editor]) => [
      [argument, one(form.values, `${editor}[text]`)],
      [`${argument}_format`, Number(one(form.values, `${editor}[format]`))],
    ])),
    ...Object.fromEntries(REPORTED_SELECTS.map((name) => [name, selectedValue(form.document, form.values, name)])),
    ...Object.fromEntries(REPORTED_CHECKBOXES.map((name) => [name, checkboxOn(form.values, name)])),
    ...Object.fromEntries(REPORTED_TEXTS.map((name) => [name, one(form.values, name)])),
    submission_types: Object.fromEntries(SUBMISSION_TYPES.map(([argument, name]) => [argument, checkboxOn(form.values, name)])),
    ...Object.fromEntries(DATES.map(([argument, field]) => [argument, dateFromValues(form.values, field)])),
    visible: form.visible,
  });
  const protectedDigest = (values, names) => {
    const copy = { ...values };
    for (const name of names) delete copy[name];
    return digest({ values: copy });
  };
  const protectedNames = (values, names) => [...new Set(Object.keys(values).filter((name) => !names.includes(name)))].sort();
  const settingChanges = (form, settings) => {
    const names = [];
    if (Object.hasOwn(settings, "name")) {
      if (!textWritable(form.document, "name")) return null;
      names.push("name");
    }
    for (const [argument, editor] of EDITORS) {
      if (!Object.hasOwn(settings, argument)) continue;
      if (!textWritable(form.document, `${editor}[text]`)) return null;
      names.push(`${editor}[text]`);
    }
    for (const [argument, field] of DATES) {
      if (!Object.hasOwn(settings, argument)) continue;
      if (!dateWritable(form.document, field)) return null;
      names.push(`${field}[enabled]`, ...DATE_PARTS.map((part) => `${field}[${part}]`));
    }
    return names;
  };
  const applySettings = (formData, settings) => {
    const set = (name, value) => { formData.delete(name); formData.append(name, String(value)); };
    if (Object.hasOwn(settings, "name")) set("name", settings.name);
    for (const [argument, editor] of EDITORS) {
      if (Object.hasOwn(settings, argument)) set(`${editor}[text]`, settings[argument]);
    }
    for (const [argument, field] of DATES) {
      if (!Object.hasOwn(settings, argument)) continue;
      const value = settings[argument];
      if (value === null) {
        formData.delete(`${field}[enabled]`);
        continue;
      }
      set(`${field}[enabled]`, "1");
      for (const part of DATE_PARTS) set(`${field}[${part}]`, value[part]);
    }
  };
  const settingsMatch = (data, settings) => (!Object.hasOwn(settings, "name") || data.name === settings.name)
    && EDITORS.every(([argument]) => !Object.hasOwn(settings, argument) || data[argument] === settings[argument])
    && DATES.every(([argument]) => !Object.hasOwn(settings, argument)
      || (settings[argument] === null ? data[argument] === null : Boolean(data[argument]) && compareDate(data[argument], settings[argument]) === 0));
  // Moodle saves an empty new pass grade as zero and formats it for the edit form.
  const savedAsZero = (name, before, after) => ["submissiongradepass", "gradinggradepass"].includes(name)
    && before === "" && typeof after === "string" && /^0(?:[.,]0+)?$/.test(after);
  const defaultsPreserved = (beforeValues, afterValues, names) => {
    const changed = new Set(names);
    return Object.entries(beforeValues).every(([name, value]) => changed.has(name) || CREATE_IGNORED.has(name)
      || savedAsZero(name, value, afterValues[name])
      || (Object.hasOwn(afterValues, name) && stable(value) === stable(afterValues[name])));
  };
  // Moodle redisplays the same native form when it rejects the values, so nothing was saved.
  const sameFormReturned = (text, form) => {
    if (typeof DOMParser === "undefined" || typeof text !== "string") return false;
    let documentValue;
    try { documentValue = new DOMParser().parseFromString(text, "text/html"); } catch { return false; }
    const action = new URL(form.action);
    return Array.from(documentValue.querySelectorAll("form")).some((candidate) => {
      if (String(candidate.getAttribute("method") || "get").toLowerCase() !== "post") return false;
      try {
        const candidateAction = new URL(candidate.getAttribute("action") || form.action, form.action);
        if (candidateAction.origin !== action.origin || candidateAction.pathname !== action.pathname) return false;
        const values = new FormData(candidate);
        return Object.entries(form.identity).every(([name, item]) => values.getAll(name).length === 1 && String(values.get(name) || "") === item);
      } catch { return false; }
    });
  };
  const postWorkshopForm = async (context, form, courseId) => {
    const params = new URLSearchParams();
    try {
      for (const [name, value] of form.formData.entries()) {
        if (name === "coursecontentnotification" || name === "submitbutton" || name === "submitbutton2") continue;
        if (typeof File !== "undefined" && value instanceof File) {
          if (value.size > 0) return { error: "moodle_workshop_form_files_refused" };
          continue;
        }
        if (typeof value !== "string") return { error: "moodle_workshop_form_invalid" };
        params.append(name, value);
      }
    } catch { return { error: "moodle_workshop_form_invalid" }; }
    params.set(form.submit.name, form.submit.value);
    let response;
    try {
      writeAttempted = true;
      response = await fetch(form.action, {
        method: "POST", credentials: "include", cache: "no-store", redirect: "manual",
        headers: { Accept: "text/html", "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" }, body: params,
      });
    } catch { return { unconfirmed: "moodle_workshop_save_unknown" }; }
    // The redirect is never followed. That is what keeps /mod/workshop/view.php,
    // and every phase, allocation, assessment and report control it carries, out
    // of this request whatever Moodle answers with. Chromium exposes a manual
    // same-origin POST redirect as opaqueredirect, so the native form and course
    // state readbacks below are the confirmation.
    if (response.type === "opaqueredirect") return { sent: true };
    let text;
    try { text = await readText(response); } catch { return { unconfirmed: "moodle_workshop_save_unknown", status: response.status }; }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const courseView = new URL(urlFor(context, "/course/view.php", { id: courseId }));
      let redirect;
      try { redirect = new URL(response.headers.get("location") || "", form.action); } catch { return { unconfirmed: "moodle_workshop_save_unknown", status: response.status }; }
      return redirect.origin === courseView.origin && redirect.pathname === courseView.pathname
        ? { status: response.status }
        : { unconfirmed: "moodle_workshop_save_unknown", status: response.status };
    }
    return response.ok && sameFormReturned(text, form)
      ? { rejected: "moodle_workshop_save_not_sent", status: response.status }
      : { unconfirmed: "moodle_workshop_save_unknown", status: response.status };
  };
  const overviewPhase = async (context, courseId, moduleId) => {
    const response = await ajax(context, "core_courseformat_get_overview_information", { courseid: Number(courseId), modname: MODULE });
    if (response.error) return response;
    const value = response.data;
    if (!object(value) || id(value.courseid) !== courseId || !Array.isArray(value.activities)
      || value.activities.length > MAX_OVERVIEW_ACTIVITIES) return { error: "moodle_workshop_phase_unavailable", status: response.status };
    const matches = value.activities.filter((entry) => object(entry) && id(entry.cmid) === moduleId);
    if (matches.length !== 1 || matches[0].modname !== MODULE) return { error: "moodle_workshop_phase_unavailable", status: response.status };
    const activity = matches[0];
    if (activity.haserror === true || !Array.isArray(activity.items) || activity.items.length > MAX_OVERVIEW_ITEMS
      || !validString(activity.name, MAX_NAME)) return { error: "moodle_workshop_phase_unavailable", status: response.status };
    const items = activity.items.filter((entry) => object(entry) && entry.key === "phase");
    if (items.length !== 1 || typeof items[0].contentjson !== "string" || items[0].contentjson.length > MAX_VALUE_BYTES) {
      return { error: "moodle_workshop_phase_unavailable", status: response.status };
    }
    let content;
    try { content = JSON.parse(items[0].contentjson); } catch { return { error: "moodle_workshop_phase_unavailable", status: response.status }; }
    const phase = object(content) && (typeof content.value === "number" || typeof content.value === "string") ? Number(content.value) : Number.NaN;
    if (!Object.hasOwn(PHASE_KEYS, phase)) return { error: "moodle_workshop_phase_unavailable", status: response.status };
    return { status: response.status, name: activity.name, phase, phaseKey: PHASE_KEYS[phase] };
  };
  try {
    const context = currentContext();
    if (input?.mode !== "execute" || !context) return failure("moodle_session_unavailable");
    if (!Number.isFinite(input.expiresAt) || Date.now() >= input.expiresAt) return failure("moodle_execution_expired");
    const definition = expectedOperation(input.operation);
    if (!definition) return failure("moodle_operation_refused");
    if (!bindingValid(context, input.binding)) return failure("moodle_binding_mismatch");
    if (input.privateAttachment !== undefined || input.privateConversation !== undefined) return failure("moodle_workshop_attachment_refused");
    const courseId = id(input.binding.courseId);
    const proofFor = (extra) => ({
      exact_module_binding: `${MODEDIT_PATH}?modulename=${MODULE}`,
      required_capability: definition.capability,
      learner_identity: "never_returned",
      phase_change: "not_available",
      ...extra,
    });

    if (definition.kind === "phase") {
      const args = moduleArguments(input.arguments, courseId);
      if (!args) return failure("moodle_workshop_arguments_invalid");
      const read = await overviewPhase(context, args.courseId, args.moduleId);
      if (read.error) return failure(read.error, read.status);
      return {
        ok: true,
        sent: true,
        status: read.status,
        data: {
          course_id: Number(args.courseId),
          module_id: Number(args.moduleId),
          name: read.name,
          phase: read.phase,
          phase_key: read.phaseKey,
          proof: proofFor({ native_route: "/lib/ajax/service.php#core_courseformat_get_overview_information", reads: "stored phase only" }),
        },
      };
    }

    if (definition.kind === "read") {
      const args = moduleArguments(input.arguments, courseId);
      if (!args) return failure("moodle_workshop_arguments_invalid");
      const form = await loadForm(context, settingsDescriptor(args.courseId, args.moduleId));
      if (form.error) return failure(form.error, form.status);
      return {
        ok: true,
        sent: true,
        status: form.status,
        data: {
          ...output(args.courseId, form, { module_id: Number(args.moduleId) }),
          proof: proofFor({ native_route: `${MODEDIT_PATH}?update=${args.moduleId}`, editor_file_areas: form.fileManagers.map(({ name, state }) => `${name}:${state}`) }),
        },
        snapshot_digest: form.snapshotDigest,
      };
    }

    if (definition.kind === "create-read") {
      const args = creationFormArguments(input.arguments, courseId);
      if (!args) return failure("moodle_workshop_arguments_invalid");
      const section = await sectionFor(context, args.courseId, args.sectionId);
      if (section.error) return failure(section.error, section.status);
      const form = await loadForm(context, creationDescriptor(args.courseId, args.sectionId, section.sectionNumber));
      if (form.error) return failure(form.error, form.status);
      if (!selectAllows(form.document, "visible", "0")) return failure("moodle_workshop_hidden_create_unavailable", form.status);
      return {
        ok: true,
        sent: true,
        status: form.status,
        data: {
          ...output(args.courseId, form, { section_id: Number(args.sectionId) }),
          proof: proofFor({ native_route: `${MODEDIT_PATH}?add=${MODULE}`, created_phase: "setup", created_visibility: "hidden" }),
        },
        snapshot_digest: form.snapshotDigest,
      };
    }

    if (definition.kind === "create") {
      const args = createArguments(input.arguments, courseId);
      if (!args) return failure("moodle_workshop_arguments_invalid");
      const section = await sectionFor(context, args.courseId, args.sectionId);
      if (section.error) return failure(section.error, section.status);
      const before = await loadForm(context, creationDescriptor(args.courseId, args.sectionId, section.sectionNumber));
      if (before.error) return failure(before.error, before.status);
      if (before.snapshotDigest !== args.settings.expected_digest) return failure("moodle_expected_digest_mismatch", before.status);
      const refusal = filesRefusal(before);
      if (refusal) return failure(refusal, before.status);
      if (!selectAllows(before.document, "visible", "0")) return failure("moodle_workshop_hidden_create_unavailable", before.status);
      if (checkboxOn(before.values, "phaseswitchassessment")) return failure("moodle_workshop_automatic_phase_switch_refused", before.status);
      if (!settingChanges(before, args.settings)) return failure("moodle_workshop_setting_not_writable", before.status);

      // The form is loaded again immediately before the dispatch, so the POST
      // carries the draft areas and the session this exact form was rendered
      // with, and so a form the site changed in between is refused unsent.
      const sendContext = currentContext();
      if (!sameContext(context, sendContext) || !bindingValid(sendContext, input.binding)) return failure("moodle_binding_mismatch");
      const section2 = await sectionFor(sendContext, args.courseId, args.sectionId);
      if (section2.error) return failure(section2.error, section2.status);
      if (section2.sectionNumber !== section.sectionNumber) return failure("moodle_workshop_section_target_invalid", section2.status);
      const form = await loadForm(sendContext, creationDescriptor(args.courseId, args.sectionId, section2.sectionNumber));
      if (form.error) return failure(form.error, form.status);
      if (form.snapshotDigest !== args.settings.expected_digest) return failure("moodle_expected_digest_mismatch", form.status);
      const sendRefusal = filesRefusal(form);
      if (sendRefusal) return failure(sendRefusal, form.status);
      const changed = settingChanges(form, args.settings);
      if (!changed) return failure("moodle_workshop_setting_not_writable", form.status);
      if (!selectAllows(form.document, "visible", "0")) return failure("moodle_workshop_hidden_create_unavailable", form.status);
      const priorState = await courseState(sendContext, args.courseId);
      if (priorState.error) return failure(priorState.error, priorState.status);
      applySettings(form.formData, args.settings);
      form.formData.delete("visible");
      form.formData.append("visible", "0");
      const posted = await postWorkshopForm(sendContext, form, args.courseId);
      if (posted.error) return failure(posted.error, form.status);
      if (posted.rejected) {
        return { ok: false, sent: true, status: posted.status, verification: { schema: "morrow.browser-verification.v1", status: "mismatch", reason: posted.rejected }, error: posted.rejected };
      }
      if (posted.unconfirmed) return unconfirmed(posted.unconfirmed, posted.status);

      const savedState = await courseState(sendContext, args.courseId);
      if (savedState.error) return unconfirmed("moodle_workshop_readback_unconfirmed", posted.status);
      const priorIds = new Set(priorState.activities.map((entry) => id(entry?.id)).filter(Boolean));
      const created = savedState.activities.filter((entry) => object(entry) && id(entry.id) && !priorIds.has(id(entry.id))
        && entry.module === MODULE && entry.name === args.settings.name && id(entry.sectionid) === args.sectionId && entry.visible === false);
      if (created.length !== 1) return unconfirmed("moodle_workshop_create_unconfirmed", posted.status);
      const moduleId = id(created[0].id);
      const after = await loadForm(sendContext, settingsDescriptor(args.courseId, moduleId));
      if (after.error) return unconfirmed("moodle_workshop_readback_unconfirmed", posted.status);
      // The saved form and the course state are the authoritative readbacks. The
      // phase is read as well, and a phase that is not the setup phase is a
      // mismatch, but a site that does not let this account read the overview of
      // a hidden activity leaves the phase unread rather than the create unknown.
      const phase = await overviewPhase(sendContext, args.courseId, moduleId);
      const phaseRead = phase.error ? null : phase.phase;

      const data = output(args.courseId, after, { module_id: Number(moduleId), section_id: Number(args.sectionId) });
      const matches = settingsMatch(data, args.settings) && data.visible === false
        && (phaseRead === null || phaseRead === 10)
        && defaultsPreserved(form.values, after.values, [...changed, "visible"]);
      const result = {
        ok: matches,
        sent: true,
        status: posted.status ?? after.status,
        data: {
          ...data,
          phase: phaseRead,
          phase_key: phase.error ? null : phase.phaseKey,
          proof: proofFor({ native_route: `${MODEDIT_PATH}?add=${MODULE}`, created_phase: phase.error ? "unread" : phase.phaseKey, created_visibility: "hidden" }),
        },
        snapshot_digest: after.snapshotDigest,
        verification: { schema: "morrow.browser-verification.v1", status: matches ? "verified" : "mismatch", ...(matches ? {} : { reason: "moodle_workshop_readback_mismatch" }) },
      };
      return matches ? result : { ...result, error: "moodle_write_not_verified" };
    }

    const args = settingsArguments(input.arguments, courseId);
    if (!args) return failure("moodle_workshop_arguments_invalid");
    const before = await loadForm(context, settingsDescriptor(args.courseId, args.moduleId));
    if (before.error) return failure(before.error, before.status);
    if (before.snapshotDigest !== args.expectedDigest) return failure("moodle_expected_digest_mismatch", before.status);

    const preflightContext = currentContext();
    if (!sameContext(context, preflightContext) || !bindingValid(preflightContext, input.binding)) return failure("moodle_binding_mismatch");
    const form = await loadForm(preflightContext, settingsDescriptor(args.courseId, args.moduleId));
    if (form.error) return failure(form.error, form.status);
    if (form.snapshotDigest !== args.expectedDigest) return failure("moodle_expected_digest_mismatch", form.status);
    const refusal = filesRefusal(form);
    if (refusal) return failure(refusal, form.status);
    // Moodle's own cron switches a Workshop from the submission phase to the
    // assessment phase once this setting is on and the submission deadline has
    // passed, so a date change here would schedule a phase change.
    if (checkboxOn(form.values, "phaseswitchassessment") && DATES.some(([argument]) => Object.hasOwn(args.settings, argument))) {
      return failure("moodle_workshop_automatic_phase_switch_refused", form.status);
    }
    const changed = settingChanges(form, args.settings);
    if (!changed || !changed.length) return failure("moodle_workshop_setting_not_writable", form.status);
    const beforeProtected = await protectedDigest(form.values, changed);
    applySettings(form.formData, args.settings);

    const sendContext = currentContext();
    if (!sameContext(preflightContext, sendContext) || !bindingValid(sendContext, input.binding)) return failure("moodle_binding_mismatch");
    const posted = await postWorkshopForm(sendContext, form, args.courseId);
    if (posted.error) return failure(posted.error, form.status);
    if (posted.rejected) {
      return { ok: false, sent: true, status: posted.status, verification: { schema: "morrow.browser-verification.v1", status: "mismatch", reason: posted.rejected }, error: posted.rejected };
    }
    if (posted.unconfirmed) return unconfirmed(posted.unconfirmed, posted.status);

    const after = await loadForm(sendContext, settingsDescriptor(args.courseId, args.moduleId));
    if (after.error) return unconfirmed("moodle_workshop_readback_unconfirmed", posted.status);
    const data = output(args.courseId, after, { module_id: Number(args.moduleId) });
    const afterProtected = await protectedDigest(after.values, changed);
    const matches = settingsMatch(data, args.settings) && afterProtected === beforeProtected;
    const result = {
      ok: matches,
      sent: true,
      status: posted.status ?? after.status,
      data: {
        ...data,
        protected_settings_digest: afterProtected,
        protected_setting_names: protectedNames(after.values, changed),
        proof: proofFor({ native_route: `${MODEDIT_PATH}?update=${args.moduleId}`, changed_controls: changed }),
      },
      snapshot_digest: after.snapshotDigest,
      verification: { schema: "morrow.browser-verification.v1", status: matches ? "verified" : "mismatch", ...(matches ? {} : { reason: "moodle_workshop_readback_mismatch" }) },
    };
    return matches ? result : { ...result, error: "moodle_write_not_verified" };
  } catch (error) {
    if (writeAttempted) return unconfirmed("moodle_workshop_save_unknown");
    const message = String(error?.message || error);
    return failure(message.startsWith("moodle_") ? message : "moodle_workshop_execution_failed");
  }
}
