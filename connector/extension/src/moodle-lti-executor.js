/**
 * The Moodle External tool (`mod_lti`) route: read one activity, read the
 * creation form for one named preconfigured tool, create one hidden activity,
 * and change a bounded set of its settings.
 *
 * This route never launches anything. It uses exactly two native routes:
 * `/lib/ajax/service.php` for the course state and the section's own content
 * item list, and `/course/modedit.php` for the native activity form and its one
 * save. It never opens `/mod/lti/view.php`, `launch.php`, `auth.php`,
 * `token.php`, `service.php`, `grade.php`, `return.php`, `contentitem.php` or
 * `contentitem_return.php`, and the save is sent with `redirect: "manual"` so
 * Moodle's own redirect target is never fetched.
 *
 * Morrow cannot verify anything about the external tool. The tool runs on
 * another site, under another operator, and nothing the browser can read here
 * says what it does, what it stores, or whether it works. Every result repeats
 * that as `external_tool_verification: "not_possible"`.
 *
 * Three boundaries are specific to this module.
 *
 * 1. The consumer key (`resourcekey`) and the shared secret (`password`) stay
 *    in Chrome. They are never returned, never accepted as an argument, and
 *    never placed in a digest preimage: the value map records only whether each
 *    one is set. The save resends both verbatim from the form Morrow reloaded
 *    immediately before it, so neither is read, changed, or moved.
 *    This is the `transientField` rule of
 *    connector/extension/src/moodle-executor.js:276, extended to the two LTI
 *    controls that regex does not name.
 * 2. Only a preconfigured tool the approval names is used. Moodle 4.3 onward
 *    refuses a manually configured instance outright
 *    (`lti:addmanualinstanceprohibitederror`), and the legacy read-only form for
 *    older manual instances is refused here as well, because that form exposes
 *    the manual configuration fields including the key and the secret. Morrow
 *    cannot tell from the browser whether a preconfigured tool is defined at
 *    site level or at course level, so it holds every tool to the same rule: the
 *    approval must name the exact tool, by its ID and by the name the course's
 *    own activity list shows, and any other tool is refused before the form is
 *    even read.
 * 3. Grade passback may be turned on, and it is stated plainly in the approval
 *    that this lets the external tool write a grade into the course gradebook
 *    for every learner. It cannot be turned off here: `lti_update_instance`
 *    answers a cleared `instructorchoiceacceptgrades` by calling
 *    `lti_grade_item_delete`, which removes the activity's gradebook item and
 *    the grades in it.
 *
 * Native source:
 * https://github.com/moodle/moodle/blob/v5.2.2/public/mod/lti/mod_form.php#L73-L89
 * (manual instances refused), #L353-L520 (the preconfigured-tool form),
 * https://github.com/moodle/moodle/blob/v5.2.2/public/mod/lti/lib.php#L82-L182
 * (`lti_add_instance`, `lti_update_instance` and the grade-item effect),
 * https://github.com/moodle/moodle/blob/v5.2.2/public/mod/lti/lib.php#L233-L280
 * and https://github.com/moodle/moodle/blob/v5.2.2/public/mod/lti/locallib.php#L2348-L2394
 * (the course's preconfigured tool list and its `/course/modedit.php` link).
 *
 * Chrome serializes this function for a MAIN-world injection. Keep every
 * dependency inside the function body.
 */
