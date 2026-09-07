/**
 * Moodle's Subsection module: read one subsection, list what it holds, and add
 * one hidden subsection to an approved course.
 *
 * A subsection is an activity that owns a course section. `subsection_add_instance`
 * inserts the activity record and then calls
 * `formatactions::section($course)->create_delegated('mod_subsection', $id, ...)`,
 * so one Save creates both the activity and the section it shows inside the
 * section that holds it.
 * https://github.com/moodle/moodle/blob/v5.2.2/public/mod/subsection/lib.php#L56-L90
 *
 * Four facts shape these operations, and each one is stated in the catalog text
 * and in the result.
 *
 * 1. The pairing is read in full before anything else. Every section Moodle's
 *    Subsection module owns must be paired with exactly one activity that
 *    delegates it, that activity must sit in the section the owned section
 *    reports as its parent, that parent must be an ordinary section, and the
 *    owned section's activity list must be exactly the activities that name it.
 *    A pairing this cannot state exactly, and any other component that owns a
 *    section, refuse. Moodle does not let a subsection hold a subsection
 *    (`permission::can_add_subsection` returns false for an owned section), so
 *    the contents of one subsection are one list, not a tree.
 *    https://github.com/moodle/moodle/blob/v5.2.2/public/mod/subsection/classes/permission.php#L36-L55
 * 2. A new subsection is created hidden, through the native
 *    `course/modedit.php` form for `add=subsection`, with the form's own
 *    `visible` control set to 0. Moodle gives the section it creates the same
 *    name and the same visibility as the activity, so both come back hidden.
 *    It requires `moodle/course:manageactivities` and `mod/subsection:addinstance`
 *    at the course context.
 * 3. Moodle puts the section it creates at the end of the course's section
 *    numbers, because `calculate_positions` places a section with a component
 *    at `lastsection + 1` and nothing is moved afterwards. So no section
 *    already in the course changes place, and the course's own last section
 *    number rises by exactly one.
 *    https://github.com/moodle/moodle/blob/v5.2.2/public/course/format/classes/local/sectionactions.php#L42-L155
 * 4. The subsection form has no description and no files. Moodle 5.2 removed
 *    the subsection description, and `subsection_get_file_areas` returns an
 *    empty list, so this create writes a name and nothing else.
 *
 * The create reads the complete course state, requires the digest of the state
 * the person reviewed, reads the native form, reads the state and the form once
 * more immediately before it acts, sends exactly one native POST, then requires
 * the complete course state back with exactly one new hidden subsection, one
 * new hidden owned section at the end of the section numbers, and every other
 * section, activity and section order unchanged. A lost response or a state
 * that is not the approved one is `applied_or_unknown`; it is never retried.
 *
 * The returned course state, and the digest over it, are built exactly as
 * `moodle_get_contents` builds them, so the digest a person reviewed and the
 * digest this executor compares are the same value.
 *
 * No route here opens `/mod/subsection/view.php`, which records a module view
 * event and a completion state.
 *
 * Chrome serializes this function for a MAIN-world injection. Keep every
 * dependency inside the function body.
 */
