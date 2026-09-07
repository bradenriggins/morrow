/**
 * Reads and changes the access restrictions of one activity and of one course
 * section, through the single native control that holds them.
 *
 * Moodle keeps a restriction set as one JSON tree in one form control named
 * `availabilityconditionsjson`. `public/course/moodleform_mod.php` renders that
 * control on the activity settings form and `public/course/editsection_form.php`
 * renders it on the section settings form. The page's own JavaScript parses the
 * tree, draws the restriction editor, and writes the tree back into the control
 * when the form is submitted. Morrow does not run that editor. It parses the
 * tree itself, reports it in readable form, and writes one complete tree back
 * into the same control.
 * https://github.com/moodle/moodle/blob/v5.2.2/public/course/moodleform_mod.php
 * https://github.com/moodle/moodle/blob/v5.2.2/public/course/editsection_form.php
 * https://github.com/moodle/moodle/blob/v5.2.2/public/availability/classes/tree.php
 *
 * Four facts shape every operation here.
 *
 * 1. The tree is one value. Moodle saves the whole control, so a change cannot
 *    name one condition: it sends the complete tree and requires the complete
 *    saved tree back.
 * 2. A condition class is a plugin. A site can install an availability
 *    condition whose PHP class this parser has never seen, and the browser
 *    cannot resolve what it means or write it back. Morrow reads only the six
 *    conditions Moodle ships, reports anything else as a restriction it did not
 *    understand, and refuses every change to such a tree before anything is
 *    sent.
 * 3. A profile condition can carry a person. Its value is text an instructor
 *    typed, and the standard fields it can test include `email`, `idnumber`,
 *    `phone1`, `phone2` and `address`, so the value can name one learner. That
 *    text never leaves the page. A read reports the field, the operator and a
 *    digest of the value; a change either sets new text the caller supplies, or
 *    keeps the value already in the form by naming that digest.
 *    https://github.com/moodle/moodle/blob/v5.2.2/public/availability/condition/profile/classes/condition.php
 * 4. Reading must not cause completion. Moodle can record a completion, an
 *    attendance or a launch from an activity view, so nothing here opens
 *    `view.php` for any module or for the course. Both reads use a native
 *    settings form, both writes send one POST to that same form, and neither
 *    follows the redirect Moodle answers with.
 *
 * Chrome serializes this function for a MAIN-world injection. Keep every
 * dependency inside the function body.
 */
