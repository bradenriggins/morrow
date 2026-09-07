/**
 * Phase one of the dedicated hidden Question bank isolation route: create one
 * hidden `mod_qbank` activity in an approved course section, and separately
 * realize and bind that new bank's default question category.
 *
 * These are two separate approved effects, each with its own review read, its
 * own single native dispatch and its own authoritative readback. Neither of
 * them creates a question and neither attaches anything to a Quiz. The
 * deterministic Question bank hold in connector/extension/src/moodle-executor.js
 * stays in force, and every result repeats that.
 *
 * Effect 1 uses the native activity form
 * `/course/modedit.php?add=qbank&course=<course>&sectionid=<section>&return=0`.
 * The Qbank form itself forces `visible = 0` and `type = standard`, adds one
 * name field, one intro editor and one ID-number field, and offers
 * "Save and return to course" as `submitbutton2`. It adds no completion,
 * grade, group or availability control.
 * https://github.com/moodle/moodle/blob/v5.2.2/public/mod/qbank/mod_form.php#L30-L94
 * The instance callback writes one `qbank` record and nothing else.
 * https://github.com/moodle/moodle/blob/v5.2.2/public/mod/qbank/lib.php#L52-L68
 *
 * Effect 2 uses the native Question bank route `/mod/qbank/view.php?id=<cmid>`.
 * That route takes the module context of the exact module it is given and
 * redirects to `question_edit_url()` for it.
 * https://github.com/moodle/moodle/blob/v5.2.2/public/mod/qbank/view.php#L26-L32
 * `question_edit_url()` calls `question_get_default_category($context->id, true)`,
 * which creates the context's top category and its default child category when
 * they do not exist, with no capability check of its own, and then returns the
 * URL `.../question/edit.php?cat=<categoryid>,<contextid>&cmid=<cmid>`.
 * https://github.com/moodle/moodle/blob/v5.2.2/public/lib/questionlib.php#L1077-L1119
 * That is why this is a separate approved effect and not a read.
 *
 * Two facts keep effect 2 honest and are stated in every result.
 *
 * 1. The browser cannot tell whether the route created the default category or
 *    found one already there, because `question_get_default_category` returns
 *    the first existing category of the context either way. The result says
 *    `created_or_existing` and never claims a creation it did not observe.
 * 2. `moodle/question:add` is checked by Moodle at the bank's own context and
 *    is visible to a browser only as the bank page's add-question control.
 *    Morrow therefore requires that control in the readback and refuses to bind
 *    the category without it. The category is realized by the dispatch itself,
 *    so this refusal stops the route; it does not undo the effect.
 *    https://github.com/moodle/moodle/blob/v5.2.2/public/question/bank/editquestion/classes/plugin_feature.php#L57-L70
 *
 * Neither route opens a launch, player, attempt or report page, and mod_qbank
 * declares no completion support, so neither records learner state.
 *
 * Chrome serializes this function for a MAIN-world injection. Keep every
 * dependency inside the function body.
 */
