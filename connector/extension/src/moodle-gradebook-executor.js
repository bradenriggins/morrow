/**
 * Reads the Moodle gradebook configuration surface of one course: the setup
 * tree, one grade category, one manual grade item, the course scales, the
 * course and site outcomes, and the course grade settings. It can rename one
 * category or one manual grade item, and it can change a bounded set of
 * configuration settings on one grade category or one manual grade item. It
 * reads no student name, no student grade, and no stored grade value, and it
 * changes nothing except the settings the one reviewed change names.
 *
 * Chrome serializes this function for a MAIN-world injection. Keep every
 * dependency inside the function body.
 */
export async function executeMoodleGradebookInPage(rawInput) {
  const PROVIDER = "moodle";
  const MAX_FORM_ENTRIES = 600;
  const MAX_FORM_BYTES = 256 * 1024;
  const MAX_VALUE_BYTES = 32 * 1024;
  const MAX_LIST_ROWS = 500;
  const MAX_SCALE_OPTIONS = 100;
  const DATE_COMPONENTS = ["year", "month", "day", "hour", "minute"];
  const GRADE_DATE_FIELDS = ["hiddenuntil", "locktime"];
  const ID = /^[1-9][0-9]{0,18}$/;
  const COUNT = /^[0-9]{1,9}$/;
  const DIGEST = /^[a-f0-9]{64}$/;
  // public/grade/edit/settings/index.php saves exactly these setting names.
  const SETTING_NAME = /^(?:displaytype|decimalpoints|aggregationposition|minmaxtouse|(?:report|import|export)_[A-Za-z0-9_]{1,80})$/;
  const GENERAL_SETTINGS = ["aggregationposition", "decimalpoints", "displaytype", "minmaxtouse"];
  const ROOT_CATEGORY_PROOF_REQUIRED = "moodle_gradebook_root_category_proof_required";
  const SCALES_INCOMPLETE = "moodle_gradebook_scales_incomplete";
  const OUTCOMES_INCOMPLETE = "moodle_gradebook_outcomes_incomplete";
  const TRANSIENT_FIELD = /(?:sesskey|statekey|csrf|token|secret|password|authorization|cookie)/i;
  const NATIVE_NUMBER = /^-?[0-9]+(?:([.,])[0-9]+)?$/;
  const GRADE_NUMBER_LIMIT = 1_000_000;
  const COUNT_LIMIT = 999;
  // Moodle's grade type constants: 0 none, 1 value, 2 scale, 3 text. The item
  // form removes its rescale control for a scale item, so the form cannot say
  // whether a scale item already has grades.
  const GRADE_TYPE_SCALE = "2";
  const RESCALE_EFFECTS = Object.freeze({ rescale: "yes", keep: "no" });
  const RESCALE_FIELD = "rescalegrades";
  /**
   * Each bounded setting names exactly one native control on the same form the
   * read returns. `override` names a second control the native form requires
   * before it saves the first one: `grade_item_aggregationcoef2` carries a
   * category weight only while `grade_item_weightoverride` is set.
   */
  const SETTINGS_SPECS = Object.freeze({
    category: Object.freeze([
      Object.freeze({ argument: "aggregation", field: "aggregation", kind: "select" }),
      Object.freeze({ argument: "drop_lowest", field: "droplow", kind: "count" }),
      Object.freeze({ argument: "weight", field: "grade_item_aggregationcoef2", kind: "number", override: "grade_item_weightoverride", overrideName: "weight_override" }),
    ]),
    item: Object.freeze([
      Object.freeze({ argument: "grade_type", field: "gradetype", kind: "select" }),
      Object.freeze({ argument: "maximum_grade", field: "grademax", kind: "number" }),
      Object.freeze({ argument: "minimum_grade", field: "grademin", kind: "number" }),
      Object.freeze({ argument: "display_type", field: "display", kind: "select" }),
      Object.freeze({ argument: "decimals", field: "decimals", kind: "select" }),
      Object.freeze({ argument: "parent_category_id", field: "parentcategory", kind: "select" }),
    ]),
  });
  const GRADE_RANGE_ARGUMENTS = ["maximum_grade", "minimum_grade"];
  const definitions = Object.freeze({
    "moodle.form.grade.tree.index.read.v1": { toolName: "moodle_get_gradebook_setup", readOnly: true, kind: "setup" },
    "moodle.form.grade.tree.category.read.v1": { toolName: "moodle_get_grade_category", readOnly: true, kind: "category" },
    "moodle.form.grade.tree.category.write.v1": { toolName: "moodle_update_grade_category", readOnly: false, kind: "category" },
    "moodle.form.grade.tree.category.settings.write.v1": { toolName: "moodle_update_grade_category_settings", readOnly: false, kind: "category", settings: true },
    "moodle.form.grade.tree.item.read.v1": { toolName: "moodle_get_grade_item", readOnly: true, kind: "item" },
    "moodle.form.grade.tree.item.write.v1": { toolName: "moodle_update_grade_item", readOnly: false, kind: "item" },
    "moodle.form.grade.tree.item.settings.write.v1": { toolName: "moodle_update_grade_item_settings", readOnly: false, kind: "item", settings: true },
    "moodle.form.grade.scale.index.read.v1": { toolName: "moodle_get_grade_scales", readOnly: true, kind: "scales" },
    "moodle.form.grade.outcome.index.read.v1": { toolName: "moodle_get_grade_outcomes", readOnly: true, kind: "outcomes" },
    "moodle.form.grade.settings.index.read.v1": { toolName: "moodle_get_gradebook_settings", readOnly: true, kind: "settings" },
  });
  // Each native controller states its own required capability at the course context.
  const routes = Object.freeze({
    setup: { path: "/grade/edit/tree/index.php", capability: "moodle/grade:manage" },
    category: { path: "/grade/edit/tree/category.php", capability: "moodle/grade:manage" },
    item: { path: "/grade/edit/tree/item.php", capability: "moodle/grade:manage" },
    scales: { path: "/grade/edit/scale/index.php", capability: "moodle/course:managescales" },
    outcomes: { path: "/grade/edit/outcome/index.php", capability: "moodle/grade:manageoutcomes" },
    settings: { path: "/grade/edit/settings/index.php", capability: "moodle/grade:manage" },
  });
  const COURSE_PAGE_KINDS = ["setup", "scales", "outcomes", "settings"];
  const proofFor = (kind) => ({
    method: "native_page_read",
    route: routes[kind].path,
    required_capability: routes[kind].capability,
    scope: "gradebook_configuration_only",
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
  const validText = (value, maximum = 255) => typeof value === "string" && value.length > 0 && value.length <= maximum
    && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
  const stable = (value) => {
    if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
    if (object(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
    return JSON.stringify(value === undefined ? null : value);
  };
  const digest = async (value) => {
    if (!globalThis.crypto?.subtle || typeof globalThis.TextEncoder !== "function") throw new Error("moodle_gradebook_digest_unavailable");
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
    && left?.basePath === right?.basePath && left?.principalId === right?.principalId && left?.anchorCourseId === right?.anchorCourseId
    && left?.sesskey === right?.sesskey;
  const bindingValid = (context, binding) => object(binding) && binding.origin === context.origin && binding.siteUrl === context.siteUrl
    && id(binding.principalId) === context.principalId && Boolean(id(binding.courseId));
  const expectedOperation = (operation) => {
    if (!object(operation) || typeof operation.key !== "string") return null;
    const definition = definitions[operation.key];
    return definition && operation.provider === PROVIDER && operation.toolName === definition.toolName && operation.readOnly === definition.readOnly ? definition : null;
  };
  const exactKeys = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
  const optionInteger = (value) => Number.isSafeInteger(value) && Math.abs(value) <= GRADE_NUMBER_LIMIT;
  const validCount = (value) => Number.isSafeInteger(value) && value >= 0 && value <= COUNT_LIMIT;
  // A grade number crosses the bridge as a number and reaches the native form
  // as plain decimal text, so a value the native float control cannot carry
  // exactly is refused before anything is loaded.
  const validGradeNumber = (value) => typeof value === "number" && Number.isFinite(value)
    && Math.abs(value) <= GRADE_NUMBER_LIMIT && /^-?[0-9]+(?:\.[0-9]{1,5})?$/.test(String(value));
  const settingsArgumentsFor = (definition, args, courseId) => {
    const targetKey = definition.kind === "category" ? "category_id" : "grade_item_id";
    const specs = SETTINGS_SPECS[definition.kind];
    const rescalable = definition.kind === "item";
    const allowed = new Set(["course_id", targetKey, "expected_digest", ...specs.map((spec) => spec.argument), ...(rescalable ? ["rescale_existing_grades"] : [])]);
    if (!object(args) || Object.keys(args).some((key) => !allowed.has(key))) return null;
    if (id(args.course_id) !== courseId || !id(args[targetKey]) || !DIGEST.test(String(args.expected_digest || ""))) return null;
    const requested = [];
    for (const spec of specs) {
      const value = args[spec.argument];
      if (value === undefined) continue;
      const accepted = spec.kind === "select" ? optionInteger(value) : spec.kind === "count" ? validCount(value) : validGradeNumber(value);
      if (!accepted) return null;
      requested.push({ ...spec, value });
    }
    if (!requested.length) return null;
    const effect = args.rescale_existing_grades;
    if (effect !== undefined && !(typeof effect === "string" && Object.hasOwn(RESCALE_EFFECTS, effect))) return null;
    return { courseId, targetId: id(args[targetKey]), expectedDigest: args.expected_digest, requested, rescaleEffect: effect === undefined ? "" : effect };
  };
  const argumentsFor = (definition, args, binding) => {
    const courseId = id(binding?.courseId);
    if (!courseId) return null;
    if (COURSE_PAGE_KINDS.includes(definition.kind)) return exactKeys(args, ["course_id"]) && id(args.course_id) === courseId ? { courseId } : null;
    if (definition.settings === true) return settingsArgumentsFor(definition, args, courseId);
    const targetKey = definition.kind === "category" ? "category_id" : "grade_item_id";
    const base = ["course_id", targetKey];
    const writing = !definition.readOnly;
    const nameKey = definition.kind === "category" ? "fullname" : "item_name";
    if (!exactKeys(args, writing ? [...base, nameKey, "expected_digest"] : base) || id(args.course_id) !== courseId || !id(args[targetKey])) return null;
    if (!writing) return { courseId, targetId: id(args[targetKey]) };
    return validText(args[nameKey]) && DIGEST.test(String(args.expected_digest || ""))
      ? { courseId, targetId: id(args[targetKey]), name: args[nameKey], expectedDigest: args.expected_digest }
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
    if (received.origin !== expected.origin || received.pathname !== expected.pathname || received.hash || received.username || received.password) return false;
    const receivedEntries = [...received.searchParams.entries()].sort(([leftName, leftValue], [rightName, rightValue]) => leftName.localeCompare(rightName) || leftValue.localeCompare(rightValue));
    const expectedEntries = [...expected.searchParams.entries()].sort(([leftName, leftValue], [rightName, rightValue]) => leftName.localeCompare(rightName) || leftValue.localeCompare(rightValue));
    return stable(receivedEntries) === stable(expectedEntries);
  };
  const endpointFor = (context, courseId, kind, targetId = "") => {
    if (COURSE_PAGE_KINDS.includes(kind)) return urlFor(context, routes[kind].path, { id: courseId });
    return urlFor(context, routes[kind].path, { courseid: courseId, id: targetId });
  };
  const textOf = (element) => String(element?.textContent || "").replace(/\s+/g, " ").trim();
  // html_writer::table renders one row per record; a header row carries th cells only.
  const dataRows = (table) => [...table.querySelectorAll("tr")]
    .map((row) => [...row.children].filter((cell) => cell.tagName === "TD" || cell.tagName === "TH"))
    .filter((cells) => cells.length > 0 && cells.every((cell) => cell.tagName === "TD"));
  const linkTarget = (link, endpoint, context, path, required, targetParam) => {
    let url;
    try { url = new URL(link.getAttribute("href") || "", endpoint); } catch { return ""; }
    if (url.origin !== context.origin || url.pathname !== `${context.basePath}${path}`) return "";
    for (const [name, value] of Object.entries(required)) {
      if (url.searchParams.getAll(name).length !== 1 || url.searchParams.get(name) !== value) return "";
    }
    const values = url.searchParams.getAll(targetParam);
    return values.length === 1 ? id(values[0]) : "";
  };
  /**
   * A native grade list row exposes its record id only through its own edit and
   * delete controls. That cell holds those icon links and nothing else, so
   * "text" means the row is not a grade list row and "invalid" means it is one
   * whose controls do not bind this course. Text inside a control link is the
   * icon's own label, so only text outside the links counts.
   */
  const rowControl = (cell, endpoint, context, courseId, editPath, indexPath, deleteParam) => {
    const outside = cell.cloneNode(true);
    for (const link of outside.querySelectorAll("a")) link.remove();
    if (textOf(outside) !== "") return { shape: "text" };
    const links = [...cell.querySelectorAll("a[href]")];
    if (!links.length) return { shape: "none", targetId: "", deletable: false };
    const editIds = links.map((link) => linkTarget(link, endpoint, context, editPath, { courseid: courseId }, "id")).filter(Boolean);
    const deleteIds = links.map((link) => linkTarget(link, endpoint, context, indexPath, { id: courseId, action: "delete" }, deleteParam)).filter(Boolean);
    if (editIds.length + deleteIds.length !== links.length || editIds.length !== 1 || deleteIds.length > 1
      || (deleteIds.length === 1 && deleteIds[0] !== editIds[0])) return { shape: "invalid" };
    return { shape: "control", targetId: editIds[0], deletable: deleteIds.length === 1 };
  };
  const readPage = async (context, endpoint) => {
    let response;
    try {
      response = await fetch(endpoint, { method: "GET", credentials: "include", cache: "no-store", redirect: "error", headers: { Accept: "text/html" } });
    } catch { return { error: "moodle_gradebook_read_unavailable" }; }
    if (!response.ok || !sameRoute(response.url, endpoint) || !sameContext(context, currentContext())) return { error: "moodle_gradebook_read_unavailable", status: response.status };
    let html;
    try { html = await response.text(); } catch { return { error: "moodle_gradebook_read_unavailable", status: response.status }; }
    if (typeof html !== "string" || html.length > 2 * 1024 * 1024 || typeof globalThis.DOMParser !== "function") return { error: "moodle_gradebook_read_unavailable", status: response.status };
    try { return { status: response.status, document: new DOMParser().parseFromString(html, "text/html") }; } catch { return { error: "moodle_gradebook_read_unavailable", status: response.status }; }
  };
  const one = (values, expected) => values.length === 1 && values[0] === expected;
  const entriesFor = (form) => {
    let values;
    try { values = [...new FormData(form).entries()]; } catch { return null; }
    let size = 0;
    if (values.length > MAX_FORM_ENTRIES) return null;
    const entries = [];
    for (const [name, value] of values) {
      if (typeof name !== "string" || name.length < 1 || name.length > 255 || typeof value !== "string" || value.length > MAX_VALUE_BYTES) return null;
      size += name.length + value.length;
      if (size > MAX_FORM_BYTES) return null;
      entries.push([name, value]);
    }
    return entries;
  };
  const snapshotEntries = (form, entries) => {
    let snapshot = entries.filter(([name]) => !TRANSIENT_FIELD.test(name));
    const controls = [...form.querySelectorAll("[name]")];
    for (const field of GRADE_DATE_FIELDS) {
      const enabledName = `${field}[enabled]`;
      const componentNames = DATE_COMPONENTS.map((component) => `${field}[${component}]`);
      const relevant = controls.filter((control) => control.getAttribute("name") === enabledName || componentNames.includes(control.getAttribute("name")));
      if (!relevant.length) continue;
      const toggles = relevant.filter((control) => control.getAttribute("name") === enabledName);
      const components = componentNames.map((name) => relevant.filter((control) => control.getAttribute("name") === name));
      if (toggles.length !== 1 || toggles[0].tagName !== "INPUT" || String(toggles[0].getAttribute("type") || "").toLowerCase() !== "checkbox"
        || toggles[0].value !== "1" || components.some((items) => items.length !== 1 || items[0].tagName !== "SELECT" || items[0].multiple
          || [...items[0].options].filter((option) => option.selected).length !== 1)) return null;
      const valuesFor = (name) => entries.filter(([entryName]) => entryName === name).map(([, value]) => value);
      const componentValuesMatch = components.every((items, index) => {
        const values = valuesFor(componentNames[index]);
        return values.length === 1 && values[0] === items[0].value;
      });
      const enabledValues = valuesFor(enabledName);
      if (toggles[0].checked) {
        if (!one(enabledValues, "1") || !componentValuesMatch) return null;
        continue;
      }
      if (enabledValues.length || !componentValuesMatch) return null;
      const ignored = new Set(componentNames);
      snapshot = snapshot.filter(([name]) => !ignored.has(name));
      snapshot.push([enabledName, "0"]);
    }
    return snapshot;
  };
  const primarySubmit = (form) => {
    const buttons = [...form.querySelectorAll('input[type="submit"][name], button[type="submit"][name]')]
      .filter((element) => !element.disabled && /^submitbutton(?:[0-9]+)?$/i.test(element.name) && typeof element.value === "string");
    return buttons.length === 1 && buttons[0].value.length <= 500 ? { name: buttons[0].name, value: buttons[0].value } : null;
  };
  const nativeForm = (documentValue, endpoint) => {
    const matches = [...documentValue.querySelectorAll("form")].filter((form) => {
      if (String(form.getAttribute("method") || "").toLowerCase() !== "post") return false;
      const action = form.getAttribute("action");
      if (!action) return false;
      try {
        const nativeAction = new URL(action, endpoint);
        return nativeAction.origin === endpoint.origin && nativeAction.pathname === endpoint.pathname
          && !nativeAction.search && !nativeAction.hash && !nativeAction.username && !nativeAction.password;
      } catch { return false; }
    });
    return matches.length === 1 ? matches[0] : null;
  };
  /**
   * `mutable` names the native controls one reviewed change is allowed to
   * write. Everything else on the form is the protected set, so a rename and a
   * settings change over the same form each carry their own protected digest.
   */
  const formState = async (documentValue, context, courseId, kind, targetId, mutable = null, rootCategoryProven = false) => {
    const endpoint = endpointFor(context, courseId, kind, targetId);
    const form = nativeForm(documentValue, endpoint);
    if (!form) return { error: "moodle_gradebook_form_invalid" };
    const entries = entriesFor(form);
    const targetName = kind === "category" ? "fullname" : "itemname";
    const changeable = mutable instanceof Set ? mutable : new Set([targetName]);
    const byName = (name) => entries?.filter(([entryName]) => entryName === name).map(([, value]) => value) || [];
    if (!entries || !one(byName("courseid"), courseId) || !one(byName("id"), targetId)) {
      return { error: "moodle_gradebook_form_invalid" };
    }
    if (!one(byName("sesskey"), context.sesskey)) return { error: "moodle_form_session_mismatch" };
    if (kind === "item" && !one(byName("itemtype"), "manual")) return { error: "moodle_gradebook_item_not_manual" };
    const snapshot = snapshotEntries(form, entries);
    if (!snapshot) return { error: "moodle_gradebook_form_invalid" };
    const target = byName(targetName);
    const rootCategoryEmptyName = kind === "category" && rootCategoryProven === true && target.length === 1 && target[0] === "";
    if (target.length !== 1 || (!validText(target[0]) && !rootCategoryEmptyName)) {
      return { error: kind === "category" && target.length === 1 && target[0] === "" ? ROOT_CATEGORY_PROOF_REQUIRED : "moodle_gradebook_form_invalid" };
    }
    const submit = primarySubmit(form);
    if (!submit) return { error: "moodle_gradebook_form_invalid" };
    const protectedEntries = snapshot.filter(([name]) => !changeable.has(name));
    // A result never carries the session key, whatever the control is called.
    if (protectedEntries.some(([, value]) => value === context.sesskey)) return { error: "moodle_gradebook_form_invalid" };
    return {
      form,
      entries,
      action: new URL(form.getAttribute("action"), endpoint).href,
      nativeSesskey: context.sesskey,
      targetName,
      target: target[0],
      submit,
      snapshotDigest: await digest({ kind, courseId, targetId, entries: snapshot }),
      protectedDigest: await digest({ kind, courseId, targetId, entries: protectedEntries }),
      protectedFields: [...new Set(protectedEntries.map(([name]) => name))].sort(),
      // The digest preimage, in its exact order, so a caller can recompute it.
      protectedSettings: protectedEntries.map(([name, value]) => ({ name, value })),
    };
  };
  const output = (kind, courseId, targetId, state) => ({
    course_id: courseId,
    ...(kind === "category" ? { category_id: targetId, fullname: state.target } : { grade_item_id: targetId, item_name: state.target, item_type: "manual" }),
    protected_settings_digest: state.protectedDigest,
    protected_setting_names: state.protectedFields,
    protected_settings: state.protectedSettings,
    proof: proofFor(kind),
  });
  const setupState = async (documentValue, context, courseId) => {
    const forms = [...documentValue.querySelectorAll("form#gradetreeform")];
    if (forms.length !== 1) return { error: "moodle_gradebook_setup_incomplete" };
    const tables = [...forms[0].querySelectorAll("table#grade_edit_tree_table.setup-grades")];
    if (tables.length !== 1) return { error: "moodle_gradebook_setup_incomplete" };
    const tree = tables[0];
    const bodies = [...tree.querySelectorAll("tbody")];
    if (bodies.length !== 1
      || bodies[0].querySelectorAll("tr.coursecategory.category").length !== 1
      || bodies[0].querySelectorAll("tr.courseitem.item").length !== 1) {
      return { error: "moodle_gradebook_setup_incomplete" };
    }
    const categories = new Map();
    const items = new Map();
    let rootCategoryId = "";
    const rowTarget = (row, kind) => {
      const trigger = kind === "category" ? "add-category-form" : "add-item-form";
      const targetAttribute = kind === "category" ? "data-category" : "data-itemid";
      const controls = [...row.querySelectorAll(`a[data-trigger="${trigger}"]`)];
      const labels = [...row.querySelectorAll(".column-name .rowtitle")];
      const menuType = kind === "category" ? "category" : "item";
      const menuButtons = [...row.querySelectorAll(`button.cellmenubtn[data-type="${menuType}"][data-id]`)];
      if (controls.length !== 1 || labels.length !== 1 || menuButtons.length !== 1) return null;
      const control = controls[0];
      const targetId = id(control.getAttribute(targetAttribute));
      const rowTargetId = kind === "item" ? id(row.getAttribute(targetAttribute)) : targetId;
      const menuTargetId = id(menuButtons[0].getAttribute("data-id"));
      const label = String(labels[0].textContent || "").replace(/\s+/g, " ").trim();
      if (!control.classList.contains("dropdown-item") || control.getAttribute("href") !== "#"
        || id(control.getAttribute("data-courseid")) !== courseId || !targetId || rowTargetId !== targetId
        || menuTargetId !== targetId || !validText(label, 500)) return null;
      return { id: targetId, name: label };
    };
    const categoryRows = [...bodies[0].querySelectorAll("tr.category")];
    const ordinaryItemRows = [...bodies[0].querySelectorAll("tr.item")]
      .filter((row) => !row.classList.contains("courseitem") && !row.classList.contains("categoryitem"));
    for (const row of categoryRows) {
      const target = rowTarget(row, "category");
      if (!target || categories.has(target.id)) return { error: "moodle_gradebook_setup_incomplete" };
      if (row.classList.contains("coursecategory")) rootCategoryId = target.id;
      categories.set(target.id, target);
    }
    for (const row of ordinaryItemRows) {
      const target = rowTarget(row, "item");
      if (!target || items.has(target.id)) return { error: "moodle_gradebook_setup_incomplete" };
      items.set(target.id, target);
    }
    if (!rootCategoryId) return { error: "moodle_gradebook_setup_incomplete" };
    const data = {
      course_id: courseId,
      categories: [...categories.values()].sort((left, right) => Number(left.id) - Number(right.id)),
      grade_item_links: [...items.values()].sort((left, right) => Number(left.id) - Number(right.id)),
      proof: proofFor("setup"),
    };
    return { data, rootCategoryId, snapshotDigest: await digest(data) };
  };
  const scalesState = async (documentValue, context, courseId) => {
    const endpoint = endpointFor(context, courseId, "scales");
    const scales = [];
    const listed = [];
    const seen = new Set();
    let rows = 0;
    for (const table of documentValue.querySelectorAll("table")) {
      for (const cells of dataRows(table)) {
        // public/grade/edit/scale/index.php marks each scale row with its option list.
        if (!cells.some((cell) => cell.querySelector(".scale_options"))) continue;
        if (++rows > MAX_LIST_ROWS || cells.length !== 3) return { error: SCALES_INCOMPLETE };
        const boxes = [...cells[0].querySelectorAll(".scale_options")];
        if (boxes.length !== 1) return { error: SCALES_INCOMPLETE };
        const named = cells[0].cloneNode(true);
        named.querySelector(".scale_options").remove();
        const name = textOf(named);
        const options = textOf(boxes[0]).split(",").map((option) => option.trim());
        if (!validText(name, 500) || options.length > MAX_SCALE_OPTIONS || !options.every((option) => validText(option, 500))) {
          return { error: SCALES_INCOMPLETE };
        }
        const control = rowControl(cells[2], endpoint, context, courseId, "/grade/edit/scale/edit.php", "/grade/edit/scale/index.php", "scaleid");
        if (control.shape === "text" || control.shape === "invalid") return { error: SCALES_INCOMPLETE };
        if (control.shape === "none") {
          listed.push({ name, options });
          continue;
        }
        if (seen.has(control.targetId)) return { error: SCALES_INCOMPLETE };
        seen.add(control.targetId);
        scales.push({ scale_id: control.targetId, name, options, in_use: !control.deletable });
      }
    }
    const data = { course_id: courseId, scales, listed_scales: listed, proof: proofFor("scales") };
    return { data, snapshotDigest: await digest(data) };
  };
  const outcomeRow = (cells, endpoint, context, courseId, site) => {
    const counts = site ? [cells[3], cells[4]] : [cells[3]];
    const texts = [textOf(cells[0]), textOf(cells[1]), textOf(cells[2])];
    if (!texts.every((value) => validText(value, 500)) || !counts.every((cell) => COUNT.test(textOf(cell)))) return null;
    const control = rowControl(cells[cells.length - 1], endpoint, context, courseId, "/grade/edit/outcome/edit.php", "/grade/edit/outcome/index.php", "outcomeid");
    if (control.shape === "text") return null;
    if (control.shape === "invalid") return { invalid: true };
    const record = {
      full_name: texts[0],
      short_name: texts[1],
      scale_name: texts[2],
      ...(site ? { course_uses: Number(textOf(cells[3])), item_uses: Number(textOf(cells[4])) } : { item_uses: Number(textOf(cells[3])) }),
    };
    return { record, targetId: control.targetId };
  };
  const outcomesState = async (documentValue, context, courseId) => {
    const endpoint = endpointFor(context, courseId, "outcomes");
    // public/grade/edit/outcome/index.php gives course outcomes five columns and
    // site outcomes six, because only the site table counts courses.
    const tables = new Map();
    for (const table of documentValue.querySelectorAll("table")) {
      const rows = dataRows(table);
      const widths = new Set(rows.map((cells) => cells.length));
      if (widths.size !== 1) continue;
      const site = rows[0].length === 6;
      if (rows[0].length !== 5 && !site) continue;
      if (rows.length > MAX_LIST_ROWS) return { error: OUTCOMES_INCOMPLETE };
      const parsed = rows.map((cells) => outcomeRow(cells, endpoint, context, courseId, site));
      if (parsed.some((entry) => entry?.invalid === true)) return { error: OUTCOMES_INCOMPLETE };
      const complete = parsed.filter(Boolean);
      if (!complete.length) continue;
      if (complete.length !== parsed.length || tables.has(rows[0].length)) return { error: OUTCOMES_INCOMPLETE };
      tables.set(rows[0].length, complete);
    }
    const course = tables.get(5) || [];
    const site = tables.get(6) || [];
    // The course table always carries its own edit control, so a course row
    // without an identity means the page is not the one this reader parses.
    if (course.some((entry) => !entry.targetId)) return { error: OUTCOMES_INCOMPLETE };
    const identities = course.map((entry) => entry.targetId);
    if (new Set(identities).size !== identities.length) return { error: OUTCOMES_INCOMPLETE };
    const data = {
      course_id: courseId,
      course_outcomes: course.map((entry) => ({ outcome_id: entry.targetId, ...entry.record })),
      site_outcomes: site.map((entry) => entry.record),
      proof: proofFor("outcomes"),
    };
    return { data, snapshotDigest: await digest(data) };
  };
  const settingsState = async (documentValue, context, courseId) => {
    const endpoint = endpointFor(context, courseId, "settings");
    const form = nativeForm(documentValue, endpoint);
    if (!form) return { error: "moodle_gradebook_form_invalid" };
    const entries = entriesFor(form);
    const byName = (name) => entries?.filter(([entryName]) => entryName === name).map(([, value]) => value) || [];
    if (!entries || !one(byName("id"), courseId)) return { error: "moodle_gradebook_form_invalid" };
    if (!one(byName("sesskey"), context.sesskey)) return { error: "moodle_form_session_mismatch" };
    const chosen = entries.filter(([name]) => SETTING_NAME.test(name) && !TRANSIENT_FIELD.test(name));
    if (!GENERAL_SETTINGS.every((name) => byName(name).length === 1)) return { error: "moodle_gradebook_form_invalid" };
    if (chosen.some(([, value]) => value === context.sesskey)) return { error: "moodle_gradebook_form_invalid" };
    const selects = new Map();
    for (const select of form.querySelectorAll("select[name]")) {
      const name = select.getAttribute("name");
      selects.set(name, selects.has(name) ? null : select);
    }
    const labels = [];
    for (const [name] of chosen) {
      const select = selects.get(name);
      const selected = select && !select.multiple ? [...select.options].filter((option) => option.selected) : [];
      const label = selected.length === 1 ? textOf(selected[0]) : "";
      if (label && label !== context.sesskey && validText(label, 500)) labels.push({ name, label });
    }
    const data = {
      course_id: courseId,
      settings: chosen.map(([name, value]) => ({ name, value })),
      selected_option_labels: labels,
      proof: proofFor("settings"),
    };
    return { data, snapshotDigest: await digest(data) };
  };
  const rootCategoryProof = async (context, courseId, targetId) => {
    const page = await readPage(context, endpointFor(context, courseId, "setup"));
    if (page.error) return failure(page.error, page.status);
    const setup = await setupState(page.document, context, courseId);
    if (setup.error) return failure(setup.error, page.status);
    return { ok: true, rootCategory: setup.rootCategoryId === targetId };
  };
  const loadForm = async (context, courseId, kind, targetId, mutable = null) => {
    const page = await readPage(context, endpointFor(context, courseId, kind, targetId));
    if (page.error) return { error: page.error, status: page.status };
    let state = await formState(page.document, context, courseId, kind, targetId, mutable);
    if (state.error === ROOT_CATEGORY_PROOF_REQUIRED) {
      const rootProof = await rootCategoryProof(context, courseId, targetId);
      if (!rootProof.ok) return { error: rootProof.error, status: rootProof.status };
      if (!rootProof.rootCategory) return { error: "moodle_gradebook_form_invalid", status: page.status };
      state = await formState(page.document, context, courseId, kind, targetId, mutable, true);
    }
    return state.error ? { error: state.error, status: page.status } : { status: page.status, state };
  };
  const readTarget = async (context, courseId, kind, targetId) => {
    const loaded = await loadForm(context, courseId, kind, targetId);
    if (loaded.error) return failure(loaded.error, loaded.status);
    return { ok: true, sent: true, status: loaded.status, data: output(kind, courseId, targetId, loaded.state), snapshot_digest: loaded.state.snapshotDigest };
  };
  /**
   * `changes` maps a native control name to the value this one reviewed change
   * sends. Every other successful control of the loaded form is carried
   * through unchanged. A control the form repeats, such as the hidden and
   * checkbox halves of a native yes/no control, receives the new value in
   * every position, so the native form reads the change whichever half it
   * takes.
   */
  const postForm = async (context, courseId, kind, targetId, state, changes) => {
    const preflight = currentContext();
    if (!sameContext(context, preflight) || state.nativeSesskey !== preflight?.sesskey) return { error: "moodle_form_session_mismatch" };
    const body = new URLSearchParams();
    const carried = new Set();
    for (const [field, value] of state.entries) {
      if (changes.has(field)) carried.add(field);
      body.append(field, changes.has(field) ? changes.get(field) : value);
    }
    for (const [field, value] of changes) if (!carried.has(field)) body.append(field, value);
    body.append(state.submit.name, state.submit.value);
    let response;
    try {
      writeAttempted = true;
      response = await fetch(state.action, {
        method: "POST", credentials: "include", cache: "no-store", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "text/html" }, body,
      });
    } catch { return unconfirmedWrite("moodle_gradebook_write_unconfirmed"); }
    if (!sameContext(context, currentContext())) return unconfirmedWrite("moodle_gradebook_write_unconfirmed", response.status);
    // Chromium exposes a manual same-origin POST redirect as opaqueredirect.
    // The browser does not follow it. A fixed form endpoint and the exact
    // immediate native-form readback below are therefore the confirmation.
    if (response.type === "opaqueredirect") return { sent: true };
    if (![301, 302, 303, 307, 308].includes(response.status)) return unconfirmedWrite("moodle_gradebook_write_unconfirmed", response.status);
    const location = response.headers.get("location") || "";
    const index = endpointFor(context, courseId, "setup");
    let redirect;
    try { redirect = new URL(location, state.action); } catch { return unconfirmedWrite("moodle_gradebook_write_unconfirmed", response.status); }
    return sameRoute(redirect.href, index) ? { sent: true, status: response.status } : unconfirmedWrite("moodle_gradebook_write_unconfirmed", response.status);
  };
  const namedControls = (form, name) => [...form.querySelectorAll("[name]")].filter((control) => control.getAttribute("name") === name);
  const writableSelect = (form, name, value) => {
    const selects = namedControls(form, name).filter((control) => control.tagName === "SELECT");
    return selects.length === 1 && !selects[0].disabled && !selects[0].multiple
      && [...selects[0].options].some((option) => String(option.value) === value);
  };
  // A native control Moodle has frozen renders as static text with a hidden
  // field, so a writable text control is the single visible input or textarea.
  const writableText = (form, name) => {
    const controls = namedControls(form, name);
    const editable = controls.filter((control) => (control.tagName === "INPUT" && ["", "text", "number"].includes(String(control.getAttribute("type") || "").toLowerCase())) || control.tagName === "TEXTAREA");
    return controls.length === 1 && editable.length === 1 && !editable[0].disabled && !editable[0].readOnly;
  };
  const writableCheckbox = (form, name) => {
    const controls = namedControls(form, name);
    const boxes = controls.filter((control) => control.tagName === "INPUT" && String(control.getAttribute("type") || "").toLowerCase() === "checkbox");
    const hidden = controls.filter((control) => control.tagName === "INPUT" && String(control.getAttribute("type") || "").toLowerCase() === "hidden");
    return boxes.length === 1 && !boxes[0].disabled && boxes[0].value === "1" && boxes.length + hidden.length === controls.length;
  };
  // A repeated control, such as the hidden and checkbox halves of a native
  // yes/no control, is read the way the native form reads it: the last value.
  const valuesOf = (state, name) => state.entries.filter(([field]) => field === name).map(([, value]) => value);
  const currentText = (state, name) => {
    const values = valuesOf(state, name);
    return values.length ? values[values.length - 1] : "";
  };
  const nativeNumber = (text) => (NATIVE_NUMBER.test(String(text)) ? Number(String(text).replace(",", ".")) : null);
  // Moodle renders and reads a saved float with the site language's decimal
  // separator, so the separator the loaded control already shows is the one
  // this change sends back.
  const nativeSeparator = (text) => NATIVE_NUMBER.exec(String(text))?.[1] || "";
  const gradeRangeAfter = (state, requested) => {
    const asked = (argument) => requested.find((entry) => entry.argument === argument)?.value;
    const maximum = asked("maximum_grade") ?? nativeNumber(currentText(state, "grademax"));
    const minimum = asked("minimum_grade") ?? nativeNumber(currentText(state, "grademin"));
    return maximum === null || minimum === null ? null : { maximum, minimum };
  };
  /**
   * Turns one reviewed settings request into the exact native control values it
   * would send, or into the reason the loaded form refuses it. Every value must
   * be one the loaded control itself offers or can carry.
   */
  const settingsPlan = (state, kind, requested, rescaleEffect) => {
    const changes = new Map();
    const applied = [];
    for (const spec of requested) {
      if (spec.kind === "select") {
        const value = String(spec.value);
        if (!writableSelect(state.form, spec.field, value)) return { error: "moodle_gradebook_native_setting_refused" };
        changes.set(spec.field, value);
        applied.push({ name: spec.argument, field: spec.field, value: spec.value });
        continue;
      }
      if (!writableText(state.form, spec.field)) return { error: "moodle_gradebook_native_setting_refused" };
      if (spec.kind === "count") {
        changes.set(spec.field, String(spec.value));
        applied.push({ name: spec.argument, field: spec.field, value: spec.value });
        continue;
      }
      const separator = nativeSeparator(currentText(state, spec.field));
      if (!separator && !Number.isInteger(spec.value)) return { error: "moodle_gradebook_native_setting_refused" };
      changes.set(spec.field, String(spec.value).replace(".", separator || "."));
      applied.push({ name: spec.argument, field: spec.field, value: spec.value });
      if (!spec.override) continue;
      if (!writableCheckbox(state.form, spec.override)) return { error: "moodle_gradebook_native_setting_refused" };
      changes.set(spec.override, "1");
      applied.push({ name: spec.overrideName, field: spec.override, value: 1 });
    }
    if (kind !== "item") {
      return rescaleEffect ? { error: "moodle_gradebook_native_setting_refused" } : { changes, applied };
    }
    // The native item form offers its rescale control only for an item that
    // already has grades. Its absence for a scale item is why a grade-type
    // change is bounded away from the scale grade type on both sides.
    const rescalable = writableSelect(state.form, RESCALE_FIELD, RESCALE_EFFECTS.rescale) && writableSelect(state.form, RESCALE_FIELD, RESCALE_EFFECTS.keep);
    const gradeType = requested.find((entry) => entry.argument === "grade_type");
    if (gradeType) {
      if (rescalable) return { error: "moodle_gradebook_grade_type_refused" };
      if (currentText(state, "gradetype") === GRADE_TYPE_SCALE || String(gradeType.value) === GRADE_TYPE_SCALE) return { error: "moodle_gradebook_grade_type_refused" };
    }
    const changesRange = requested.some((entry) => GRADE_RANGE_ARGUMENTS.includes(entry.argument));
    if (changesRange) {
      // The saved range must stay a range, and the half this change does not
      // name is read from the form it is about to send.
      const range = gradeRangeAfter(state, requested);
      if (!range || range.maximum <= range.minimum) return { error: "moodle_gradebook_native_setting_refused" };
    }
    if (!rescalable || !changesRange) {
      return rescaleEffect ? { error: "moodle_gradebook_native_setting_refused" } : { changes, applied };
    }
    if (!rescaleEffect) return { error: "moodle_gradebook_rescale_approval_required" };
    changes.set(RESCALE_FIELD, RESCALE_EFFECTS[rescaleEffect]);
    return { changes, applied, rescaleEffect };
  };
  /**
   * Every bounded setting is a number on the native form, and Moodle formats a
   * saved one for display, so the readback is compared as a number. A returned
   * value is the one the saved form gave back, not the one that was requested.
   */
  const savedSettings = (state, applied) => {
    const saved = [];
    for (const entry of applied) {
      const value = nativeNumber(currentText(state, entry.field));
      if (value === null || value !== entry.value) return null;
      saved.push({ name: entry.name, value });
    }
    return saved;
  };
  const runSettingsWrite = async (context, definition, args) => {
    const kind = definition.kind;
    const mutable = new Set([
      ...args.requested.flatMap((spec) => (spec.override ? [spec.field, spec.override] : [spec.field])),
      ...(kind === "item" && args.rescaleEffect ? [RESCALE_FIELD] : []),
    ]);
    // One load, immediately before the one POST: the reviewed digest is checked
    // against the exact form this change carries and sends.
    const loaded = await loadForm(context, args.courseId, kind, args.targetId, mutable);
    if (loaded.error) return failure(loaded.error, loaded.status);
    if (loaded.state.snapshotDigest !== args.expectedDigest) return failure("moodle_expected_digest_mismatch", loaded.status);
    const plan = settingsPlan(loaded.state, kind, args.requested, args.rescaleEffect);
    if (plan.error) return failure(plan.error, loaded.status);
    const posted = await postForm(context, args.courseId, kind, args.targetId, loaded.state, plan.changes);
    if (posted.error) return posted.sent === true ? posted : failure(posted.error, posted.status);
    const after = await loadForm(context, args.courseId, kind, args.targetId, mutable);
    if (after.error) return unconfirmedWrite("moodle_gradebook_readback_unconfirmed", posted.status);
    const saved = savedSettings(after.state, plan.applied);
    if (!saved || after.state.protectedDigest !== loaded.state.protectedDigest) {
      return unconfirmedWrite("moodle_gradebook_write_not_verified", posted.status);
    }
    return {
      ok: true,
      sent: true,
      status: posted.status ?? after.status,
      data: {
        ...output(kind, args.courseId, args.targetId, after.state),
        changed_settings: saved,
        // Morrow never reads a stored grade, so a rescale effect is reported as
        // the choice the approval named and the change sent, never as a read
        // of what happened to the grades themselves.
        ...(plan.rescaleEffect ? { rescale_effect_sent: plan.rescaleEffect } : {}),
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
    if (!args) return failure("moodle_gradebook_arguments_invalid");
    if (COURSE_PAGE_KINDS.includes(definition.kind)) {
      const page = await readPage(context, endpointFor(context, args.courseId, definition.kind));
      if (page.error) return failure(page.error, page.status);
      const readers = { setup: setupState, scales: scalesState, outcomes: outcomesState, settings: settingsState };
      const state = await readers[definition.kind](page.document, context, args.courseId);
      if (state.error) return failure(state.error, page.status);
      return { ok: true, sent: true, status: page.status, data: state.data, snapshot_digest: state.snapshotDigest };
    }
    if (definition.settings === true) return await runSettingsWrite(context, definition, args);
    const before = await readTarget(context, args.courseId, definition.kind, args.targetId);
    if (!before.ok || definition.readOnly) return before;
    if (before.snapshot_digest !== args.expectedDigest) return failure("moodle_expected_digest_mismatch", before.status);
    const refreshed = await loadForm(context, args.courseId, definition.kind, args.targetId);
    if (refreshed.error) return failure(refreshed.error, refreshed.status);
    const state = refreshed.state;
    if (state.snapshotDigest !== args.expectedDigest) return failure("moodle_expected_digest_mismatch", refreshed.status);
    const posted = await postForm(context, args.courseId, definition.kind, args.targetId, state, new Map([[state.targetName, args.name]]));
    if (posted.error) return posted.sent === true ? posted : failure(posted.error, posted.status);
    const after = await readTarget(context, args.courseId, definition.kind, args.targetId);
    if (!after.ok) return unconfirmedWrite("moodle_gradebook_readback_unconfirmed", posted.status);
    if (after.data.protected_settings_digest !== state.protectedDigest || after.data[state.targetName === "fullname" ? "fullname" : "item_name"] !== args.name) {
      return unconfirmedWrite("moodle_gradebook_write_not_verified", posted.status);
    }
    return { ...after, status: posted.status ?? after.status, verification: { schema: "morrow.browser-verification.v1", status: "verified" } };
  } catch (error) {
    if (writeAttempted) return unconfirmedWrite("moodle_gradebook_write_unconfirmed");
    return failure(String(error?.message || error).startsWith("moodle_") ? String(error.message) : "moodle_gradebook_execution_failed");
  }
}