export async function executeMoodleLtiInPage(rawInput) {
  const PROVIDER = "moodle";
  const SCHEMA = "morrow.moodle-lti-activity.v1";
  const MODULE = "lti";
  const STATE_METHOD = "core_courseformat_get_state";
  const CONTENT_ITEMS_METHOD = "core_courseformat_get_section_content_items";
  const MODEDIT_PATH = "/course/modedit.php";
  const COURSE_VIEW_PATH = "/course/view.php";
  const AJAX_PATH = "/lib/ajax/service.php";
  const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
  const MAX_FORM_ENTRIES = 600;
  const MAX_FORM_BYTES = 512 * 1024;
  const MAX_VALUE_BYTES = 64 * 1024;
  const MAX_ACTIVITIES = 10_000;
  const MAX_CONTENT_ITEMS = 2_000;
  // mod_lti adds the name rule `maxlength 255` on the preconfigured-tool form.
  const MAX_NAME_LENGTH = 255;
  const MAX_TOOL_NAME_LENGTH = 255;
  const ID = /^[1-9][0-9]{0,18}$/;
  const COUNT = /^(?:0|[1-9][0-9]{0,8})$/;
  const DIGEST = /^[a-f0-9]{64}$/;
  const CONTENT_ITEM_NAME = /^lti_type_([1-9][0-9]{0,18})$/;
  // The two LTI credential controls. Neither is returned and neither is read.
  const SECRET_FIELD = /^(?:resourcekey|password)$/;
  const TRANSIENT_FIELD = /(?:sesskey|statekey|_qf__|csrf|token|secret|password|authorization|cookie|(?:^|[\[_-])(?:draft|itemid)(?:$|[\]_-]))/i;
  const DRAFT_ITEM_FIELD = /\[itemid\]$/;
  // The intro editor is the only file-bearing control the LTI form declares.
  const ALLOWED_DRAFT_FIELD = "introeditor[itemid]";
  // Sending this control makes Moodle notify every enrolled learner.
  const NOTIFICATION_FIELD = "coursecontentnotification";
  // The deep-linking button. It is never a successful control, and it is never sent.
  const CONTENT_SELECTION_FIELD = "selectcontent";
  const ACCEPT_GRADES_FIELD = "instructorchoiceacceptgrades";
  const definitions = Object.freeze({
    "moodle.form.course.modedit.lti.read.v1": { toolName: "moodle_get_lti", readOnly: true, kind: "activity" },
    "moodle.form.course.modedit.lti.create.read.v1": { toolName: "moodle_get_lti_creation_form", readOnly: true, kind: "creation-form" },
    "moodle.form.course.modedit.lti.create.write.v1": { toolName: "moodle_create_lti", readOnly: false, kind: "create" },
    "moodle.form.course.modedit.lti.write.v1": { toolName: "moodle_update_lti", readOnly: false, kind: "update" },
  });
  const CREATION_KINDS = ["creation-form", "create"];

  const parseInput = () => {
    if (typeof rawInput !== "string") return rawInput;
    try { return JSON.parse(rawInput); } catch { return null; }
  };
  const input = parseInput();
  let dispatched = false;
  const object = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
  const failure = (error, status) => ({ ok: false, sent: false, ...(Number.isInteger(status) ? { status } : {}), error });
  const unconfirmedWrite = (error, status) => ({
    ok: false,
    sent: true,
    ...(Number.isInteger(status) ? { status } : {}),
    outcomeUnknown: true,
    verification: { schema: "morrow.browser-verification.v1", status: "unconfirmed", reason: error },
    error,
  });
  // The dispatch landed and Morrow read what it produced, so the outcome is
  // known: nothing was saved, or the saved state is not the approved one.
  const appliedButRefused = (error, status) => ({
    ok: false,
    sent: true,
    ...(Number.isInteger(status) ? { status } : {}),
    outcomeUnknown: false,
    verification: { schema: "morrow.browser-verification.v1", status: "mismatch", reason: error },
    error,
  });
  const id = (value) => {
    const text = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : typeof value === "string" ? value : "";
    return ID.test(text) ? text : "";
  };
  const sectionNumber = (value) => {
    const text = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : typeof value === "string" ? value : "";
    return COUNT.test(text) ? text : "";
  };
  const CONTROL = /[\u0000-\u001f\u007f]/;
  const validText = (value, maximum) => typeof value === "string" && value.length > 0 && value.length <= maximum
    && value === value.trim() && !CONTROL.test(value);
  const collapsed = (value, maximum = 1_333) => {
    const text = String(value ?? "").replace(/\s+/g, " ").trim();
    return text && text.length <= maximum && !CONTROL.test(text) ? text : "";
  };
  const stable = (value) => {
    if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
    if (object(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
    return JSON.stringify(value === undefined ? null : value);
  };
  const digest = async (value) => {
    if (!globalThis.crypto?.subtle || typeof globalThis.TextEncoder !== "function") throw new Error("moodle_lti_digest_unavailable");
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
  const exactKeys = (value, required, optional = []) => object(value)
    && required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
  const argumentsFor = (definition, args, binding) => {
    const courseId = id(binding?.courseId);
    if (!courseId) return null;
    const creating = CREATION_KINDS.includes(definition.kind);
    const targetKey = creating ? "section_id" : "module_id";
    const required = definition.kind === "creation-form" ? ["course_id", targetKey, "tool_type_id"]
      : definition.kind === "create" ? ["course_id", targetKey, "tool_type_id", "tool_name", "name", "expected_digest"]
        : definition.kind === "update" ? ["course_id", targetKey, "expected_digest"]
          : ["course_id", targetKey];
    const optional = definition.kind === "update" ? ["name", "accept_grades"] : [];
    if (!exactKeys(args, required, optional) || id(args.course_id) !== courseId || !id(args[targetKey])) return null;
    const target = { courseId, targetId: id(args[targetKey]) };
    if (definition.kind === "activity") return target;
    if (definition.kind === "creation-form") {
      const toolTypeId = id(args.tool_type_id);
      return toolTypeId ? { ...target, toolTypeId } : null;
    }
    if (!DIGEST.test(String(args.expected_digest || ""))) return null;
    if (definition.kind === "update") {
      const settings = {};
      if (Object.hasOwn(args, "name")) {
        // A name Moodle would collapse could never equal the name it saves.
        if (!validText(args.name, MAX_NAME_LENGTH) || collapsed(args.name, MAX_NAME_LENGTH) !== args.name) return null;
        settings.name = args.name;
      }
      if (Object.hasOwn(args, "accept_grades")) {
        // Only turning grade passback on is offered. Turning it off deletes the
        // activity's gradebook item and the grades in it.
        if (args.accept_grades !== true) return null;
        settings.accept_grades = true;
      }
      return Object.keys(settings).length ? { ...target, expectedDigest: args.expected_digest, settings } : null;
    }
    const toolTypeId = id(args.tool_type_id);
    if (!toolTypeId || !validText(args.tool_name, MAX_TOOL_NAME_LENGTH) || collapsed(args.tool_name, MAX_TOOL_NAME_LENGTH) !== args.tool_name) return null;
    return validText(args.name, MAX_NAME_LENGTH) && collapsed(args.name, MAX_NAME_LENGTH) === args.name
      ? { ...target, toolTypeId, toolName: args.tool_name, name: args.name, expectedDigest: args.expected_digest }
      : null;
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
    if (received.origin !== expected.origin || received.pathname !== expected.pathname
      || received.hash || received.username || received.password) return false;
    const sort = (entries) => entries.sort(([leftName, leftValue], [rightName, rightValue]) => leftName.localeCompare(rightName) || leftValue.localeCompare(rightValue));
    return stable(sort([...received.searchParams.entries()])) === stable(sort([...expected.searchParams.entries()]));
  };
  const boundedText = async (response) => {
    const declared = response?.headers?.get?.("content-length");
    if (declared !== null && declared !== undefined && (!COUNT.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) return null;
    let text;
    try { text = await response.text(); } catch { return null; }
    return typeof text === "string" && text.length <= MAX_RESPONSE_BYTES ? text : null;
  };
  const readPage = async (context, endpoint) => {
    let response;
    try {
      response = await fetch(endpoint, { method: "GET", credentials: "include", cache: "no-store", redirect: "error", headers: { Accept: "text/html" } });
    } catch { return { error: "moodle_lti_read_unavailable" }; }
    if (!response.ok || !sameRoute(response.url, endpoint) || !sameContext(context, currentContext())) {
      return { error: "moodle_lti_read_unavailable", status: response.status };
    }
    const html = await boundedText(response);
    if (html === null || typeof globalThis.DOMParser !== "function") return { error: "moodle_lti_read_unavailable", status: response.status };
    try { return { status: response.status, document: new DOMParser().parseFromString(html, "text/html") }; }
    catch { return { error: "moodle_lti_read_unavailable", status: response.status }; }
  };
  const ajax = async (context, method, args, code) => {
    const endpoint = urlFor(context, AJAX_PATH, { sesskey: context.sesskey, info: method });
    let response;
    try {
      response = await fetch(endpoint, {
        method: "POST", credentials: "include", cache: "no-store", redirect: "error",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify([{ index: 0, methodname: method, args }]),
      });
    } catch { return { error: code }; }
    if (!response.ok || !sameContext(context, currentContext())) return { error: code, status: response.status };
    const raw = await boundedText(response);
    if (raw === null) return { error: code, status: response.status };
    try {
      const payload = JSON.parse(raw);
      const entry = Array.isArray(payload) && payload.length === 1 && object(payload[0]) ? payload[0] : null;
      if (!entry || entry.error || entry.exception || !("data" in entry)) return { error: code, status: response.status };
      return { status: response.status, data: typeof entry.data === "string" ? JSON.parse(entry.data) : entry.data };
    } catch { return { error: code, status: response.status }; }
  };
  const courseState = async (context, courseId) => {
    const result = await ajax(context, STATE_METHOD, { courseid: Number(courseId) }, "moodle_lti_course_state_unavailable");
    if (result.error) return result;
    const value = result.data;
    if (!object(value) || !object(value.course) || id(value.course.id) !== courseId
      || !Array.isArray(value.section) || !Array.isArray(value.cm)
      || value.cm.length > MAX_ACTIVITIES || value.section.length > MAX_ACTIVITIES) {
      return { error: "moodle_lti_course_state_unavailable", status: result.status };
    }
    return { status: result.status, course: value.course, sections: value.section, activities: value.cm };
  };
  /**
   * The course's own preconfigured External tools for one section, from the
   * native activity list. Each LTI item is named `lti_type_<typeid>` and
   * carries the tool's title and its `/course/modedit.php` link. The list is
   * empty without `mod/lti:addpreconfiguredinstance` at that course context.
   */
  const sectionTools = async (context, courseId, sectionId) => {
    const result = await ajax(context, CONTENT_ITEMS_METHOD, { courseid: Number(courseId), sectionid: Number(sectionId) }, "moodle_lti_tools_unavailable");
    if (result.error) return result;
    const value = result.data;
    const items = object(value) && Array.isArray(value.content_items) ? value.content_items : null;
    if (!items || items.length > MAX_CONTENT_ITEMS) return { error: "moodle_lti_tools_unavailable", status: result.status };
    const tools = new Map();
    for (const item of items) {
      if (!object(item)) return { error: "moodle_lti_tools_unavailable", status: result.status };
      const matched = CONTENT_ITEM_NAME.exec(String(item.name || ""));
      if (!matched || String(item.componentname || "") !== `mod_${MODULE}`) continue;
      const typeId = matched[1];
      const name = collapsed(item.title, MAX_TOOL_NAME_LENGTH);
      let link;
      try { link = new URL(String(item.link || ""), context.siteUrl); } catch { return { error: "moodle_lti_tools_unavailable", status: result.status }; }
      const params = [...link.searchParams.keys()];
      const linkMatches = link.origin === context.origin && link.pathname === `${context.basePath}${MODEDIT_PATH}`
        && link.searchParams.get("add") === MODULE && link.searchParams.get("course") === courseId
        && link.searchParams.get("typeid") === typeId
        && params.every((key) => ["add", "course", "typeid", "return", "sr"].includes(key));
      if (!name || !linkMatches || tools.has(typeId)) return { error: "moodle_lti_tools_unavailable", status: result.status };
      tools.set(typeId, { typeId, name });
    }
    return { status: result.status, tools };
  };
  const courseTarget = (state) => ({ field: "course_id", label: "Course", name: collapsed(state.course?.fullname || state.course?.name) || "Moodle course" });
  const sectionOf = (state, sectionId) => {
    const matches = state.sections.filter((entry) => object(entry) && id(entry.id) === sectionId);
    if (matches.length !== 1) return null;
    const number = sectionNumber(matches[0].number);
    return number === "" ? null : { id: sectionId, number, name: collapsed(matches[0].title || matches[0].rawtitle) || "Selected course section" };
  };
  const ltiModuleOf = (state, moduleId) => {
    const matches = state.activities.filter((entry) => object(entry) && id(entry.id) === moduleId);
    if (matches.length !== 1 || String(matches[0].module || "") !== MODULE) return null;
    const sectionId = id(matches[0].sectionid);
    const name = collapsed(matches[0].name);
    return sectionId && name && typeof matches[0].visible === "boolean" ? { id: moduleId, sectionId, name, visible: matches[0].visible } : null;
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
  /**
   * The value map the digest is taken over. A consumer key and a shared secret
   * are reduced to whether they are set, so no credential ever enters a digest
   * preimage or a result. Transient controls are dropped because they change on
   * every load.
   */
  const valuesFrom = (entries) => {
    const values = {};
    for (const [name, value] of entries) {
      if (SECRET_FIELD.test(name)) {
        values[name] = value ? "set" : "";
        continue;
      }
      if (TRANSIENT_FIELD.test(name)) continue;
      if (values[name] === undefined) values[name] = value;
      else if (Array.isArray(values[name])) values[name].push(value);
      else values[name] = [values[name], value];
    }
    return values;
  };
  const nativeForm = (documentValue, endpoint) => {
    const matches = [...documentValue.querySelectorAll("form")].filter((form) => {
      if (String(form.getAttribute("method") || "").toLowerCase() !== "post") return false;
      const action = form.getAttribute("action");
      if (!action) return false;
      try {
        // moodleform posts to the page URL with its query stripped, so an
        // action that carries one is not the native form Morrow read.
        const nativeAction = new URL(action, endpoint);
        return nativeAction.origin === endpoint.origin && nativeAction.pathname === endpoint.pathname
          && !nativeAction.search && !nativeAction.hash && !nativeAction.username && !nativeAction.password;
      } catch { return false; }
    });
    return matches.length === 1 ? matches[0] : null;
  };
  const saveAndReturnSubmit = (form) => {
    // moodleform_mod names its "Save and return to course" control submitbutton2.
    const buttons = [...form.querySelectorAll('input[type="submit"][name="submitbutton2"], button[type="submit"][name="submitbutton2"]')]
      .filter((element) => !element.disabled && typeof element.value === "string" && element.value.length <= 500);
    return buttons.length === 1 ? { name: buttons[0].name, value: buttons[0].value } : null;
  };
  const fileAreaProblem = (form, entries) => {
    if (form.querySelector('[data-fieldtype="filemanager"], [data-fieldtype="filepicker"], input[type="file"]')) return "moodle_lti_file_area_unexpected";
    const draftFields = [...new Set(entries.filter(([name]) => DRAFT_ITEM_FIELD.test(name)).map(([name]) => name))];
    if (draftFields.length > 1 || (draftFields.length === 1 && draftFields[0] !== ALLOWED_DRAFT_FIELD)) return "moodle_lti_file_area_unexpected";
    return "";
  };
  const namedControls = (form, name) => [...form.querySelectorAll("[name]")].filter((control) => control.getAttribute("name") === name);
  const textWritable = (form, name) => {
    const controls = namedControls(form, name).filter((control) => ["INPUT", "TEXTAREA"].includes(control.tagName));
    return controls.length === 1 && !controls[0].disabled;
  };
  // Moodle renders an advcheckbox as a hidden "0" control plus a checkbox "1"
  // control with the same name, so both must be there and neither disabled.
  const advCheckboxWritable = (form, name) => {
    const controls = namedControls(form, name);
    const hidden = controls.filter((control) => control.tagName === "INPUT" && String(control.getAttribute("type") || "").toLowerCase() === "hidden");
    const boxes = controls.filter((control) => control.tagName === "INPUT" && String(control.getAttribute("type") || "").toLowerCase() === "checkbox");
    return controls.length === 2 && hidden.length === 1 && boxes.length === 1 && !hidden[0].disabled && !boxes[0].disabled;
  };
  // The native control must itself offer the value Morrow sends, so no value
  // reaches Moodle that the form does not already permit.
  const selectAllows = (form, name, value) => {
    const selects = namedControls(form, name).filter((control) => control.tagName === "SELECT");
    if (selects.length !== 1 || selects[0].disabled || selects[0].multiple) return false;
    return [...selects[0].options || []].some((option) => String(option.value || "") === value);
  };
  const one = (values, name) => typeof values[name] === "string" ? values[name] : "";
  const anyValue = (values, name, wanted) => {
    const value = values[name];
    return Array.isArray(value) ? value.includes(wanted) : value === wanted;
  };
  const endpointForCreationForm = (context, courseId, sectionId, toolTypeId) => urlFor(context, MODEDIT_PATH, { add: MODULE, course: courseId, sectionid: sectionId, typeid: toolTypeId, return: 0 });
  const endpointForActivity = (context, moduleId) => urlFor(context, MODEDIT_PATH, { update: moduleId, return: 0 });
  /**
   * Reads one native modedit form and proves it is the preconfigured-tool LTI
   * form for the exact approved target. `identity` names the hidden controls
   * that must be there exactly once with exactly these values.
   */
  const ltiFormState = (documentValue, context, endpoint, identity) => {
    const form = nativeForm(documentValue, endpoint);
    if (!form) return { error: "moodle_lti_form_invalid" };
    const entries = entriesFor(form);
    if (!entries) return { error: "moodle_lti_form_invalid" };
    const byName = (name) => entries.filter(([entryName]) => entryName === name).map(([, value]) => value);
    const once = (name, expected) => {
      const values = byName(name);
      return values.length === 1 && (expected === undefined || values[0] === expected);
    };
    if (!once("sesskey", context.sesskey)) return { error: "moodle_form_session_mismatch" };
    if (!once("modulename", MODULE)) return { error: "moodle_lti_form_invalid" };
    for (const [name, value] of Object.entries(identity)) {
      if (!once(name, value)) return { error: "moodle_lti_form_invalid" };
    }
    // urlmatchedtypeid exists only in the preconfigured-tool definition. Its
    // absence means the legacy manual-configuration form, which exposes the
    // launch URL, the consumer key and the shared secret as editable controls.
    if (!once("urlmatchedtypeid")) return { error: "moodle_lti_legacy_instance_refused" };
    const toolTypeId = once("typeid") ? id(byName("typeid")[0]) : "";
    if (!toolTypeId) return { error: "moodle_lti_legacy_instance_refused" };
    if (!once("name") || !once("introeditor[text]")) return { error: "moodle_lti_form_invalid" };
    if (!once("resourcekey") || !once("password")) return { error: "moodle_lti_form_invalid" };
    const areaProblem = fileAreaProblem(form, entries);
    if (areaProblem) return { error: areaProblem };
    const submit = saveAndReturnSubmit(form);
    if (!submit) return { error: "moodle_lti_form_invalid" };
    const values = valuesFrom(entries);
    // A result never carries the session key, whatever the control is called.
    if (Object.values(values).flat().includes(context.sesskey)) return { error: "moodle_lti_form_invalid" };
    const acceptGradesWritable = advCheckboxWritable(form, ACCEPT_GRADES_FIELD);
    const acceptGradesOffered = namedControls(form, ACCEPT_GRADES_FIELD).length > 0;
    return {
      entries,
      values,
      element: form,
      action: new URL(form.getAttribute("action"), endpoint).href,
      nativeSesskey: context.sesskey,
      submit,
      toolTypeId,
      name: collapsed(byName("name")[0], MAX_NAME_LENGTH),
      nameWritable: textWritable(form, "name"),
      hiddenAllowed: once("visible") && selectAllows(form, "visible", "0"),
      introductionEmpty: byName("introeditor[text]")[0].trim() === "",
      consumerKeyPresent: one(values, "resourcekey") === "set",
      sharedSecretPresent: one(values, "password") === "set",
      customParametersPresent: byName("instructorcustomparameters").some((value) => value.trim() !== ""),
      supportsContentSelection: byName("contentitem").length > 0,
      acceptGrades: acceptGradesOffered ? anyValue(values, ACCEPT_GRADES_FIELD, "1") : null,
      acceptGradesWritable,
      // Every control this route preserves. The two it can change are left out,
      // and the two credential controls are named but never valued.
      protectedFields: [...new Set(entries.map(([name]) => name)
        .filter((name) => !TRANSIENT_FIELD.test(name) || SECRET_FIELD.test(name))
        .filter((name) => name !== "name" && name !== ACCEPT_GRADES_FIELD))].sort(),
    };
  };
  const proofFor = (tool) => ({
    method: "native_form_read",
    route: MODEDIT_PATH,
    required_capability: "moodle/course:manageactivities",
    required_tool_capability: "mod/lti:addpreconfiguredinstance",
    scope: "one_external_tool_activity",
    module: MODULE,
    tool_source: tool ? "course_activity_list" : "not_listed_in_course",
    launch_requested: false,
    content_item_requested: false,
    external_tool_verification: "not_possible",
    credential_fields: "kept_in_browser",
  });
  const toolFields = (tool, form) => ({
    tool_type_id: Number(form.toolTypeId),
    tool_name: tool ? tool.name : null,
    tool_listed_in_course: Boolean(tool),
    supports_content_selection: form.supportsContentSelection,
    consumer_key_present: form.consumerKeyPresent,
    shared_secret_present: form.sharedSecretPresent,
    custom_parameters_present: form.customParametersPresent,
    accept_grades: form.acceptGrades,
    accept_grades_writable: form.acceptGradesWritable,
    introduction_empty: form.introductionEmpty,
  });
  const creationFormData = (courseId, section, tool, form) => ({
    schema: SCHEMA,
    provider: PROVIDER,
    course_id: Number(courseId),
    section_id: Number(section.id),
    section_number: Number(section.number),
    module: MODULE,
    ...toolFields(tool, form),
    visible: false,
    protected_setting_names: form.protectedFields,
    proof: proofFor(tool),
  });
  const activityData = (courseId, module, tool, form) => ({
    schema: SCHEMA,
    provider: PROVIDER,
    course_id: Number(courseId),
    module_id: Number(module.id),
    section_id: Number(module.sectionId),
    name: form.name,
    module: MODULE,
    ...toolFields(tool, form),
    visible: module.visible,
    protected_setting_names: form.protectedFields,
    proof: proofFor(tool),
  });
  // The digest binds the reviewed form values and the tool the course lists for
  // it, so a changed control or a renamed tool invalidates the review.
  const snapshotDigest = (form, tool) => digest({ values: form.values, tool: tool ? { type_id: tool.typeId, name: tool.name } : null });
  const protectedDigest = (form, changedNames) => {
    const copy = { ...form.values };
    for (const name of changedNames) delete copy[name];
    return digest({ values: copy });
  };
  const readCreationForm = async (context, args) => {
    const state = await courseState(context, args.courseId);
    if (state.error) return failure(state.error, state.status);
    const section = sectionOf(state, args.targetId);
    if (!section) return failure("moodle_lti_section_target_invalid", state.status);
    const listed = await sectionTools(context, args.courseId, args.targetId);
    if (listed.error) return failure(listed.error, listed.status);
    const tool = listed.tools.get(args.toolTypeId);
    if (!tool) return failure("moodle_lti_tool_not_available", listed.status);
    if (args.toolName !== undefined && args.toolName !== tool.name) return failure("moodle_lti_tool_not_named", listed.status);
    const endpoint = endpointForCreationForm(context, args.courseId, args.targetId, args.toolTypeId);
    const page = await readPage(context, endpoint);
    if (page.error) return failure(page.error, page.status);
    const form = ltiFormState(page.document, context, endpoint, { course: args.courseId, add: MODULE, section: section.number, update: "0", return: "0" });
    if (form.error) return failure(form.error, page.status);
    if (form.toolTypeId !== args.toolTypeId) return failure("moodle_lti_tool_mismatch", page.status);
    if (form.name !== "" || !form.introductionEmpty || !form.hiddenAllowed) return failure("moodle_lti_form_invalid", page.status);
    const data = creationFormData(args.courseId, section, tool, form);
    return {
      ok: true, sent: true, status: page.status, data,
      targets: [courseTarget(state), { field: "section_id", label: "Section", name: section.name }, { field: "tool_type_id", label: "External tool", name: tool.name }],
      snapshot_digest: await snapshotDigest(form, tool), form, section, tool, state,
    };
  };
  const readActivity = async (context, args) => {
    const state = await courseState(context, args.courseId);
    if (state.error) return failure(state.error, state.status);
    const module = ltiModuleOf(state, args.targetId);
    if (!module) return failure("moodle_lti_module_target_invalid", state.status);
    const listed = await sectionTools(context, args.courseId, module.sectionId);
    if (listed.error) return failure(listed.error, listed.status);
    const endpoint = endpointForActivity(context, args.targetId);
    const page = await readPage(context, endpoint);
    if (page.error) return failure(page.error, page.status);
    const form = ltiFormState(page.document, context, endpoint, { update: args.targetId, course: args.courseId, return: "0" });
    if (form.error) return failure(form.error, page.status);
    if (!form.name || form.name !== module.name) return failure("moodle_lti_module_target_invalid", page.status);
    const tool = listed.tools.get(form.toolTypeId) || null;
    const data = activityData(args.courseId, module, tool, form);
    return {
      ok: true, sent: true, status: page.status, data,
      targets: [courseTarget(state), { field: "module_id", label: "External tool activity", name: module.name }],
      snapshot_digest: await snapshotDigest(form, tool), form, module, tool, state,
    };
  };
  /**
   * Sends the one native save. The redirect is never followed, so no LTI launch,
   * deep-linking or report route can be reached whatever Moodle answers with.
   * Chromium exposes a manual same-origin POST redirect as opaqueredirect, so
   * the authoritative readback that follows is the confirmation.
   */
  const postForm = async (context, form, overrides) => {
    const preflight = currentContext();
    if (!sameContext(context, preflight) || form.nativeSesskey !== preflight?.sesskey) return { error: "moodle_form_session_mismatch", notSent: true };
    const body = new URLSearchParams();
    for (const [name, value] of form.entries) {
      // Never notify learners, and never carry the deep-linking control.
      if (name === NOTIFICATION_FIELD || name === CONTENT_SELECTION_FIELD) continue;
      if (Object.hasOwn(overrides, name)) continue;
      body.append(name, value);
    }
    for (const [name, replacements] of Object.entries(overrides)) {
      for (const value of replacements) body.append(name, value);
    }
    body.append(form.submit.name, form.submit.value);
    let response;
    try {
      dispatched = true;
      response = await fetch(form.action, {
        method: "POST", credentials: "include", cache: "no-store", redirect: "manual",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "text/html" }, body,
      });
    } catch { return { error: "unconfirmed" }; }
    // Chromium reports an opaqueredirect with status 0, which is not a status.
    const status = Number.isInteger(response.status) && response.status > 0 ? response.status : undefined;
    if (!sameContext(context, currentContext())) return { error: "unconfirmed", status };
    if (response.type === "opaqueredirect") return { sent: true };
    if ([301, 302, 303, 307, 308].includes(status)) {
      let redirect;
      try { redirect = new URL(response.headers.get("location") || "", form.action); } catch { return { error: "unconfirmed", status }; }
      const courseView = urlFor(context, COURSE_VIEW_PATH, { id: form.courseId });
      return redirect.origin === courseView.origin && redirect.pathname === courseView.pathname
        ? { sent: true, status }
        : { error: "unconfirmed", status };
    }
    const html = await boundedText(response);
    if (html === null || !response.ok || typeof globalThis.DOMParser !== "function") return { error: "unconfirmed", status };
    // Moodle answers its own validation failure by redisplaying the same form,
    // which saved nothing.
    let redisplayed;
    try {
      const documentValue = new DOMParser().parseFromString(html, "text/html");
      redisplayed = [...documentValue.querySelectorAll("form")].some((candidate) => {
        if (String(candidate.getAttribute("method") || "").toLowerCase() !== "post") return false;
        try {
          const action = new URL(candidate.getAttribute("action") || form.action, form.action);
          const expected = new URL(form.action);
          return action.origin === expected.origin && action.pathname === expected.pathname;
        } catch { return false; }
      });
    } catch { return { error: "unconfirmed", status }; }
    return redisplayed ? { error: "moodle_form_validation_failed", status, validation: true } : { error: "unconfirmed", status };
  };
  const runCreate = async (context, args) => {
    const before = await readCreationForm(context, args);
    if (!before.ok) return before;
    if (before.snapshot_digest !== args.expectedDigest) return failure("moodle_expected_digest_mismatch", before.status);
    if (!before.form.nameWritable) return failure("moodle_lti_setting_not_writable", before.status);
    const refreshed = await readCreationForm(context, args);
    if (!refreshed.ok) return refreshed;
    if (refreshed.snapshot_digest !== args.expectedDigest || refreshed.form.action !== before.form.action) {
      return failure("moodle_expected_digest_mismatch", refreshed.status);
    }
    // Whether a control is writable is a property of the reloaded page, not of
    // the digest, so the form that is actually sent is checked again.
    if (!refreshed.form.nameWritable) return failure("moodle_lti_setting_not_writable", refreshed.status);
    // The activity list read immediately before the dispatch is the baseline the
    // new module is found against, so nothing already there can match.
    const existingIds = new Set(refreshed.state.activities.map((entry) => id(object(entry) ? entry.id : "")).filter(Boolean));
    refreshed.form.courseId = args.courseId;
    const posted = await postForm(context, refreshed.form, { name: [args.name], visible: ["0"] });
    if (posted.error) {
      if (posted.notSent === true) return failure(posted.error, refreshed.status);
      if (posted.validation === true) return appliedButRefused(posted.error, posted.status);
      return unconfirmedWrite("moodle_lti_create_unconfirmed", posted.status);
    }
    const after = await courseState(context, args.courseId);
    if (after.error) return unconfirmedWrite("moodle_lti_create_unconfirmed", posted.status);
    const created = after.activities.filter((entry) => object(entry) && !existingIds.has(id(entry.id))
      && String(entry.module || "") === MODULE && collapsed(entry.name) === args.name
      && id(entry.sectionid) === args.targetId && entry.visible === false);
    const moduleId = created.length === 1 ? id(created[0].id) : "";
    if (!moduleId) return unconfirmedWrite("moodle_lti_create_not_verified", posted.status);
    const saved = await readActivity(context, { courseId: args.courseId, targetId: moduleId });
    if (!saved.ok) return unconfirmedWrite("moodle_lti_create_not_verified", posted.status);
    if (saved.data.name !== args.name || saved.data.section_id !== Number(args.targetId) || saved.data.visible !== false
      || saved.data.tool_type_id !== Number(args.toolTypeId) || saved.data.tool_name !== args.toolName) {
      return unconfirmedWrite("moodle_lti_create_not_verified", posted.status);
    }
    return {
      ok: true, sent: true, status: posted.status ?? saved.status,
      data: { ...saved.data, created: true },
      targets: saved.targets, snapshot_digest: saved.snapshot_digest,
      verification: { schema: "morrow.browser-verification.v1", status: "verified" },
    };
  };
  const runUpdate = async (context, args) => {
    const before = await readActivity(context, args);
    if (!before.ok) return before;
    if (before.snapshot_digest !== args.expectedDigest) return failure("moodle_expected_digest_mismatch", before.status);
    const changedNames = [];
    if (Object.hasOwn(args.settings, "name")) {
      if (!before.form.nameWritable) return failure("moodle_lti_setting_not_writable", before.status);
      changedNames.push("name");
    }
    if (Object.hasOwn(args.settings, "accept_grades")) {
      if (!before.form.acceptGradesWritable) return failure("moodle_lti_setting_not_writable", before.status);
      changedNames.push(ACCEPT_GRADES_FIELD);
    }
    const refreshed = await readActivity(context, args);
    if (!refreshed.ok) return refreshed;
    if (refreshed.snapshot_digest !== args.expectedDigest || refreshed.form.action !== before.form.action) {
      return failure("moodle_expected_digest_mismatch", refreshed.status);
    }
    // Whether a control is writable is a property of the reloaded page, not of
    // the digest, so the form that is actually sent is checked again.
    if (changedNames.includes("name") && !refreshed.form.nameWritable) return failure("moodle_lti_setting_not_writable", refreshed.status);
    if (changedNames.includes(ACCEPT_GRADES_FIELD) && !refreshed.form.acceptGradesWritable) return failure("moodle_lti_setting_not_writable", refreshed.status);
    const beforeProtected = await protectedDigest(refreshed.form, changedNames);
    const overrides = {};
    if (Object.hasOwn(args.settings, "name")) overrides.name = [args.settings.name];
    // An advcheckbox is sent as its hidden "0" followed by the checkbox "1".
    if (Object.hasOwn(args.settings, "accept_grades")) overrides[ACCEPT_GRADES_FIELD] = ["0", "1"];
    refreshed.form.courseId = args.courseId;
    const posted = await postForm(context, refreshed.form, overrides);
    if (posted.error) {
      if (posted.notSent === true) return failure(posted.error, refreshed.status);
      if (posted.validation === true) return appliedButRefused(posted.error, posted.status);
      return unconfirmedWrite("moodle_lti_update_unconfirmed", posted.status);
    }
    const after = await readActivity(context, args);
    if (!after.ok) return unconfirmedWrite("moodle_lti_update_unconfirmed", posted.status);
    const afterProtected = await protectedDigest(after.form, changedNames);
    const matches = afterProtected === beforeProtected
      && (!Object.hasOwn(args.settings, "name") || after.data.name === args.settings.name)
      && (!Object.hasOwn(args.settings, "accept_grades") || after.data.accept_grades === true);
    const result = {
      ok: matches, sent: true, status: posted.status ?? after.status,
      data: after.data, targets: after.targets, snapshot_digest: after.snapshot_digest,
      verification: { schema: "morrow.browser-verification.v1", status: matches ? "verified" : "mismatch", ...(matches ? {} : { reason: "moodle_lti_readback_mismatch" }) },
    };
    return matches ? result : { ...result, error: "moodle_write_not_verified" };
  };
  const readResult = (read) => read.ok
    ? { ok: true, sent: true, status: read.status, data: read.data, targets: read.targets, snapshot_digest: read.snapshot_digest }
    : read;

  try {
    const context = currentContext();
    if (input?.mode !== "execute" || !context) return failure("moodle_session_unavailable");
    if (!Number.isFinite(input.expiresAt) || Date.now() >= input.expiresAt) return failure("moodle_execution_expired");
    const definition = expectedOperation(input.operation);
    if (!definition) return failure("moodle_operation_refused");
    if (!bindingValid(context, input.binding)) return failure("moodle_binding_mismatch");
    const args = argumentsFor(definition, input.arguments, input.binding);
    if (!args) return failure("moodle_lti_arguments_invalid");
    if (definition.kind === "creation-form") return readResult(await readCreationForm(context, args));
    if (definition.kind === "activity") return readResult(await readActivity(context, args));
    return definition.kind === "create" ? await runCreate(context, args) : await runUpdate(context, args);
  } catch (error) {
    if (dispatched) return unconfirmedWrite("moodle_lti_write_unconfirmed");
    return failure(String(error?.message || error).startsWith("moodle_") ? String(error.message) : "moodle_lti_execution_failed");
  }
}