export async function executeMoodleRestrictionsInPage(rawInput) {
  const PROVIDER = "moodle";
  const MAX_FORM_ENTRIES = 600;
  // An activity settings form carries the activity description, so it needs the
  // same byte bound the course settings form does.
  const MAX_FORM_BYTES = 512 * 1024;
  const MAX_VALUE_BYTES = 64 * 1024;
  const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
  const MAX_FILE_AREAS = 20;
  const MAX_TREE_BYTES = 64 * 1024;
  const MAX_TREE_NODES = 100;
  // A restriction set can hold restriction sets of its own. Morrow reads one
  // level of them; a tree that nests deeper is reported as one it did not
  // understand, and no change to it is sent.
  const MAX_NESTED_DEPTH = 1;
  const MAX_TEXT = 255;
  const MAX_LABEL = 200;
  const MAX_FIELD_NAME = 100;
  const MAX_GRADE_BOUND = 1_000_000;
  const ID = /^[1-9][0-9]{0,18}$/;
  const DIGEST = /^[a-f0-9]{64}$/;
  const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
  // The one native control that holds the restriction tree, on both forms.
  const FIELD = "availabilityconditionsjson";
  const DATE_COMPONENTS = ["year", "month", "day", "hour", "minute"];
  // 1 January 1970 to 1 January 2100 in Unix seconds. A change outside that is
  // refused; a stored date outside it is still read and reported.
  const MIN_TIME = 0;
  const MAX_TIME = 4_102_444_800;
  // A draft item id, a session key and mform's own state fields change on every
  // load of the same form, so they are never part of a digest or a result.
  const TRANSIENT_FIELD = /(?:sesskey|statekey|_qf__|csrf|token|secret|password|authorization|cookie|(?:^|[\[_-])(?:draft|itemid)(?:$|[\]_-]))/i;
  // core_availability\tree operators, in Moodle's own words.
  // https://github.com/moodle/moodle/blob/v5.2.2/public/availability/classes/tree.php
  const MATCH_OF = Object.freeze({ "&": "all", "|": "any", "!&": "not_all", "!|": "none" });
  const OP_OF = Object.freeze({ all: "&", any: "|", not_all: "!&", none: "!|" });
  // Moodle keeps one show flag per child for `&` and `!|`, and one flag for the
  // whole set for `|` and `!&`. Only the root of the tree carries either.
  const PER_CHILD_MATCH = Object.freeze(["all", "none"]);
  const MATCH_TEXT = Object.freeze({
    all: "A learner must match all of these:",
    any: "A learner must match any of these:",
    not_all: "A learner must not match all of these:",
    none: "A learner must not match any of these:",
  });
  const HIDDEN_TEXT = "Hidden entirely from a learner who does not match.";
  const SHOWN_TEXT = "Shown greyed out, with the restriction, to a learner who does not match.";
  // The COMPLETION_* states the completion condition stores.
  // https://github.com/moodle/moodle/blob/v5.2.2/public/availability/condition/completion/classes/condition.php
  const COMPLETION_OF = Object.freeze({ 0: "incomplete", 1: "complete", 2: "complete_pass", 3: "complete_fail" });
  const COMPLETION_CODE = Object.freeze({ incomplete: 0, complete: 1, complete_pass: 2, complete_fail: 3 });
  const COMPLETION_TEXT = Object.freeze({
    incomplete: "is not marked complete",
    complete: "is marked complete",
    complete_pass: "is complete with a passing grade",
    complete_fail: "is complete with a failing grade",
  });
  const PROFILE_OPERATORS = Object.freeze({
    contains: "contains",
    doesnotcontain: "does not contain",
    isequalto: "is equal to",
    startswith: "starts with",
    endswith: "ends with",
    isempty: "is empty",
    isnotempty: "is not empty",
  });
  const PROFILE_VALUELESS = Object.freeze(["isempty", "isnotempty"]);
  const definitions = Object.freeze({
    "moodle.form.course.modedit.restrictions.read.v1": { toolName: "moodle_get_activity_restrictions", readOnly: true, kind: "read", route: "activity" },
    "moodle.form.course.modedit.restrictions.write.v1": { toolName: "moodle_update_activity_restrictions", readOnly: false, kind: "write", route: "activity" },
    "moodle.form.course.editsection.restrictions.read.v1": { toolName: "moodle_get_section_restrictions", readOnly: true, kind: "read", route: "section" },
    "moodle.form.course.editsection.restrictions.write.v1": { toolName: "moodle_update_section_restrictions", readOnly: false, kind: "write", route: "section" },
  });
  const ROUTES = Object.freeze({
    activity: Object.freeze({
      name: "activity",
      prefix: "moodle_activity_restrictions",
      path: "/course/modedit.php",
      capability: "moodle/course:manageactivities",
      scope: "activity_restrictions_only",
      target: "module_id",
      // Save and return to the course. The other native submit, `submitbutton`,
      // redirects to the activity's own view page, which Moodle can treat as a
      // learner-visible view.
      submitField: "submitbutton2",
      // The native "Send content change notification" checkbox mails every
      // enrolled learner. Morrow never sends it.
      neverSend: Object.freeze(["coursecontentnotification"]),
    }),
    section: Object.freeze({
      name: "section",
      prefix: "moodle_section_restrictions",
      path: "/course/editsection.php",
      capability: "moodle/course:update",
      scope: "section_restrictions_only",
      target: "section_id",
      submitField: "submitbutton",
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
    && value === value.trim() && !CONTROL_CHARACTER.test(value);
  const stable = (value) => {
    if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
    if (object(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
    return JSON.stringify(value === undefined ? null : value);
  };
  const digest = async (value) => {
    if (!globalThis.crypto?.subtle || typeof globalThis.TextEncoder !== "function") throw new Error("moodle_restrictions_digest_unavailable");
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
  /**
   * The native form answers a saved change with a redirect to a course page.
   * The activity form returns to the course; the section form returns to the
   * course page or to the section's own page, whichever the course format uses.
   * Morrow never follows it, so the target is checked and discarded.
   * https://github.com/moodle/moodle/blob/v5.2.2/public/course/editsection.php
   */
  const savedRedirect = (context, route, courseId, targetId, value, base) => {
    let received;
    try { received = new URL(value, base); } catch { return false; }
    const course = urlFor(context, "/course/view.php", { id: courseId });
    if (received.origin === course.origin && received.pathname === course.pathname
      && received.searchParams.get("id") === courseId) return true;
    if (route.name !== "section") return false;
    const section = urlFor(context, "/course/section.php", { id: targetId });
    return received.origin === section.origin && received.pathname === section.pathname
      && received.searchParams.get("id") === targetId;
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
  /**
   * The one restriction control of the loaded form. Moodle renders the
   * restriction section only while the site has availability switched on, so a
   * form without it is reported as a form that carries no restriction control.
   */
  const restrictionControl = (form) => {
    const controls = namedControls(form, FIELD);
    if (controls.length !== 1) return null;
    const control = controls[0];
    if (control.tagName !== "TEXTAREA" || control.disabled || control.readOnly) return null;
    return control;
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
  /**
   * The digest preimage. A native optional date that is switched off still
   * renders its components, and Moodle re-defaults them on every load, so an
   * off date is recorded as the toggle alone.
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
  const integer = (value) => (Number.isSafeInteger(value) ? value : null);
  // Moodle's completion condition accepts a number or a numeric string for the
  // activity it names; every other condition requires an integer.
  // https://github.com/moodle/moodle/blob/v5.2.2/public/availability/condition/completion/classes/condition.php
  const numeric = (value) => (Number.isSafeInteger(value) ? value
    : typeof value === "string" && /^[0-9]{1,15}$/.test(value) ? Number(value) : null);
  const positive = (value) => (Number.isSafeInteger(value) && value > 0 ? value : null);
  const finiteNumber = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);
  const onlyKeys = (value, allowed) => Object.keys(value).every((key) => allowed.includes(key));
  const treeError = (prefix, reason) => ({ error: `${prefix}_${reason}` });
  /**
   * One saved condition, in the readable shape a caller reads and sends back. A
   * condition class this parser does not know is refused here, because an
   * installed availability plugin can add one the browser cannot resolve.
   */
  const conditionFrom = async (value, prefix, unknown, values) => {
    const type = typeof value.type === "string" ? value.type.slice(0, 60) : "";
    if (type === "date") {
      if (!onlyKeys(value, ["type", "d", "t"])) return treeError(prefix, "tree_invalid");
      const time = integer(value.t);
      if (time === null || (value.d !== ">=" && value.d !== "<")) return treeError(prefix, "tree_invalid");
      return { node: { type: "date", direction: value.d === ">=" ? "from" : "until", time } };
    }
    if (type === "grade") {
      if (!onlyKeys(value, ["type", "id", "min", "max"])) return treeError(prefix, "tree_invalid");
      const gradeItemId = positive(value.id);
      if (gradeItemId === null) return treeError(prefix, "tree_invalid");
      const node = { type: "grade", grade_item_id: gradeItemId };
      for (const bound of ["min", "max"]) {
        if (!Object.hasOwn(value, bound)) continue;
        const number = finiteNumber(value[bound]);
        if (number === null) return treeError(prefix, "tree_invalid");
        node[bound] = number;
      }
      return { node };
    }
    if (type === "group") {
      if (!onlyKeys(value, ["type", "id"])) return treeError(prefix, "tree_invalid");
      if (!Object.hasOwn(value, "id")) return { node: { type: "group" } };
      const groupId = positive(value.id);
      return groupId === null ? treeError(prefix, "tree_invalid") : { node: { type: "group", group_id: groupId } };
    }
    if (type === "grouping") {
      if (!onlyKeys(value, ["type", "id", "activity"])) return treeError(prefix, "tree_invalid");
      if (Object.hasOwn(value, "id")) {
        const groupingId = positive(value.id);
        return groupingId === null || Object.hasOwn(value, "activity")
          ? treeError(prefix, "tree_invalid")
          : { node: { type: "grouping", grouping_id: groupingId } };
      }
      return value.activity === true ? { node: { type: "grouping", activity_grouping: true } } : treeError(prefix, "tree_invalid");
    }
    if (type === "completion") {
      if (!onlyKeys(value, ["type", "cm", "e"])) return treeError(prefix, "tree_invalid");
      const moduleId = numeric(value.cm);
      const required = Number.isSafeInteger(value.e) ? COMPLETION_OF[value.e] : "";
      if (moduleId === null || moduleId <= 0 || !required) return treeError(prefix, "tree_invalid");
      return { node: { type: "completion", module_id: moduleId, required } };
    }
    if (type === "profile") {
      if (!onlyKeys(value, ["type", "op", "sf", "cf", "v"])) return treeError(prefix, "tree_invalid");
      const operator = typeof value.op === "string" && Object.hasOwn(PROFILE_OPERATORS, value.op) ? value.op : "";
      if (!operator) return treeError(prefix, "tree_invalid");
      const standard = Object.hasOwn(value, "sf");
      const custom = Object.hasOwn(value, "cf");
      if (standard === custom) return treeError(prefix, "tree_invalid");
      const field = standard ? value.sf : value.cf;
      if (!validText(field, MAX_FIELD_NAME)) return treeError(prefix, "tree_invalid");
      const node = { type: "profile", field, field_kind: standard ? "standard" : "custom", operator };
      if (PROFILE_VALUELESS.includes(operator)) {
        return Object.hasOwn(value, "v") ? treeError(prefix, "tree_invalid") : { node };
      }
      if (typeof value.v !== "string" || value.v.length < 1 || value.v.length > MAX_TEXT) return treeError(prefix, "tree_invalid");
      const valueDigest = await digest(value.v);
      values.set(valueDigest, value.v);
      return { node: { ...node, value_digest: valueDigest } };
    }
    unknown.add(type || "(unnamed)");
    return treeError(prefix, "condition_unrecognised");
  };
  /**
   * One saved restriction set. Moodle carries the show flags on the root of the
   * tree alone: one flag per child for `all` and `none`, one flag for the whole
   * set for `any` and `not_all`.
   */
  const nodeFrom = async (value, root, depth, prefix, unknown, counter, values) => {
    if (!object(value)) return treeError(prefix, "tree_invalid");
    if (depth > MAX_NESTED_DEPTH) return treeError(prefix, "tree_too_deep");
    const match = typeof value.op === "string" ? MATCH_OF[value.op] : "";
    if (!match || !Array.isArray(value.c)) return treeError(prefix, "tree_invalid");
    const perChild = PER_CHILD_MATCH.includes(match);
    const allowed = root ? ["op", "c", perChild ? "showc" : "show"] : ["op", "c"];
    if (!onlyKeys(value, allowed)) return treeError(prefix, "tree_invalid");
    if (root && perChild && !(Array.isArray(value.showc) && value.showc.length === value.c.length
      && value.showc.every((entry) => typeof entry === "boolean"))) return treeError(prefix, "tree_invalid");
    if (root && !perChild && typeof value.show !== "boolean") return treeError(prefix, "tree_invalid");
    const children = [];
    for (const [index, child] of value.c.entries()) {
      counter.count += 1;
      if (counter.count > MAX_TREE_NODES) return treeError(prefix, "tree_too_large");
      if (!object(child)) return treeError(prefix, "tree_invalid");
      const parsed = Object.hasOwn(child, "type")
        ? await conditionFrom(child, prefix, unknown, values)
        : await nodeFrom(child, false, depth + 1, prefix, unknown, counter, values);
      if (parsed.error) return parsed;
      children.push(root && perChild ? { ...parsed.node, hidden_entirely: value.showc[index] !== true } : parsed.node);
    }
    const node = { match, children };
    if (root && !perChild) node.hidden_entirely = value.show !== true;
    return { node };
  };
  /**
   * The saved restriction tree of one loaded form, in readable form. A profile
   * value stays in the page: what the tree carries is a digest of it.
   */
  const readTree = async (raw, prefix) => {
    const text = String(raw ?? "").trim();
    if (!text) return { tree: null, values: new Map() };
    const unknown = new Set();
    if (text.length > MAX_TREE_BYTES) return { error: `${prefix}_tree_too_large`, unknown: [] };
    let value;
    try { value = JSON.parse(text); } catch { return { error: `${prefix}_tree_not_json`, unknown: [] }; }
    const values = new Map();
    const parsed = await nodeFrom(value, true, 0, prefix, unknown, { count: 0 }, values);
    if (parsed.error) return { error: parsed.error, unknown: [...unknown].slice(0, 20) };
    // A tree Moodle keeps with no condition in it is no restriction at all.
    // core_availability\tree::is_empty
    return { tree: parsed.node.children.length ? parsed.node : null, values };
  };
  const timeText = (time) => {
    const stamp = new Date(time * 1000);
    return Number.isFinite(stamp.getTime())
      ? `${time} in Unix seconds (${stamp.toISOString()})`
      : `${time} in Unix seconds`;
  };
  const conditionText = (condition) => {
    if (condition.type === "date") {
      return `Date ${condition.direction === "from" ? "from" : "before"} ${timeText(condition.time)}.`;
    }
    if (condition.type === "grade") {
      const bounds = [];
      if (Object.hasOwn(condition, "min")) bounds.push(`at least ${condition.min}`);
      if (Object.hasOwn(condition, "max")) bounds.push(`less than ${condition.max}`);
      return `Grade item ${condition.grade_item_id}, ${bounds.length ? bounds.join(" and ") : "any grade"}.`;
    }
    if (condition.type === "group") {
      return Object.hasOwn(condition, "group_id") ? `Group ${condition.group_id}.` : "Any group.";
    }
    if (condition.type === "grouping") {
      return condition.activity_grouping === true ? "The grouping this activity uses." : `Grouping ${condition.grouping_id}.`;
    }
    if (condition.type === "completion") {
      return `Activity ${condition.module_id} ${COMPLETION_TEXT[condition.required]}.`;
    }
    const field = `Profile field ${condition.field}, a ${condition.field_kind} field,`;
    return PROFILE_VALUELESS.includes(condition.operator)
      ? `${field} ${PROFILE_OPERATORS[condition.operator]}.`
      : `${field} ${PROFILE_OPERATORS[condition.operator]} a value that stays in the browser.`;
  };
  /**
   * The restriction tree as lines a person reads before approving a change. It
   * describes exactly the tree beside it and adds nothing to it. A group, a
   * grouping, a grade item and an activity are named by the ID Moodle stores,
   * because this form does not carry their names.
   */
  const treeLines = (node, depth, lines) => {
    const flag = Object.hasOwn(node, "hidden_entirely") ? ` ${node.hidden_entirely ? HIDDEN_TEXT : SHOWN_TEXT}` : "";
    lines.push({ depth, text: `${MATCH_TEXT[node.match]}${flag}` });
    for (const child of node.children) {
      if (typeof child.match === "string") {
        treeLines(child, depth + 1, lines);
        continue;
      }
      const childFlag = Object.hasOwn(child, "hidden_entirely") ? ` ${child.hidden_entirely ? HIDDEN_TEXT : SHOWN_TEXT}` : "";
      lines.push({ depth: depth + 1, text: `${conditionText(child)}${childFlag}` });
    }
    return lines;
  };
  /**
   * One requested condition, in the same readable shape a read returns. A
   * profile value is either new text the caller supplies, or the value already
   * in the loaded form, named by its digest.
   */
  const requestedCondition = async (value, prefix, values) => {
    const type = value.type;
    if (type === "date") {
      if (!onlyKeys(value, ["type", "direction", "time"])) return treeError(prefix, "tree_invalid");
      const time = integer(value.time);
      if (time === null || time < MIN_TIME || time > MAX_TIME) return treeError(prefix, "tree_invalid");
      if (value.direction !== "from" && value.direction !== "until") return treeError(prefix, "tree_invalid");
      return {
        node: { type: "date", direction: value.direction, time },
        saved: { type: "date", d: value.direction === "from" ? ">=" : "<", t: time },
      };
    }
    if (type === "grade") {
      if (!onlyKeys(value, ["type", "grade_item_id", "min", "max"])) return treeError(prefix, "tree_invalid");
      const gradeItemId = positive(value.grade_item_id);
      if (gradeItemId === null) return treeError(prefix, "tree_invalid");
      const node = { type: "grade", grade_item_id: gradeItemId };
      const saved = { type: "grade", id: gradeItemId };
      for (const bound of ["min", "max"]) {
        if (!Object.hasOwn(value, bound)) continue;
        const number = finiteNumber(value[bound]);
        if (number === null || number < -MAX_GRADE_BOUND || number > MAX_GRADE_BOUND) return treeError(prefix, "tree_invalid");
        node[bound] = number;
        saved[bound] = number;
      }
      return { node, saved };
    }
    if (type === "group") {
      if (!onlyKeys(value, ["type", "group_id"])) return treeError(prefix, "tree_invalid");
      if (!Object.hasOwn(value, "group_id")) return { node: { type: "group" }, saved: { type: "group" } };
      const groupId = positive(value.group_id);
      return groupId === null ? treeError(prefix, "tree_invalid")
        : { node: { type: "group", group_id: groupId }, saved: { type: "group", id: groupId } };
    }
    if (type === "grouping") {
      if (!onlyKeys(value, ["type", "grouping_id", "activity_grouping"])) return treeError(prefix, "tree_invalid");
      if (Object.hasOwn(value, "grouping_id")) {
        const groupingId = positive(value.grouping_id);
        return groupingId === null || Object.hasOwn(value, "activity_grouping")
          ? treeError(prefix, "tree_invalid")
          : { node: { type: "grouping", grouping_id: groupingId }, saved: { type: "grouping", id: groupingId } };
      }
      return value.activity_grouping === true
        ? { node: { type: "grouping", activity_grouping: true }, saved: { type: "grouping", activity: true } }
        : treeError(prefix, "tree_invalid");
    }
    if (type === "completion") {
      if (!onlyKeys(value, ["type", "module_id", "required"])) return treeError(prefix, "tree_invalid");
      const moduleId = positive(value.module_id);
      const code = typeof value.required === "string" ? COMPLETION_CODE[value.required] : undefined;
      if (moduleId === null || code === undefined) return treeError(prefix, "tree_invalid");
      return {
        node: { type: "completion", module_id: moduleId, required: value.required },
        saved: { type: "completion", cm: moduleId, e: code },
      };
    }
    if (type === "profile") {
      if (!onlyKeys(value, ["type", "field", "field_kind", "operator", "value", "value_digest"])) return treeError(prefix, "tree_invalid");
      const operator = typeof value.operator === "string" && Object.hasOwn(PROFILE_OPERATORS, value.operator) ? value.operator : "";
      if (!operator || !validText(value.field, MAX_FIELD_NAME)) return treeError(prefix, "tree_invalid");
      if (value.field_kind !== "standard" && value.field_kind !== "custom") return treeError(prefix, "tree_invalid");
      const node = { type: "profile", field: value.field, field_kind: value.field_kind, operator };
      const saved = { type: "profile", op: operator, [value.field_kind === "standard" ? "sf" : "cf"]: value.field };
      if (PROFILE_VALUELESS.includes(operator)) {
        return Object.hasOwn(value, "value") || Object.hasOwn(value, "value_digest")
          ? treeError(prefix, "tree_invalid")
          : { node, saved };
      }
      const hasValue = Object.hasOwn(value, "value");
      const hasDigest = Object.hasOwn(value, "value_digest");
      if (hasValue === hasDigest) return treeError(prefix, "tree_invalid");
      let text;
      if (hasValue) {
        if (!validText(value.value, MAX_TEXT)) return treeError(prefix, "tree_invalid");
        text = value.value;
      } else {
        if (typeof value.value_digest !== "string" || !DIGEST.test(value.value_digest)) return treeError(prefix, "tree_invalid");
        // Only a value the loaded form already holds can be kept by its digest.
        text = values.get(value.value_digest);
        if (text === undefined) return treeError(prefix, "value_unknown");
      }
      node.value_digest = await digest(text);
      saved.v = text;
      return { node, saved };
    }
    return treeError(prefix, "condition_unrecognised");
  };
  /**
   * One requested restriction set, turned into the readable tree a readback is
   * compared against and the exact native value the change sends.
   */
  const requestedNode = async (value, root, depth, prefix, counter, values) => {
    if (!object(value)) return treeError(prefix, "tree_invalid");
    if (depth > MAX_NESTED_DEPTH) return treeError(prefix, "tree_too_deep");
    const match = typeof value.match === "string" ? value.match : "";
    if (!Object.hasOwn(OP_OF, match) || !Array.isArray(value.children) || value.children.length < 1) return treeError(prefix, "tree_invalid");
    const perChild = PER_CHILD_MATCH.includes(match);
    const allowed = root && !perChild ? ["match", "children", "hidden_entirely"] : ["match", "children"];
    if (!onlyKeys(value, allowed)) return treeError(prefix, "tree_invalid");
    if (root && !perChild && typeof value.hidden_entirely !== "boolean") return treeError(prefix, "tree_invalid");
    const children = [];
    const saved = [];
    const shown = [];
    for (const child of value.children) {
      counter.count += 1;
      if (counter.count > MAX_TREE_NODES) return treeError(prefix, "tree_too_large");
      if (!object(child)) return treeError(prefix, "tree_invalid");
      let hidden = false;
      let subject = child;
      if (root && perChild) {
        if (typeof child.hidden_entirely !== "boolean") return treeError(prefix, "tree_invalid");
        hidden = child.hidden_entirely;
        subject = { ...child };
        delete subject.hidden_entirely;
      } else if (Object.hasOwn(child, "hidden_entirely")) {
        return treeError(prefix, "tree_invalid");
      }
      const parsed = typeof subject.type === "string"
        ? await requestedCondition(subject, prefix, values)
        : await requestedNode(subject, false, depth + 1, prefix, counter, values);
      if (parsed.error) return parsed;
      children.push(root && perChild ? { ...parsed.node, hidden_entirely: hidden } : parsed.node);
      saved.push(parsed.saved);
      shown.push(!hidden);
    }
    const node = { match, children };
    const savedNode = { op: OP_OF[match], c: saved };
    if (root && perChild) savedNode.showc = shown;
    if (root && !perChild) {
      node.hidden_entirely = value.hidden_entirely;
      savedNode.show = !value.hidden_entirely;
    }
    return { node, saved: savedNode };
  };
  /**
   * One loaded form. The restriction control is the one control these
   * operations write, so it is never part of the protected set, and its raw
   * value is never disclosed: a profile condition inside it can name a person.
   * The snapshot digest still covers it, so a restriction that changed after
   * the review stops the change.
   */
  const loadForm = async (context, route, courseId, targetId) => {
    const prefix = route.prefix;
    const endpoint = route.name === "activity"
      ? urlFor(context, route.path, { update: targetId, return: 0 })
      : urlFor(context, route.path, { id: targetId });
    const page = await readPage(context, endpoint, prefix);
    if (page.error) return { error: page.error, status: page.status };
    const form = nativeForm(page.document, endpoint);
    if (!form) return { error: `${prefix}_form_invalid`, status: page.status };
    const entries = entriesFor(form);
    if (!entries) return { error: `${prefix}_form_invalid`, status: page.status };
    if (route.name === "activity") {
      if (!one(valuesOf(entries, "update"), targetId) || !one(valuesOf(entries, "coursemodule"), targetId)
        || !one(valuesOf(entries, "course"), courseId) || !validText(currentText(entries, "modulename"), 100)) {
        return { error: `${prefix}_form_invalid`, status: page.status };
      }
    } else if (!one(valuesOf(entries, "id"), targetId) || !one(valuesOf(entries, "course"), courseId)) {
      return { error: `${prefix}_form_invalid`, status: page.status };
    }
    if (!one(valuesOf(entries, "sesskey"), context.sesskey)) return { error: "moodle_form_session_mismatch", status: page.status };
    const submits = submitControls(form, route.submitField);
    if (submits.length !== 1) return { error: `${prefix}_form_invalid`, status: page.status };
    const fileAreas = await inspectFileAreas(context, form, entries);
    if (!fileAreas) return { error: `${prefix}_form_invalid`, status: page.status };
    const control = restrictionControl(form);
    const parsed = control ? await readTree(currentText(entries, FIELD), prefix) : { tree: null, values: new Map() };
    const snapshot = snapshotEntries(form, entries, fileAreas);
    const protectedEntries = snapshot.filter(([name]) => name !== FIELD);
    // A result never carries the session key, whatever the control is called.
    if (protectedEntries.some(([, value]) => value === context.sesskey)) return { error: `${prefix}_form_invalid`, status: page.status };
    const state = {
      form,
      entries,
      route,
      fileAreas,
      available: Boolean(control),
      understood: !parsed.error,
      parseError: parsed.error || "",
      unrecognisedConditions: parsed.unknown || [],
      tree: parsed.tree || null,
      values: parsed.values || new Map(),
      moduleType: route.name === "activity" ? currentText(entries, "modulename") : "",
      targetName: label(currentText(entries, "name")),
      action: new URL(form.getAttribute("action"), endpoint).href,
      nativeSesskey: context.sesskey,
      submit: { name: route.submitField, value: submits[0].value },
      protectedDigest: await digest({ courseId, targetId, entries: protectedEntries }),
      protectedFields: [...new Set(protectedEntries.map(([name]) => name))].sort(),
      // The digest preimage, in its exact order, so a caller can recompute it.
      protectedSettings: protectedEntries.map(([name, value]) => ({ name, value })),
      snapshotDigest: await digest({ courseId, targetId, entries: snapshot }),
    };
    return { status: page.status, state };
  };
  const output = (courseId, targetId, state) => {
    const route = state.route;
    return {
      course_id: courseId,
      [route.target]: targetId,
      ...(route.name === "activity"
        ? { module_type: state.moduleType, activity_name: state.targetName }
        : { section_name: state.targetName }),
      restrictions_available: state.available,
      restrictions_understood: state.understood,
      ...(state.understood ? {} : { restrictions_not_understood: state.parseError, unrecognised_conditions: state.unrecognisedConditions }),
      restrictions: state.understood ? state.tree : null,
      restriction_lines: state.understood && state.tree ? treeLines(state.tree, 0, []) : [],
      file_areas: [...state.fileAreas.entries()].map(([field, fileState]) => ({ field, state: fileState })),
      protected_settings_digest: state.protectedDigest,
      protected_setting_names: state.protectedFields,
      protected_settings: state.protectedSettings,
      proof: {
        method: "native_form_read",
        route: route.path,
        control: FIELD,
        required_capability: route.capability,
        scope: route.scope,
      },
    };
  };
  const argumentsFor = (definition, route, args, binding) => {
    const courseId = id(binding?.courseId);
    if (!courseId) return null;
    const targetId = id(args?.[route.target]);
    if (!targetId) return null;
    if (definition.kind === "read") {
      const expected = ["course_id", route.target];
      return object(args) && Object.keys(args).length === expected.length && expected.every((key) => Object.hasOwn(args, key))
        && id(args.course_id) === courseId ? { courseId, targetId } : null;
    }
    const allowed = new Set(["course_id", route.target, "restrictions", "expected_digest"]);
    if (!object(args) || Object.keys(args).some((key) => !allowed.has(key))) return null;
    if (id(args.course_id) !== courseId || !DIGEST.test(String(args.expected_digest || ""))) return null;
    if (!Object.hasOwn(args, "restrictions") || !(args.restrictions === null || object(args.restrictions))) return null;
    return { courseId, targetId, expectedDigest: args.expected_digest, requested: args.restrictions };
  };
  const runRead = async (context, route, args) => {
    const loaded = await loadForm(context, route, args.courseId, args.targetId);
    if (loaded.error) return failure(loaded.error, loaded.status);
    return {
      ok: true,
      sent: true,
      status: loaded.status,
      data: output(args.courseId, args.targetId, loaded.state),
      snapshot_digest: loaded.state.snapshotDigest,
    };
  };
  /**
   * `changes` maps a native control name to the exact value one reviewed change
   * sends. Every other control of the loaded form is carried through unchanged.
   */
  const postForm = async (context, route, courseId, targetId, state, changes) => {
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
      body.append(field, changes.get(field));
    }
    for (const [field, value] of changes) if (!carried.has(field)) body.append(field, value);
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
    return savedRedirect(context, route, courseId, targetId, response.headers.get("location") || "", state.action)
      ? { sent: true, status: response.status }
      : unconfirmedWrite(`${route.prefix}_write_unconfirmed`, response.status);
  };
  const runWrite = async (context, route, args) => {
    const prefix = route.prefix;
    // One load, immediately before the one POST: the reviewed digest is checked
    // against the exact form this change carries and sends.
    const loaded = await loadForm(context, route, args.courseId, args.targetId);
    if (loaded.error) return failure(loaded.error, loaded.status);
    const state = loaded.state;
    if (!state.available) return failure(`${prefix}_unavailable`, loaded.status);
    // A restriction Morrow could not read is one whose meaning it cannot keep,
    // so no change to that tree is sent.
    if (!state.understood) return failure(state.parseError, loaded.status);
    if (state.snapshotDigest !== args.expectedDigest) return failure("moodle_expected_digest_mismatch", loaded.status);
    const refusal = fileAreaRefusal(state.fileAreas, prefix);
    if (refusal) return failure(refusal, loaded.status);
    let expected = null;
    let sending = "";
    if (args.requested === null) {
      // The native page sends an empty tree when an instructor removes every
      // restriction, and Moodle stores no restriction for it.
      // core_availability\tree::is_empty
      sending = JSON.stringify({ op: "&", c: [], showc: [] });
    } else {
      const plan = await requestedNode(args.requested, true, 0, prefix, { count: 0 }, state.values);
      if (plan.error) return failure(plan.error, loaded.status);
      expected = plan.node;
      sending = JSON.stringify(plan.saved);
      if (sending.length > MAX_TREE_BYTES) return failure(`${prefix}_tree_too_large`, loaded.status);
    }
    const posted = await postForm(context, route, args.courseId, args.targetId, state, new Map([[FIELD, sending]]));
    if (posted.error) return posted.sent === true ? posted : failure(posted.error, posted.status);
    const after = await loadForm(context, route, args.courseId, args.targetId);
    if (after.error) return unconfirmedWrite(`${prefix}_readback_unconfirmed`, posted.status);
    if (!after.state.available || !after.state.understood || after.state.protectedDigest !== state.protectedDigest
      || stable(after.state.tree) !== stable(expected)) {
      return unconfirmedWrite(`${prefix}_write_not_verified`, posted.status);
    }
    return {
      ok: true,
      sent: true,
      status: posted.status ?? after.status,
      data: {
        ...output(args.courseId, args.targetId, after.state),
        // One POST of this control replaces the complete restriction tree.
        replaces_restriction_set: true,
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
    if (!args) return failure("moodle_restrictions_arguments_invalid");
    return definition.kind === "read" ? await runRead(context, route, args) : await runWrite(context, route, args);
  } catch (error) {
    if (writeAttempted) return unconfirmedWrite("moodle_restrictions_write_unconfirmed");
    return failure(String(error?.message || error).startsWith("moodle_") ? String(error.message) : "moodle_restrictions_execution_failed");
  }
}