export async function executeMoodleSubsectionInPage(rawInput) {
  const PROVIDER = "moodle";
  const AJAX_PATH = "/lib/ajax/service.php";
  const MODEDIT_PATH = "/course/modedit.php";
  const STATE_METHOD = "core_courseformat_get_state";
  const MODULE = "subsection";
  const COMPONENT = "mod_subsection";
  const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
  const MAX_ITEMS = 10_000;
  const MAX_NAME_LENGTH = 1_333;
  const MAX_FORM_ENTRIES = 600;
  const MAX_FORM_BYTES = 512 * 1024;
  const MAX_VALUE_BYTES = 256 * 1024;
  const ID = /^[1-9][0-9]*$/;
  const DIGEST = /^[a-f0-9]{64}$/;
  // Moodle renders a section and activity name through format_string, which
  // rewrites markup and multilang spans. A name that carries none of those
  // characters comes back exactly as it was sent, so only such a name is
  // accepted and the saved name is compared as an exact string.
  const NAME_REWRITTEN = /[<>&]/;
  // Controls the native form carries that this create never sends back:
  // the other save button, and the control that emails every enrolled learner.
  const UNSENT_CONTROLS = new Set(["submitbutton", "coursecontentnotification"]);
  const definitions = Object.freeze({
    "moodle.state.subsection.read.v1": { toolName: "moodle_get_subsection", readOnly: true, kind: "read" },
    "moodle.state.subsection.contents.read.v1": { toolName: "moodle_list_subsection_contents", readOnly: true, kind: "contents" },
    "moodle.form.course.modedit.subsection.create.write.v1": { toolName: "moodle_create_subsection", readOnly: false, kind: "create" },
  });
  const object = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
  const input = (() => { try { return typeof rawInput === "string" ? JSON.parse(rawInput) : rawInput; } catch { return null; } })();
  const failure = (error, status) => ({ ok: false, sent: false, ...(Number.isInteger(status) ? { status } : {}), error });
  const unconfirmedWrite = (error, status, extra = {}) => ({
    ok: false,
    sent: true,
    ...(Number.isInteger(status) ? { status } : {}),
    outcomeUnknown: true,
    ...extra,
    verification: { schema: "morrow.browser-verification.v1", status: "unconfirmed", reason: error },
    error,
  });
  const id = (value) => (Number.isSafeInteger(value) && value > 0 ? String(value) : ID.test(String(value ?? "")) ? String(value) : "");
  const sectionNumber = (value) => (Number.isSafeInteger(value) && value >= 0 ? String(value) : "");
  const collapsed = (value, maximum = MAX_NAME_LENGTH) => {
    const text = String(value ?? "").replace(/\s+/g, " ").trim();
    return text && text.length <= maximum && !/[\u0000-\u001f\u007f]/.test(text) ? text : "";
  };
  // The course-state projection and digest of moodle_get_contents, kept
  // identical so one reviewed digest covers the read and the create here.
  const transientField = (name) => /(?:sesskey|statekey|_qf__|csrf|token|secret|password|authorization|cookie|(?:^|[\[_-])(?:draft|itemid)(?:$|[\]_-]))/i.test(name);
  const redact = (value) => value.replace(/([?&](?:sesskey|token|csrf|password|secret)=)[^&#\s]+/gi, "$1[redacted]");
  const sanitize = (value, depth = 0) => {
    if (depth > 24) return null;
    if (Array.isArray(value)) return value.slice(0, MAX_ITEMS).map((entry) => sanitize(entry, depth + 1));
    if (!object(value)) return typeof value === "string" ? redact(value.slice(0, MAX_RESPONSE_BYTES)) : value;
    const output = {};
    for (const [key, child] of Object.entries(value)) {
      if (transientField(key)) continue;
      output[key] = sanitize(child, depth + 1);
    }
    return output;
  };
  const contentData = (value) => ({
    course: sanitize(value.course),
    sections: value.section.map((entry) => sanitize(entry)).slice(0, MAX_ITEMS),
    activities: value.cm.map((entry) => sanitize(entry)).slice(0, MAX_ITEMS),
  });
  const stable = (value) => {
    if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
    if (object(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
    return JSON.stringify(value === undefined ? null : value);
  };
  const digest = async (value) => {
    if (!globalThis.crypto?.subtle || typeof globalThis.TextEncoder !== "function") throw new Error("moodle_subsection_digest_unavailable");
    const bytes = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(stable(value)));
    return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
  };
  const currentContext = () => {
    const cfg = globalThis.M?.cfg;
    if (!object(cfg) || typeof cfg.wwwroot !== "string" || typeof cfg.sesskey !== "string" || !collapsed(cfg.sesskey, 1_024)) return null;
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
  const boundContext = (context) => Boolean(context) && object(input?.binding) && input.binding.origin === context.origin
    && input.binding.siteUrl === context.siteUrl && id(input.binding.principalId) === context.principalId
    && id(input.binding.courseId) === context.anchorCourseId;
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
    return received.origin === expected.origin && received.pathname === expected.pathname && received.search === expected.search
      && !received.hash && !received.username && !received.password;
  };
  const live = () => Number.isSafeInteger(input.expiresAt) && Date.now() < input.expiresAt;
  const boundedText = async (response, endpoint, context) => {
    const declared = response?.headers?.get?.("content-length");
    if (declared !== null && (!/^(?:0|[1-9][0-9]*)$/.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) return null;
    if (!response?.ok || !sameRoute(response.url, endpoint) || !sameContext(context, currentContext())
      || !response.body || typeof response.body.getReader !== "function" || typeof globalThis.TextDecoder !== "function") return null;
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
          return null;
        }
        result += decoder.decode(next.value, { stream: true });
      }
      return result + decoder.decode();
    } catch {
      try { await reader.cancel(); } catch {}
      return null;
    }
  };

  const dispatched = { sent: false };
  const ajax = async (context, methodName, methodArgs) => {
    if (!live()) return { error: "moodle_execution_expired" };
    const endpoint = urlFor(context, AJAX_PATH, { sesskey: context.sesskey, info: methodName });
    let response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        credentials: "include",
        cache: "no-store",
        redirect: "error",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify([{ index: 0, methodname: methodName, args: methodArgs }]),
      });
    } catch { return { error: "moodle_subsection_state_unavailable" }; }
    const raw = await boundedText(response, endpoint, context);
    let payload;
    try { payload = typeof raw === "string" ? JSON.parse(raw) : null; } catch { payload = null; }
    const entry = Array.isArray(payload) && payload.length === 1 && object(payload[0]) ? payload[0] : null;
    if (!entry || entry.error !== undefined || entry.exception !== undefined) {
      return { error: "moodle_subsection_state_unavailable", status: response.status };
    }
    return { data: entry.data, status: response.status };
  };

  /**
   * The complete course state, in the shape and digest of moodle_get_contents.
   */
  const readState = async (context, courseId) => {
    const response = await ajax(context, STATE_METHOD, { courseid: Number(courseId) });
    if (response.error) return { error: response.error, status: response.status };
    let value;
    try { value = typeof response.data === "string" ? JSON.parse(response.data) : null; } catch { value = null; }
    if (!object(value) || !object(value.course) || id(value.course.id) !== courseId
      || !Array.isArray(value.section) || !Array.isArray(value.cm)) return { error: "moodle_subsection_state_invalid", status: response.status };
    // A course beyond the projection bound would be compared against a
    // shortened copy of itself, so it is refused instead.
    if (value.section.length > MAX_ITEMS || value.cm.length > MAX_ITEMS) return { error: "moodle_subsection_course_too_large", status: response.status };
    const state = sanitize(value);
    const data = contentData(state);
    return { state, data, status: response.status, snapshotDigest: await digest(data) };
  };

  const memberList = (section) => {
    if (!Array.isArray(section?.cmlist) || section.cmlist.some((entry) => !id(entry)) || new Set(section.cmlist.map(id)).size !== section.cmlist.length) return null;
    return section.cmlist;
  };
  const membershipMatches = (state, section) => {
    const list = memberList(section);
    if (!list) return false;
    const sectionId = id(section.id);
    const direct = state.cm.filter((entry) => id(entry?.sectionid) === sectionId).map((entry) => id(entry?.id));
    return direct.length === list.length && direct.every((cmId) => cmId && list.some((listed) => id(listed) === cmId));
  };

  /**
   * The complete subsection pairing of one course state. See fact 1 above.
   * The state's own `itemid` never crosses the bridge, so the pairing is read
   * from the section each activity names and the parent each section reports.
   */
  const delegatedMembership = (state) => {
    const sections = Array.isArray(state?.section) ? state.section : [];
    const activities = Array.isArray(state?.cm) ? state.cm : [];
    const bySection = new Map();
    const byCm = new Map();
    for (const section of sections) {
      const sectionId = id(section?.id);
      if (!sectionId) return null;
      if (section.component === null || section.component === "") continue;
      if (section.component !== COMPONENT) return null;
      const owners = activities.filter((entry) => entry?.hasdelegatedsection === true && id(entry?.delegatesectionid) === sectionId);
      if (owners.length !== 1 || owners[0].module !== MODULE) return null;
      const parentId = id(section.parentsectionid);
      const parents = sections.filter((entry) => id(entry?.id) === parentId);
      if (!parentId || parentId !== id(owners[0].sectionid) || parents.length !== 1
        || (parents[0].component !== null && parents[0].component !== "")) return null;
      if (!membershipMatches(state, section)) return null;
      const list = memberList(section) || [];
      const held = list.map((cmId) => activities.find((entry) => id(entry?.id) === id(cmId))).filter(Boolean);
      if (held.length !== list.length) return null;
      const record = { section, activity: owners[0], parent: parents[0], children: held };
      bySection.set(sectionId, record);
      byCm.set(id(owners[0].id), record);
    }
    for (const entry of activities) {
      if (entry?.hasdelegatedsection === true && !byCm.has(id(entry?.id))) return null;
    }
    return { bySection, byCm };
  };

  /**
   * The course shape this create is allowed to add to: every section numbered
   * without a duplicate, the state's own section list in section-number order,
   * the course's last section number equal to the highest one, and every
   * section's activity list exactly the activities that name it. Anything else
   * is a course whose new-section placement Morrow cannot state.
   */
  const courseShape = (state) => {
    const sections = Array.isArray(state?.section) ? state.section : [];
    const activities = Array.isArray(state?.cm) ? state.cm : [];
    if (!sections.length) return null;
    const numbers = new Set();
    for (const entry of sections) {
      const number = sectionNumber(entry?.number);
      if (!id(entry?.id) || number === "" || numbers.has(number) || !membershipMatches(state, entry)) return null;
      numbers.add(number);
    }
    const activityIds = activities.map((entry) => id(entry?.id));
    if (activityIds.some((value) => !value) || new Set(activityIds).size !== activityIds.length) return null;
    const order = [...sections].sort((left, right) => Number(left.number) - Number(right.number));
    const last = Number(order[order.length - 1].number);
    if (!Array.isArray(state.course?.sectionlist)) return null;
    const listed = state.course.sectionlist;
    if (listed.length !== order.length || listed.some((value, index) => id(value) !== id(order[index].id))) return null;
    if (sectionNumber(state.course.numsections) !== String(last)) return null;
    return { order, last };
  };

  const readDocument = async (context, endpoint) => {
    if (!live()) return { error: "moodle_execution_expired" };
    let response;
    try {
      response = await fetch(endpoint, { method: "GET", credentials: "include", cache: "no-store", redirect: "error", headers: { Accept: "text/html" } });
    } catch { return { error: "moodle_subsection_form_unavailable" }; }
    const html = await boundedText(response, endpoint, context);
    if (typeof html !== "string" || typeof globalThis.DOMParser !== "function") return { error: "moodle_subsection_form_unavailable", status: response.status };
    try {
      return { status: response.status, document: new DOMParser().parseFromString(html, "text/html") };
    } catch { return { error: "moodle_subsection_form_unavailable", status: response.status }; }
  };
  const entriesFor = (form) => {
    let values;
    try { values = [...new FormData(form).entries()]; } catch { return null; }
    if (values.length > MAX_FORM_ENTRIES) return null;
    let size = 0;
    const collected = [];
    for (const [name, value] of values) {
      if (typeof name !== "string" || name.length < 1 || name.length > 255 || typeof value !== "string" || value.length > MAX_VALUE_BYTES) return null;
      size += name.length + value.length;
      if (size > MAX_FORM_BYTES) return null;
      collected.push([name, value]);
    }
    return collected;
  };
  const one = (entries, name) => {
    const values = entries.filter(([entryName]) => entryName === name).map(([, value]) => value);
    return values.length === 1 ? values[0] : null;
  };

  /**
   * The native creation form for one hidden subsection in one exact section.
   * Every control the form carries goes back to Moodle exactly as it was read,
   * except the name and the visibility this create names.
   */
  const creationForm = async (context, courseId, section) => {
    const endpoint = urlFor(context, MODEDIT_PATH, { add: MODULE, course: courseId, sectionid: id(section.id), return: 0 });
    const page = await readDocument(context, endpoint);
    if (page.error) return page;
    const forms = [...page.document.querySelectorAll("form")].filter((form) => {
      if (String(form.getAttribute("method") || "").toLowerCase() !== "post") return false;
      try {
        const action = new URL(form.getAttribute("action") || endpoint.href, endpoint);
        return action.origin === context.origin && action.pathname === `${context.basePath}${MODEDIT_PATH}`
          && !action.hash && !action.username && !action.password;
      } catch { return false; }
    });
    if (forms.length !== 1) return { error: "moodle_subsection_form_unavailable", status: page.status };
    const entries = entriesFor(forms[0]);
    if (!entries) return { error: "moodle_subsection_form_invalid", status: page.status };
    const visible = one(entries, "visible");
    if (one(entries, "course") !== courseId || one(entries, "add") !== MODULE || one(entries, "modulename") !== MODULE
      || one(entries, "section") !== sectionNumber(section.number) || one(entries, "return") !== "0"
      || one(entries, "name") === null || (visible !== "0" && visible !== "1")
      || one(entries, "sesskey") !== context.sesskey) {
      return { error: "moodle_subsection_form_invalid", status: page.status };
    }
    // No control outside the session field may carry the session key.
    if (entries.some(([name, value]) => !transientField(name) && value === context.sesskey)) {
      return { error: "moodle_subsection_form_invalid", status: page.status };
    }
    const submits = [...forms[0].querySelectorAll('input[type="submit"][name="submitbutton2"]')]
      .filter((element) => !element.disabled && typeof element.value === "string" && element.value.length > 0 && element.value.length <= 500);
    if (submits.length !== 1) return { error: "moodle_subsection_form_invalid", status: page.status };
    // Every control this create does not write, so a control that changed
    // between the review and the send stops the write before it is sent.
    const preserved = entries.filter(([name]) => name !== "name" && name !== "visible" && !transientField(name));
    return { endpoint, entries, submit: submits[0], preserved, status: page.status };
  };
  const dispatch = async (context, endpoint, body) => {
    let response;
    try {
      dispatched.sent = true;
      response = await fetch(endpoint, {
        method: "POST", credentials: "include", cache: "no-store", redirect: "manual",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "text/html" }, body,
      });
    } catch { return { unconfirmed: true }; }
    if (!sameContext(context, currentContext())) return { unconfirmed: true, status: response.status };
    // Chromium reports a manual same-origin POST redirect as opaqueredirect and
    // does not follow it. The complete course-state readback below is the
    // confirmation; Morrow never opens the route Moodle names next.
    if (response.type === "opaqueredirect") return { sent: true };
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      let redirect;
      try { redirect = new URL(response.headers.get("location") || "", endpoint); } catch { redirect = null; }
      if (!redirect || redirect.origin !== context.origin || !redirect.pathname.startsWith(`${context.basePath}/`)) {
        return { unconfirmed: true, status: response.status };
      }
      return { sent: true, status: response.status };
    }
    return { unconfirmed: true, status: response.status };
  };

  const exactKeys = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
  const argumentsFor = (definition, args, binding) => {
    const courseId = id(binding?.courseId);
    if (!courseId) return null;
    if (definition.kind === "create") {
      if (!exactKeys(args, ["course_id", "section_id", "name", "expected_digest"]) || id(args.course_id) !== courseId
        || !DIGEST.test(String(args.expected_digest || ""))) return null;
      const sectionId = id(args.section_id);
      const name = typeof args.name === "string" ? collapsed(args.name) : "";
      if (!sectionId || !name || name !== args.name || NAME_REWRITTEN.test(name)) return null;
      return { courseId, sectionId, name, expectedDigest: args.expected_digest };
    }
    if (!exactKeys(args, ["course_id", "module_id"]) || id(args.course_id) !== courseId) return null;
    const moduleId = id(args.module_id);
    return moduleId ? { courseId, moduleId } : null;
  };

  const sectionName = (section) => collapsed(section?.title || section?.rawtitle) || id(section?.id);
  const activityRows = (children) => children.map((entry, index) => ({
    position: index + 1,
    module_id: Number(id(entry.id)),
    name: collapsed(entry.name) || id(entry.id),
    module: collapsed(entry.module, 64),
    visible: entry.visible === true,
    stealth: entry.stealth === true,
    access_visible: entry.accessvisible === true,
    has_restrictions: entry.hascmrestrictions === true,
  }));
  const subsectionBase = (record, courseId) => ({
    provider: PROVIDER,
    course_id: Number(courseId),
    module_id: Number(id(record.activity.id)),
    name: collapsed(record.activity.name) || id(record.activity.id),
    visible: record.activity.visible === true,
    section: {
      section_id: Number(id(record.section.id)),
      number: Number(record.section.number),
      title: sectionName(record.section),
      stored_name: collapsed(record.section.rawtitle),
      visible: record.section.visible === true,
      has_summary: record.section.hassummary === true,
      has_restrictions: record.section.hasrestrictions === true,
    },
    parent_section: {
      section_id: Number(id(record.parent.id)),
      number: Number(record.parent.number),
      title: sectionName(record.parent),
    },
    activity_count: record.children.length,
  });
  const readProof = {
    method: "native_course_state",
    route: AJAX_PATH,
    state_method: STATE_METHOD,
    // The course state Moodle serves the signed-in browser session. Seeing a
    // hidden subsection needs moodle/course:viewhiddensections at the course
    // context; the state carries only what the signed-in principal may see.
    required_capability: "course access, with moodle/course:viewhiddensections for a hidden subsection",
    opens_activity_view: false,
    learner_identity: "never_returned",
  };

  /**
   * The saved course state must be the planned one. Moodle assigns the new
   * activity's ID, the new section's ID and the shown title of a section, so
   * those are read from the saved state; every other part of the course is
   * required back exactly as the person reviewed it.
   */
  const verifyCreate = (before, after, args, shape) => {
    const afterShape = courseShape(after);
    if (!afterShape) return null;
    const membership = delegatedMembership(after);
    if (!membership) return null;
    const knownSections = new Set(before.section.map((entry) => id(entry.id)));
    const knownActivities = new Set(before.cm.map((entry) => id(entry.id)));
    const addedSections = after.section.filter((entry) => !knownSections.has(id(entry.id)));
    const addedActivities = after.cm.filter((entry) => !knownActivities.has(id(entry.id)));
    if (addedSections.length !== 1 || addedActivities.length !== 1) return null;
    const section = addedSections[0];
    const activity = addedActivities[0];
    const sectionId = id(section.id);
    const activityId = id(activity.id);
    const record = membership.bySection.get(sectionId);
    if (!sectionId || !activityId || !record || id(record.activity.id) !== activityId) return null;
    if (activity.module !== MODULE || id(activity.sectionid) !== args.sectionId
      || sectionNumber(activity.sectionnumber) !== sectionNumber(record.parent.number)
      || collapsed(activity.name) !== args.name || activity.visible !== false || activity.stealth !== false
      || activity.hasdelegatedsection !== true || activity.accessvisible !== false || activity.hascmrestrictions !== false) return null;
    if (section.component !== COMPONENT || id(section.parentsectionid) !== args.sectionId
      || Number(section.number) !== shape.last + 1 || section.visible !== false || section.hasrestrictions !== false
      || collapsed(section.rawtitle) !== args.name || memberList(section)?.length !== 0) return null;
    // Every part of the course the create did not add must be the reviewed one.
    const parentBefore = before.section.find((entry) => id(entry.id) === args.sectionId);
    const parentAfter = after.section.find((entry) => id(entry.id) === args.sectionId);
    const parentList = memberList(parentAfter);
    if (!parentBefore || !parentList) return null;
    const reduced = {
      ...after,
      course: { ...after.course, sectionlist: [], numsections: before.course.numsections },
      section: after.section.filter((entry) => id(entry.id) !== sectionId)
        .map((entry) => (id(entry.id) === args.sectionId ? { ...entry, cmlist: parentList.slice(0, -1) } : entry)),
      cm: after.cm.filter((entry) => id(entry.id) !== activityId),
    };
    const listedAfter = after.course.sectionlist;
    if (listedAfter.length !== before.course.sectionlist.length + 1 || id(listedAfter[listedAfter.length - 1]) !== sectionId) return null;
    reduced.course.sectionlist = listedAfter.slice(0, -1);
    if (Number(after.course.numsections) !== Number(before.course.numsections) + 1) return null;
    // Moodle appends a new activity to the end of the section it is added to.
    if (id(parentList[parentList.length - 1]) !== activityId) return null;
    const sortById = (entries) => [...entries].sort((left, right) => Number(id(left.id)) - Number(id(right.id)));
    const canonical = (value) => ({ course: value.course, section: sortById(value.section), cm: sortById(value.cm) });
    if (stable(canonical(reduced)) !== stable(canonical(before))) return null;
    return {
      module_id: Number(activityId),
      section_id: Number(sectionId),
      name: collapsed(activity.name),
      number: Number(section.number),
    };
  };

  try {
    const context = currentContext();
    if (input?.mode !== "execute" || !context) return failure("moodle_session_unavailable");
    if (!live()) return failure("moodle_execution_expired");
    const definition = object(input.operation) && typeof input.operation.key === "string" ? definitions[input.operation.key] : null;
    if (!definition || input.operation.provider !== PROVIDER || input.operation.toolName !== definition.toolName
      || input.operation.readOnly !== definition.readOnly) return failure("moodle_operation_refused");
    if (!boundContext(context)) return failure("moodle_binding_mismatch");
    if (input.privateAttachment !== undefined || input.privateConversation !== undefined) return failure("moodle_subsection_arguments_invalid");
    const args = argumentsFor(definition, input.arguments, input.binding);
    if (!args) return failure("moodle_subsection_arguments_invalid");

    const before = await readState(context, args.courseId);
    if (before.error) return failure(before.error, before.status);
    const membership = delegatedMembership(before.state);
    if (!membership) return failure("moodle_subsection_membership_incomplete", before.status);

    if (definition.kind !== "create") {
      const record = membership.byCm.get(args.moduleId);
      if (!record) return failure("moodle_subsection_target_invalid", before.status);
      const data = definition.kind === "read"
        ? { schema: "morrow.moodle-subsection.v1", ...subsectionBase(record, args.courseId), proof: readProof }
        : {
          schema: "morrow.moodle-subsection-contents.v1",
          ...subsectionBase(record, args.courseId),
          // The stored order of the owned section, as the course state lists it.
          activities: activityRows(record.children),
          proof: readProof,
        };
      return {
        ok: true,
        sent: false,
        complete: true,
        status: before.status,
        data,
        targets: [
          { field: "course_id", label: "Course", name: collapsed(before.state.course.fullname || before.state.course.name) || "Moodle course" },
          { field: "module_id", label: "Subsection", name: data.name },
        ],
        snapshot_digest: await digest(data),
      };
    }

    const shape = courseShape(before.state);
    if (!shape) return failure("moodle_subsection_course_shape_refused", before.status);
    if (before.snapshotDigest !== args.expectedDigest) return failure("moodle_expected_digest_mismatch", before.status);
    const parent = before.state.section.find((entry) => id(entry?.id) === args.sectionId);
    // Moodle does not let a subsection hold a subsection.
    if (!parent || (parent.component !== null && parent.component !== "")) return failure("moodle_subsection_parent_refused", before.status);
    const prepared = await creationForm(context, args.courseId, parent);
    if (prepared.error) return failure(prepared.error, prepared.status);
    const preparedDigest = await digest(prepared.preserved);

    // The complete state and the native form are read once more immediately
    // before the change, and the change is bound to that reading.
    const rechecked = currentContext();
    if (!sameContext(context, rechecked) || !boundContext(rechecked)) return failure("moodle_binding_mismatch");
    const fresh = await readState(rechecked, args.courseId);
    if (fresh.error) return failure(fresh.error, fresh.status);
    if (fresh.snapshotDigest !== args.expectedDigest) return failure("moodle_expected_digest_mismatch", fresh.status);
    const freshShape = courseShape(fresh.state);
    if (!freshShape) return failure("moodle_subsection_course_shape_refused", fresh.status);
    if (!delegatedMembership(fresh.state)) return failure("moodle_subsection_membership_incomplete", fresh.status);
    const freshParent = fresh.state.section.find((entry) => id(entry?.id) === args.sectionId);
    if (!freshParent || (freshParent.component !== null && freshParent.component !== "")) return failure("moodle_subsection_parent_refused", fresh.status);
    const confirmed = await creationForm(rechecked, args.courseId, freshParent);
    if (confirmed.error) return failure(confirmed.error, confirmed.status);
    if (await digest(confirmed.preserved) !== preparedDigest) return failure("moodle_subsection_form_changed", confirmed.status);
    if (!sameContext(rechecked, currentContext())) return failure("moodle_binding_mismatch");

    const body = new URLSearchParams();
    for (const [name, value] of confirmed.entries) {
      if (UNSENT_CONTROLS.has(name)) continue;
      body.append(name, name === "name" ? args.name : name === "visible" ? "0" : value);
    }
    body.append(confirmed.submit.name, confirmed.submit.value);
    const posted = await dispatch(rechecked, confirmed.endpoint, body);
    if (posted.unconfirmed) return unconfirmedWrite("moodle_subsection_write_unconfirmed", posted.status);

    const after = await readState(rechecked, args.courseId);
    if (after.error) return unconfirmedWrite("moodle_subsection_readback_unconfirmed", posted.status);
    const saved = verifyCreate(fresh.state, after.state, args, freshShape);
    const result = {
      status: after.status,
      data: after.data,
      targets: [
        { field: "course_id", label: "Course", name: collapsed(after.state.course.fullname || after.state.course.name) || "Moodle course" },
        { field: "section_id", label: "Section", name: sectionName(freshParent) },
        ...(saved ? [{ field: "module_id", label: "Subsection", name: saved.name }] : []),
      ],
      snapshot_digest: after.snapshotDigest,
      proof: {
        method: "native_module_creation_form",
        route: MODEDIT_PATH,
        module: MODULE,
        required_capability: "moodle/course:manageactivities with mod/subsection:addinstance",
        creates_delegated_section: true,
        created_hidden: true,
        // Moodle puts the section it creates at the end of the course's section
        // numbers, so nothing already in the course changes place.
        sections_renumbered: 0,
        learners_notified: false,
      },
    };
    if (!saved) return unconfirmedWrite("moodle_subsection_write_not_verified", posted.status, result);
    return {
      ok: true,
      sent: true,
      ...result,
      subsection: saved,
      verification: { schema: "morrow.browser-verification.v1", status: "verified" },
    };
  } catch (error) {
    if (dispatched.sent) return unconfirmedWrite("moodle_subsection_write_unconfirmed");
    const message = String(error?.message || error);
    return failure(message.startsWith("moodle_") ? message : "moodle_subsection_execution_failed");
  }
}