export async function executeMoodleQbankInPage(rawInput) {
  const PROVIDER = "moodle";
  const ACTIVITY_SCHEMA = "morrow.moodle-qbank-activity.v1";
  const CATEGORY_SCHEMA = "morrow.moodle-qbank-default-category.v1";
  const MODULE = "qbank";
  const BANK_TYPE = "standard";
  const STATE_METHOD = "core_courseformat_get_state";
  const MODEDIT_PATH = "/course/modedit.php";
  const BANK_ROUTE_PATH = "/mod/qbank/view.php";
  const BANK_PAGE_PATH = "/question/edit.php";
  const ADD_QUESTION_PATH = "/question/bank/editquestion/addquestion.php";
  const COURSE_VIEW_PATH = "/course/view.php";
  const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
  const MAX_FORM_ENTRIES = 400;
  const MAX_FORM_BYTES = 256 * 1024;
  const MAX_VALUE_BYTES = 32 * 1024;
  const MAX_CATEGORY_OPTIONS = 500;
  const MAX_ACTIVITIES = 10_000;
  // question_bank_helper::BANK_NAME_MAX_LENGTH.
  const MAX_NAME_LENGTH = 1_333;
  const ID = /^[1-9][0-9]{0,18}$/;
  const COUNT = /^(?:0|[1-9][0-9]{0,8})$/;
  const DIGEST = /^[a-f0-9]{64}$/;
  const CATEGORY_PARAM = /^([1-9][0-9]{0,18}),([1-9][0-9]{0,18})$/;
  const TRANSIENT_FIELD = /(?:sesskey|statekey|csrf|token|secret|password|authorization|cookie)/i;
  const DRAFT_ITEM_FIELD = /\[itemid\]$/;
  // The one editor the Qbank form declares. Any other draft or file control
  // means the form is not the core Qbank form this executor was written for.
  const ALLOWED_DRAFT_FIELD = "introeditor[itemid]";
  const definitions = Object.freeze({
    "moodle.form.course.modedit.qbank.create.read.v1": { toolName: "moodle_get_qbank_activity_creation_form", readOnly: true, kind: "creation-form" },
    "moodle.form.course.modedit.qbank.create.write.v1": { toolName: "moodle_create_qbank_activity", readOnly: false, kind: "create" },
    "moodle.form.course.modedit.qbank.read.v1": { toolName: "moodle_get_qbank_activity", readOnly: true, kind: "activity" },
    "moodle.form.question.bank.default_category.realize.write.v1": { toolName: "moodle_realize_qbank_default_category", readOnly: false, kind: "realize" },
  });
  const CREATION_KINDS = ["creation-form", "create"];

  const parseInput = () => {
    if (typeof rawInput !== "string") return rawInput;
    try { return JSON.parse(rawInput); } catch { return null; }
  };
  const input = parseInput();
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
  // known: the effect happened and Morrow refuses to carry the route further.
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
  const validText = (value, maximum = 1_333) => typeof value === "string" && value.length > 0 && value.length <= maximum
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
    if (!globalThis.crypto?.subtle || typeof globalThis.TextEncoder !== "function") throw new Error("moodle_qbank_digest_unavailable");
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
  const exactKeys = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
  const argumentsFor = (definition, args, binding) => {
    const courseId = id(binding?.courseId);
    if (!courseId) return null;
    const creating = CREATION_KINDS.includes(definition.kind);
    const targetKey = creating ? "section_id" : "module_id";
    const base = ["course_id", targetKey];
    const required = definition.kind === "create" ? [...base, "name", "expected_digest"]
      : definition.kind === "realize" ? [...base, "expected_digest"] : base;
    if (!exactKeys(args, required) || id(args.course_id) !== courseId || !id(args[targetKey])) return null;
    const target = { courseId, targetId: id(args[targetKey]) };
    if (definition.readOnly) return target;
    if (!DIGEST.test(String(args.expected_digest || ""))) return null;
    if (definition.kind === "realize") return { ...target, expectedDigest: args.expected_digest };
    // A name that is not already whitespace-collapsed could never equal the
    // name Moodle saves, so the readback would refuse it after the dispatch.
    return validText(args.name, MAX_NAME_LENGTH) && collapsed(args.name, MAX_NAME_LENGTH) === args.name
      ? { ...target, name: args.name, expectedDigest: args.expected_digest }
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
    if (declared !== null && (!COUNT.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) return null;
    let text;
    try { text = await response.text(); } catch { return null; }
    return typeof text === "string" && text.length <= MAX_RESPONSE_BYTES ? text : null;
  };
  const readPage = async (context, endpoint) => {
    let response;
    try {
      response = await fetch(endpoint, { method: "GET", credentials: "include", cache: "no-store", redirect: "error", headers: { Accept: "text/html" } });
    } catch { return { error: "moodle_qbank_read_unavailable" }; }
    if (!response.ok || !sameRoute(response.url, endpoint) || !sameContext(context, currentContext())) {
      return { error: "moodle_qbank_read_unavailable", status: response.status };
    }
    const html = await boundedText(response);
    if (html === null || typeof globalThis.DOMParser !== "function") return { error: "moodle_qbank_read_unavailable", status: response.status };
    try { return { status: response.status, document: new DOMParser().parseFromString(html, "text/html") }; }
    catch { return { error: "moodle_qbank_read_unavailable", status: response.status }; }
  };
  const courseState = async (context, courseId) => {
    const endpoint = urlFor(context, "/lib/ajax/service.php", { sesskey: context.sesskey, info: STATE_METHOD });
    let response;
    try {
      response = await fetch(endpoint, {
        method: "POST", credentials: "include", cache: "no-store", redirect: "error",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify([{ index: 0, methodname: STATE_METHOD, args: { courseid: Number(courseId) } }]),
      });
    } catch { return { error: "moodle_qbank_course_state_unavailable" }; }
    if (!response.ok || !sameContext(context, currentContext())) return { error: "moodle_qbank_course_state_unavailable", status: response.status };
    const raw = await boundedText(response);
    if (raw === null) return { error: "moodle_qbank_course_state_unavailable", status: response.status };
    let value;
    try {
      const payload = JSON.parse(raw);
      const entry = Array.isArray(payload) && payload.length === 1 && object(payload[0]) ? payload[0] : null;
      if (!entry || entry.error || entry.exception || !("data" in entry)) return { error: "moodle_qbank_course_state_unavailable", status: response.status };
      value = typeof entry.data === "string" ? JSON.parse(entry.data) : entry.data;
    } catch { return { error: "moodle_qbank_course_state_unavailable", status: response.status }; }
    if (!object(value) || !object(value.course) || id(value.course.id) !== courseId
      || !Array.isArray(value.section) || !Array.isArray(value.cm)
      || value.cm.length > MAX_ACTIVITIES || value.section.length > MAX_ACTIVITIES) {
      return { error: "moodle_qbank_course_state_unavailable", status: response.status };
    }
    return { status: response.status, course: value.course, sections: value.section, activities: value.cm };
  };
  const courseTarget = (state) => ({ field: "course_id", label: "Course", name: collapsed(state.course?.fullname || state.course?.name) || "Moodle course" });
  const sectionOf = (state, sectionId) => {
    const matches = state.sections.filter((entry) => object(entry) && id(entry.id) === sectionId);
    if (matches.length !== 1) return null;
    const number = sectionNumber(matches[0].number);
    return number === "" ? null : { id: sectionId, number, name: collapsed(matches[0].title || matches[0].rawtitle) || "Selected course section" };
  };
  const qbankModuleOf = (state, moduleId) => {
    const matches = state.activities.filter((entry) => object(entry) && id(entry.id) === moduleId);
    if (matches.length !== 1 || String(matches[0].module || "") !== MODULE) return null;
    const sectionId = id(matches[0].sectionid);
    const name = collapsed(matches[0].name);
    return sectionId && name && matches[0].visible === false ? { id: moduleId, sectionId, name } : null;
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
  const nativeForm = (documentValue, endpoint) => {
    const matches = [...documentValue.querySelectorAll("form")].filter((form) => {
      if (String(form.getAttribute("method") || "").toLowerCase() !== "post") return false;
      const action = form.getAttribute("action");
      if (!action) return false;
      try {
        const nativeAction = new URL(action, endpoint);
        // moodleform posts to the page URL with its query stripped, so an
        // action that carries one is not the native form Morrow read.
        return nativeAction.origin === endpoint.origin && nativeAction.pathname === endpoint.pathname
          && !nativeAction.search && !nativeAction.hash && !nativeAction.username && !nativeAction.password;
      } catch { return false; }
    });
    return matches.length === 1 ? matches[0] : null;
  };
  const saveAndReturnSubmit = (form) => {
    // mod_qbank names its "Save and return to course" control submitbutton2.
    const buttons = [...form.querySelectorAll('input[type="submit"][name="submitbutton2"], button[type="submit"][name="submitbutton2"]')]
      .filter((element) => !element.disabled && typeof element.value === "string" && element.value.length <= 500);
    return buttons.length === 1 ? { name: buttons[0].name, value: buttons[0].value } : null;
  };
  /**
   * The Qbank form declares exactly one file-bearing control: the intro
   * editor's own draft area. Anything else is a file area this executor was
   * not written against, so it refuses instead of carrying it through a save.
   */
  const fileAreaProblem = (form, entries) => {
    if (form.querySelector('[data-fieldtype="filemanager"], [data-fieldtype="filepicker"], input[type="file"]')) return "moodle_qbank_file_area_unexpected";
    const draftFields = [...new Set(entries.filter(([name]) => DRAFT_ITEM_FIELD.test(name)).map(([name]) => name))];
    if (draftFields.length > 1 || (draftFields.length === 1 && draftFields[0] !== ALLOWED_DRAFT_FIELD)) return "moodle_qbank_file_area_unexpected";
    return "";
  };
  const endpointForCreationForm = (context, courseId, sectionId) => urlFor(context, MODEDIT_PATH, { add: MODULE, course: courseId, sectionid: sectionId, return: 0 });
  const endpointForActivity = (context, moduleId) => urlFor(context, MODEDIT_PATH, { update: moduleId, return: 0 });
  /**
   * Reads one native modedit form and proves it is the core Qbank form for the
   * exact approved target. `identity` names the hidden fields the form must
   * carry exactly once with exactly these values.
   */
  const qbankFormState = (documentValue, context, endpoint, identity, requireEmptyIntroduction) => {
    const form = nativeForm(documentValue, endpoint);
    if (!form) return { error: "moodle_qbank_form_invalid" };
    const entries = entriesFor(form);
    if (!entries) return { error: "moodle_qbank_form_invalid" };
    const byName = (name) => entries.filter(([entryName]) => entryName === name).map(([, value]) => value);
    const one = (name, expected) => {
      const values = byName(name);
      return values.length === 1 && (expected === undefined || values[0] === expected);
    };
    if (!one("sesskey", context.sesskey)) return { error: "moodle_form_session_mismatch" };
    if (!one("modulename", MODULE) || !one("type", BANK_TYPE)) return { error: "moodle_qbank_module_type_unexpected" };
    for (const [name, value] of Object.entries(identity)) {
      if (!one(name, value)) return { error: "moodle_qbank_form_invalid" };
    }
    if (!one("visible", "0")) return { error: "moodle_qbank_form_invalid" };
    if (!one("name") || !one("introeditor[text]")) return { error: "moodle_qbank_form_invalid" };
    // The description is never returned. Moodle rich text can carry draft file
    // references, and phase one neither sets nor changes a description, so the
    // result says only whether one is there. A creation form must have none.
    const introductionEmpty = byName("introeditor[text]")[0].trim() === "";
    if (requireEmptyIntroduction && !introductionEmpty) return { error: "moodle_qbank_form_invalid" };
    const areaProblem = fileAreaProblem(form, entries);
    if (areaProblem) return { error: areaProblem };
    const submit = saveAndReturnSubmit(form);
    if (!submit) return { error: "moodle_qbank_form_invalid" };
    const protectedEntries = entries.filter(([name]) => name !== "name" && !TRANSIENT_FIELD.test(name));
    // A result never carries the session key, whatever the control is called.
    if (protectedEntries.some(([, value]) => value === context.sesskey)) return { error: "moodle_qbank_form_invalid" };
    return {
      entries,
      action: new URL(form.getAttribute("action"), endpoint).href,
      nativeSesskey: context.sesskey,
      submit,
      name: collapsed(byName("name")[0], MAX_NAME_LENGTH),
      introductionEmpty,
      protectedFields: [...new Set(protectedEntries.map(([name]) => name))].sort(),
    };
  };
  const activityProof = (route) => ({
    method: "native_form_read",
    route,
    required_capability: "moodle/course:manageactivities",
    scope: "one_hidden_question_bank_activity",
    module: MODULE,
    bank_type: BANK_TYPE,
    question_bank_context: "not_established",
    question_bank_write_eligibility: "held",
  });
  const creationFormData = (courseId, section, state) => ({
    schema: ACTIVITY_SCHEMA,
    provider: PROVIDER,
    course_id: Number(courseId),
    section_id: Number(section.id),
    section_number: Number(section.number),
    module: MODULE,
    bank_type: BANK_TYPE,
    visible: false,
    introduction_empty: state.introductionEmpty,
    protected_setting_names: state.protectedFields,
    proof: activityProof(MODEDIT_PATH),
  });
  const activityData = (courseId, module, state) => ({
    schema: ACTIVITY_SCHEMA,
    provider: PROVIDER,
    course_id: Number(courseId),
    module_id: Number(module.id),
    section_id: Number(module.sectionId),
    name: state.name,
    module: MODULE,
    bank_type: BANK_TYPE,
    visible: false,
    introduction_empty: state.introductionEmpty,
    protected_setting_names: state.protectedFields,
    proof: activityProof(MODEDIT_PATH),
  });
  const readCreationForm = async (context, courseId, sectionId) => {
    const state = await courseState(context, courseId);
    if (state.error) return failure(state.error, state.status);
    const section = sectionOf(state, sectionId);
    if (!section) return failure("moodle_qbank_section_target_invalid", state.status);
    const endpoint = endpointForCreationForm(context, courseId, sectionId);
    const page = await readPage(context, endpoint);
    if (page.error) return failure(page.error, page.status);
    const form = qbankFormState(page.document, context, endpoint, { course: courseId, add: MODULE, section: section.number, return: "0" }, true);
    if (form.error) return failure(form.error, page.status);
    const data = creationFormData(courseId, section, form);
    return {
      ok: true, sent: true, status: page.status, data,
      targets: [courseTarget(state), { field: "section_id", label: "Section", name: section.name }],
      snapshot_digest: await digest(data), form, section, state,
    };
  };
  const readActivity = async (context, courseId, moduleId) => {
    const state = await courseState(context, courseId);
    if (state.error) return failure(state.error, state.status);
    const module = qbankModuleOf(state, moduleId);
    if (!module) return failure("moodle_qbank_module_target_invalid", state.status);
    const endpoint = endpointForActivity(context, moduleId);
    const page = await readPage(context, endpoint);
    if (page.error) return failure(page.error, page.status);
    const form = qbankFormState(page.document, context, endpoint, { update: moduleId, course: courseId, return: "0" }, false);
    if (form.error) return failure(form.error, page.status);
    if (!form.name || form.name !== module.name) return failure("moodle_qbank_module_target_invalid", page.status);
    const data = activityData(courseId, module, form);
    return {
      ok: true, sent: true, status: page.status, data,
      targets: [courseTarget(state), { field: "module_id", label: "Question bank", name: module.name }],
      snapshot_digest: await digest(data), form, module, state,
    };
  };
  const postCreation = async (context, courseId, form, name) => {
    const preflight = currentContext();
    if (!sameContext(context, preflight) || form.nativeSesskey !== preflight?.sesskey) return { error: "moodle_form_session_mismatch", notSent: true };
    const body = new URLSearchParams();
    for (const [field, value] of form.entries) body.append(field, field === "name" ? name : value);
    body.append(form.submit.name, form.submit.value);
    let response;
    try {
      dispatched = true;
      response = await fetch(form.action, {
        method: "POST", credentials: "include", cache: "no-store", redirect: "follow",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "text/html" }, body,
      });
    } catch { return { error: "moodle_qbank_create_unconfirmed" }; }
    if (!sameContext(context, currentContext())) return { error: "moodle_qbank_create_unconfirmed", status: response.status };
    // "Save and return to course" ends on the course page. A response that
    // stays on the form is the native validation page, which saved nothing.
    let landed;
    try { landed = new URL(response.url); } catch { return { error: "moodle_qbank_create_unconfirmed", status: response.status }; }
    if (!response.ok) return { error: "moodle_qbank_create_unconfirmed", status: response.status };
    // The native form answers its own validation failure by re-rendering
    // itself, which saved nothing. moodle-executor.js:1186 reports that exact
    // ending with the same code, and the service worker recognises it.
    if (landed.pathname === `${context.basePath}${MODEDIT_PATH}`) return { error: "moodle_form_validation_failed", status: response.status, validation: true };
    if (landed.origin !== context.origin || landed.pathname !== `${context.basePath}${COURSE_VIEW_PATH}`
      || landed.searchParams.get("id") !== courseId) return { error: "moodle_qbank_create_unconfirmed", status: response.status };
    return { status: response.status };
  };
  const runCreation = async (context, args) => {
    const before = await readCreationForm(context, args.courseId, args.targetId);
    if (!before.ok) return before;
    if (before.snapshot_digest !== args.expectedDigest) return failure("moodle_expected_digest_mismatch", before.status);
    const refreshed = await readCreationForm(context, args.courseId, args.targetId);
    if (!refreshed.ok) return refreshed;
    if (refreshed.snapshot_digest !== args.expectedDigest || refreshed.form.action !== before.form.action) {
      return failure("moodle_expected_digest_mismatch", refreshed.status);
    }
    // The activity list read immediately before the dispatch is the baseline
    // the new module is found against, so nothing already there can match.
    const existingIds = new Set(refreshed.state.activities.map((entry) => id(object(entry) ? entry.id : "")).filter(Boolean));
    const posted = await postCreation(context, args.courseId, refreshed.form, args.name);
    if (posted.error) {
      if (posted.notSent === true) return failure(posted.error, refreshed.status);
      if (posted.validation === true) return appliedButRefused(posted.error, posted.status);
      return unconfirmedWrite(posted.error, posted.status);
    }
    const after = await courseState(context, args.courseId);
    if (after.error) return unconfirmedWrite("moodle_qbank_create_unconfirmed", posted.status);
    const created = after.activities.filter((entry) => object(entry) && !existingIds.has(id(entry.id))
      && String(entry.module || "") === MODULE && collapsed(entry.name) === args.name
      && id(entry.sectionid) === args.targetId && entry.visible === false);
    const moduleId = created.length === 1 ? id(created[0].id) : "";
    if (!moduleId) return unconfirmedWrite("moodle_qbank_create_not_verified", posted.status);
    const saved = await readActivity(context, args.courseId, moduleId);
    if (!saved.ok) return unconfirmedWrite("moodle_qbank_create_not_verified", posted.status);
    if (saved.data.name !== args.name || saved.data.section_id !== Number(args.targetId) || saved.data.visible !== false) {
      return unconfirmedWrite("moodle_qbank_create_not_verified", posted.status);
    }
    return {
      ok: true, sent: true, status: posted.status,
      data: { ...saved.data, created: true },
      targets: saved.targets, snapshot_digest: saved.snapshot_digest,
      verification: { schema: "morrow.browser-verification.v1", status: "verified" },
    };
  };
  /**
   * Reads the bank page the Question bank route lands on. `question_edit_url`
   * put the realized category and its context in the URL; the page itself
   * carries the add-question control and the category filter's own option
   * list, which is grouped by context. One context group is the browser-visible
   * proof that no listed category leaves the module context.
   */
  const bankPageState = (documentValue, context, moduleId, categoryId) => {
    const controls = [...documentValue.querySelectorAll("div.createnewquestion")];
    if (controls.length !== 1) return { error: "moodle_qbank_question_add_absent" };
    const forms = [...controls[0].querySelectorAll("form")].filter((form) => {
      let action;
      try { action = new URL(form.getAttribute("action") || "", context.siteUrl); } catch { return false; }
      return action.origin === context.origin && action.pathname === `${context.basePath}${ADD_QUESTION_PATH}`;
    });
    if (forms.length !== 1 || !controls[0].querySelector("#qtypechoicecontainer")) return { error: "moodle_qbank_question_add_absent" };
    const hidden = (name) => [...forms[0].querySelectorAll(`input[type="hidden"][name="${name}"]`)].map((field) => String(field.value || ""));
    if (stable(hidden("category")) !== stable([categoryId]) || stable(hidden("cmid")) !== stable([moduleId])) {
      return { error: "moodle_qbank_question_add_absent" };
    }
    const selects = [...documentValue.querySelectorAll('[data-filterregion="filtertypedata"] select[data-field-name="category"]')];
    if (selects.length !== 1) return { error: "moodle_qbank_category_context_not_exposed" };
    const options = [...selects[0].querySelectorAll("option")];
    if (!options.length || options.length > MAX_CATEGORY_OPTIONS) return { error: "moodle_qbank_category_context_not_exposed" };
    const headings = options.filter((option) => String(option.getAttribute("value") || "") === "");
    const values = options.filter((option) => !headings.includes(option)).map((option) => String(option.getAttribute("value") || ""));
    if (headings.length !== 1 || values.some((value) => !id(value)) || new Set(values).size !== values.length) {
      return { error: "moodle_qbank_category_not_isolated" };
    }
    if (!values.includes(categoryId)) return { error: "moodle_qbank_category_not_isolated" };
    return { categoryOptionCount: values.length, contextGroups: headings.length };
  };
  const runRealization = async (context, args) => {
    const before = await readActivity(context, args.courseId, args.targetId);
    if (!before.ok) return before;
    if (before.snapshot_digest !== args.expectedDigest) return failure("moodle_expected_digest_mismatch", before.status);
    const refreshed = await readActivity(context, args.courseId, args.targetId);
    if (!refreshed.ok) return refreshed;
    if (refreshed.snapshot_digest !== args.expectedDigest) return failure("moodle_expected_digest_mismatch", refreshed.status);
    const preflight = currentContext();
    if (!sameContext(context, preflight)) return failure("moodle_form_session_mismatch", refreshed.status);
    const endpoint = urlFor(context, BANK_ROUTE_PATH, { id: args.targetId });
    let response;
    try {
      dispatched = true;
      response = await fetch(endpoint, { method: "GET", credentials: "include", cache: "no-store", redirect: "follow", headers: { Accept: "text/html" } });
    } catch { return unconfirmedWrite("moodle_qbank_realize_unconfirmed"); }
    if (!response.ok || !sameContext(context, currentContext())) return unconfirmedWrite("moodle_qbank_realize_unconfirmed", response.status);
    let landed;
    try { landed = new URL(response.url); } catch { return unconfirmedWrite("moodle_qbank_realize_unconfirmed", response.status); }
    const bankPage = landed.origin === context.origin && landed.pathname === `${context.basePath}${BANK_PAGE_PATH}`
      && landed.searchParams.getAll("cmid").length === 1 && landed.searchParams.get("cmid") === args.targetId
      && landed.searchParams.getAll("cat").length === 1;
    const parsed = bankPage ? CATEGORY_PARAM.exec(String(landed.searchParams.get("cat") || "")) : null;
    // The dispatch reached the site but did not end on the bank page this
    // route defines, so what it realized cannot be read: that is unknown.
    if (!parsed) return unconfirmedWrite("moodle_qbank_category_route_unexpected", response.status);
    const [, categoryId, contextId] = parsed;
    const html = await boundedText(response);
    if (html === null || typeof globalThis.DOMParser !== "function") return unconfirmedWrite("moodle_qbank_realize_unconfirmed", response.status);
    let page;
    try { page = new DOMParser().parseFromString(html, "text/html"); } catch { return unconfirmedWrite("moodle_qbank_realize_unconfirmed", response.status); }
    const bank = bankPageState(page, context, args.targetId, categoryId);
    if (bank.error) return appliedButRefused(bank.error, response.status);
    const data = {
      schema: CATEGORY_SCHEMA,
      provider: PROVIDER,
      course_id: Number(args.courseId),
      module_id: Number(args.targetId),
      category_id: Number(categoryId),
      question_bank_context_id: Number(contextId),
      category_origin: "created_or_existing",
      category_contexts_listed: bank.contextGroups,
      category_option_count: bank.categoryOptionCount,
      question_add_capability: "present",
      proof: {
        method: "native_question_bank_route",
        route: BANK_ROUTE_PATH,
        landed_route: BANK_PAGE_PATH,
        required_capability: "moodle/question:add",
        capability_source: "bank_page_add_question_control",
        context_source: "question_edit_url_for_approved_module",
        scope: "one_question_bank_module_context",
        isolation_established: false,
        question_bank_write_eligibility: "held",
      },
    };
    return {
      ok: true, sent: true, status: response.status, data,
      targets: refreshed.targets, snapshot_digest: await digest(data),
      verification: { schema: "morrow.browser-verification.v1", status: "verified" },
    };
  };

  let dispatched = false;
  try {
    const context = currentContext();
    if (input?.mode !== "execute" || !context) return failure("moodle_session_unavailable");
    if (!Number.isFinite(input.expiresAt) || Date.now() >= input.expiresAt) return failure("moodle_execution_expired");
    const definition = expectedOperation(input.operation);
    if (!definition) return failure("moodle_operation_refused");
    if (!bindingValid(context, input.binding)) return failure("moodle_binding_mismatch");
    const args = argumentsFor(definition, input.arguments, input.binding);
    if (!args) return failure("moodle_qbank_arguments_invalid");
    if (definition.kind === "creation-form") {
      const read = await readCreationForm(context, args.courseId, args.targetId);
      return read.ok ? { ok: true, sent: true, status: read.status, data: read.data, targets: read.targets, snapshot_digest: read.snapshot_digest } : read;
    }
    if (definition.kind === "activity") {
      const read = await readActivity(context, args.courseId, args.targetId);
      return read.ok ? { ok: true, sent: true, status: read.status, data: read.data, targets: read.targets, snapshot_digest: read.snapshot_digest } : read;
    }
    return definition.kind === "create" ? await runCreation(context, args) : await runRealization(context, args);
  } catch (error) {
    if (dispatched) return unconfirmedWrite("moodle_qbank_write_unconfirmed");
    return failure(String(error?.message || error).startsWith("moodle_") ? String(error.message) : "moodle_qbank_execution_failed");
  }
}
