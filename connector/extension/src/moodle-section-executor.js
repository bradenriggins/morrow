/**
 * The lifecycle of the sections of one approved Moodle course: add a section,
 * remove one, or move one to an exact place in the course order.
 *
 * All three use the same native course-format action endpoint the course page's
 * own editing controls use, `core_courseformat_update_course`, through
 * `/lib/ajax/service.php`, with the actions `section_add`, `section_delete` and
 * `section_move_after`.
 * https://github.com/moodle/moodle/blob/v5.2.2/public/course/format/classes/stateactions.php
 *
 * Five facts shape these operations, and each one is stated in the catalog text
 * and in the result.
 *
 * 1. A new section goes at the end. `section_add` without a target section
 *    appends one, because `course_create_section` treats position 0 as the end
 *    of the course, so nothing already in the course changes place. To put the
 *    new section somewhere else, move it as a separate approved change.
 *    It requires `moodle/course:update` at the course context.
 * 2. Removing a section removes every activity in it. `section_delete` sends a
 *    removal for each activity of the section and then deletes the section with
 *    the force flag, so a section that is not empty is deleted with its
 *    contents, and Moodle removes the records and files with a background task.
 *    Morrow has no route that brings any of it back, so the removal names every
 *    activity it takes, refuses a section holding a module type whose removed
 *    records Morrow cannot name, and refuses the General section, which Moodle
 *    does not delete. It requires `moodle/course:update` and
 *    `moodle/course:movesections`.
 * 3. Moving a section renumbers the sections between its old and its new place.
 *    `section_move_after` puts the section immediately after a target section.
 *    Morrow turns the requested position into that exact target section from
 *    the complete course order it has just read, so a position is a place in a
 *    list Morrow has seen. It requires `moodle/course:movesections`.
 * 4. Moodle builds three things from a section's place: the shown title of a
 *    section that has no name of its own, the current-section flag, and the
 *    link to the section. It names the highlighted section the same way. For a
 *    section whose place changes, those are the only fields Morrow does not
 *    require back unchanged. Every stored section name, summary flag,
 *    visibility, restriction flag and activity list, and every activity in the
 *    course, must come back exactly as planned.
 * 5. A course that holds a section Moodle itself owns, or an activity that
 *    delegates one, is refused. Their contents are a subtree that this executor
 *    does not read, so it cannot state the complete result of renumbering them.
 *
 * Every operation reads the complete course state, requires the digest of the
 * state the person reviewed, reads the course format and the state once more
 * immediately before it acts, sends exactly one native action, then requires
 * the complete course state back with exactly the approved change in it and the
 * course format unchanged. A lost response or a state that is not the approved
 * one is `applied_or_unknown`; it is never retried.
 *
 * The returned course state, and the digest over it, are built exactly as
 * `moodle_get_contents` builds them, so the digest a person reviewed and the
 * digest this executor compares are the same value. That is also why the proof
 * block sits beside the data instead of inside it.
 *
 * Chrome serializes this function for a MAIN-world injection. Keep every
 * dependency inside the function body.
 */
export async function executeMoodleSectionInPage(rawInput) {
  const PROVIDER = "moodle";
  const AJAX_PATH = "/lib/ajax/service.php";
  const COURSE_FORM_PATH = "/course/edit.php";
  const STATE_METHOD = "core_courseformat_get_state";
  const UPDATE_METHOD = "core_courseformat_update_course";
  const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
  const MAX_ITEMS = 10_000;
  const MAX_POSITION = 10_000;
  const MAX_NAME_LENGTH = 1_333;
  // The section order of this course connection is the course order in the two
  // built-in course formats, and in no other, so this matches the move contract.
  const SUPPORTED_FORMATS = ["topics", "weeks"];
  const ID = /^[1-9][0-9]*$/;
  const DIGEST = /^[a-f0-9]{64}$/;
  // The value that stands in for a field Moodle builds from a section's place.
  const DERIVED = "morrow.derived_from_section_place";
  const definitions = Object.freeze({
    "moodle.ajax.core_courseformat_update_course.section_add.v1": { toolName: "moodle_create_section", readOnly: false, kind: "create", action: "section_add" },
    "moodle.ajax.core_courseformat_update_course.section_delete.v1": { toolName: "moodle_delete_section", readOnly: false, kind: "delete", action: "section_delete" },
    "moodle.ajax.core_courseformat_update_course.section_move_after.v1": { toolName: "moodle_move_section", readOnly: false, kind: "move", action: "section_move_after" },
  });
  // What Moodle removes with the section itself.
  // https://github.com/moodle/moodle/blob/v5.2.2/public/course/lib.php
  const SECTION_REMOVALS = Object.freeze([
    "The section, its name and its summary, with every file stored in that summary",
    "Its access restrictions",
    "Its place in the course. Every later section moves up by one",
  ]);
  // What Moodle removes with any activity in the section, whatever its type.
  const ACTIVITY_REMOVALS = Object.freeze([
    "The activity and its place in the section",
    "Every file the activity stores, in every one of its file areas",
    "Its grade item, and every grade and feedback stored in that item",
    "Its completion records for every learner",
    "Its calendar events",
    "Its tags, comments and ratings",
    "Its role assignments and permission overrides",
  ]);
  // What each core module removes with itself, named in the words an instructor
  // reads on the activity. A module that is not in this table is refused,
  // because Morrow cannot state what the removal takes with it. That includes
  // every activity module a site installs itself.
  const MODULE_REMOVALS = Object.freeze({
    assign: ["Every learner submission and every submitted file", "Every grade, feedback comment and feedback file", "Extensions, marking workflow states and marking allocations", "User and group overrides"],
    bigbluebuttonbn: ["The room and its meeting log records", "Its recording records in Moodle. Whether the recordings themselves are removed is decided by the BigBlueButton server, not by Moodle"],
    book: ["Every chapter and subchapter, and the files in them"],
    choice: ["Every learner response"],
    data: ["Every entry, with its field content, files, comments and ratings", "The fields, templates and presets of the database"],
    feedback: ["Every question item", "Every completed response and the values in it"],
    folder: ["Every file in the folder"],
    forum: ["Every discussion, post and attachment", "Subscriptions, read tracking and post ratings"],
    glossary: ["Every entry, alias, attachment, comment and rating", "The entry categories of the glossary"],
    h5pactivity: ["The H5P package file the activity stores", "Every learner attempt and the results in it"],
    imscp: ["The package file and the content extracted from it"],
    label: [],
    lesson: ["Every page, answer and branch", "Every learner attempt, answer, grade and timer", "User overrides"],
    lti: ["The tool link settings of this activity", "The grades the external tool sent back. Content the external tool holds is not removed by this deletion"],
    page: [],
    quiz: ["Every learner attempt and the responses in it", "Quiz grades and the grade history", "User and group overrides", "The Quiz's own question slots. The questions themselves stay in their Question bank"],
    resource: ["The file the Resource holds"],
    scorm: ["The package file and its SCO records", "Every learner attempt and tracking record", "User overrides"],
    url: [],
    wiki: ["Every subwiki, page and page version", "Page locks, links, synonyms and votes"],
    workshop: ["Every submission and its files", "Every assessment, grade and allocation"],
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
  // identical so one reviewed digest covers the read and every write here.
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
    if (!globalThis.crypto?.subtle || typeof globalThis.TextEncoder !== "function") throw new Error("moodle_section_digest_unavailable");
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

  /**
   * The course format, read from the native course settings form. The section
   * order these operations change is the course order only in the two built-in
   * formats, so the format is proved before the change and again after it.
   */
  const courseFormat = async (context, courseId) => {
    if (!live()) return { error: "moodle_execution_expired" };
    const endpoint = urlFor(context, COURSE_FORM_PATH, { id: courseId });
    let response;
    try {
      response = await fetch(endpoint, { method: "GET", credentials: "include", cache: "no-store", redirect: "error", headers: { Accept: "text/html" } });
    } catch { return { error: "moodle_section_course_format_unverified" }; }
    const html = await boundedText(response, endpoint, context);
    if (typeof html !== "string" || typeof globalThis.DOMParser !== "function") return { error: "moodle_section_course_format_unverified", status: response.status };
    let parsed;
    try { parsed = new DOMParser().parseFromString(html, "text/html"); } catch { return { error: "moodle_section_course_format_unverified", status: response.status }; }
    const forms = [...parsed.querySelectorAll("form")].filter((form) => {
      let action;
      try { action = new URL(form.getAttribute("action") || "", endpoint); } catch { return false; }
      return action.origin === context.origin && action.pathname === `${context.basePath}${COURSE_FORM_PATH}`;
    });
    if (forms.length !== 1) return { error: "moodle_section_course_format_unverified", status: response.status };
    const control = (name) => {
      const nodes = [...forms[0].querySelectorAll(`[name="${name}"]`)];
      if (nodes.length !== 1) return "";
      const node = nodes[0];
      if (String(node.tagName || "").toUpperCase() === "SELECT") {
        const selected = [...(node.options || [])].filter((option) => option.selected);
        return selected.length === 1 ? String(selected[0].value ?? "") : "";
      }
      return String(node.value ?? node.getAttribute("value") ?? "");
    };
    // The form must name the approved course, so a redirected or substituted
    // settings page cannot answer for a different one.
    if (id(control("id")) !== courseId) return { error: "moodle_section_course_format_unverified", status: response.status };
    const format = control("format");
    if (!SUPPORTED_FORMATS.includes(format)) return { error: "moodle_section_course_format_unverified", status: response.status };
    return { format, status: response.status };
  };

  const dispatched = { sent: false };
  const ajax = async (context, methodName, args, write) => {
    if (!live()) return { error: "moodle_execution_expired" };
    const endpoint = urlFor(context, AJAX_PATH, { sesskey: context.sesskey, info: methodName });
    let response;
    try {
      if (write) dispatched.sent = true;
      response = await fetch(endpoint, {
        method: "POST",
        credentials: "include",
        cache: "no-store",
        redirect: "error",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify([{ index: 0, methodname: methodName, args }]),
      });
    } catch { return write ? { unconfirmed: "moodle_section_write_unconfirmed" } : { error: "moodle_section_state_unavailable" }; }
    const raw = await boundedText(response, endpoint, context);
    let payload;
    try { payload = typeof raw === "string" ? JSON.parse(raw) : null; } catch { payload = null; }
    const entry = Array.isArray(payload) && payload.length === 1 && object(payload[0]) ? payload[0] : null;
    if (!entry || entry.error !== undefined || entry.exception !== undefined) {
      return write
        ? { unconfirmed: "moodle_section_write_unconfirmed", status: response.status }
        : { error: "moodle_section_state_unavailable", status: response.status };
    }
    return { data: entry.data, status: response.status };
  };

  /**
   * The complete course state, in the shape and digest of moodle_get_contents.
   */
  const readState = async (context, courseId) => {
    const response = await ajax(context, STATE_METHOD, { courseid: Number(courseId) }, false);
    if (response.error) return { error: response.error, status: response.status };
    let value;
    try { value = typeof response.data === "string" ? JSON.parse(response.data) : null; } catch { value = null; }
    if (!object(value) || !object(value.course) || id(value.course.id) !== courseId
      || !Array.isArray(value.section) || !Array.isArray(value.cm)) return { error: "moodle_section_state_invalid", status: response.status };
    // A course beyond the projection bound would be compared against a
    // shortened copy of itself, so it is refused instead.
    if (value.section.length > MAX_ITEMS || value.cm.length > MAX_ITEMS) return { error: "moodle_section_course_too_large", status: response.status };
    const state = sanitize(value);
    const data = contentData(state);
    return { state, data, status: response.status, snapshotDigest: await digest(data) };
  };

  const memberList = (section) => {
    if (!Array.isArray(section?.cmlist) || section.cmlist.some((entry) => !id(entry)) || new Set(section.cmlist.map(id)).size !== section.cmlist.length) return null;
    return section.cmlist;
  };

  /**
   * The course order this executor is allowed to change: ordinary sections
   * only, numbered without a gap from the General section, in exactly the order
   * the state's own section list gives, with every activity naming the section
   * that lists it. Anything else is a course whose renumbering Morrow cannot
   * state, so it is refused before anything is sent.
   */
  const courseShape = (state) => {
    const refused = { error: "moodle_section_precondition_refused" };
    // A section Moodle itself owns, and an activity that delegates one, carry a
    // subtree this executor does not read.
    const delegated = { error: "moodle_section_delegated_refused" };
    const sections = Array.isArray(state?.section) ? state.section : [];
    if (sections.length < 1) return refused;
    const byId = new Map();
    for (const entry of sections) {
      const sectionId = id(entry?.id);
      if (!sectionId || sectionNumber(entry?.number) === "" || byId.has(sectionId)) return refused;
      if (entry.component !== "" && entry.component !== null) return delegated;
      if (!memberList(entry)) return refused;
      byId.set(sectionId, entry);
    }
    const order = [...sections].sort((left, right) => Number(left.number) - Number(right.number));
    if (order.some((entry, index) => Number(entry.number) !== index)) return refused;
    if (Array.isArray(state.course?.sectionlist)) {
      const listed = state.course.sectionlist;
      if (listed.length !== order.length || listed.some((value, index) => id(value) !== id(order[index].id))) return refused;
    }
    if (Object.hasOwn(state.course || {}, "numsections") && sectionNumber(state.course.numsections) !== String(order.length - 1)) return refused;
    const activities = Array.isArray(state.cm) ? state.cm : [];
    const activityIds = activities.map((entry) => id(entry?.id));
    if (activityIds.some((value) => !value) || new Set(activityIds).size !== activityIds.length) return refused;
    if (activities.some((activity) => activity.hasdelegatedsection !== false)) return delegated;
    for (const entry of order) {
      const sectionId = id(entry.id);
      const direct = activities.filter((activity) => id(activity?.sectionid) === sectionId);
      const list = memberList(entry);
      if (direct.length !== list.length || !direct.every((activity) => list.some((listed) => id(listed) === id(activity.id)))) return refused;
      // A stale section number cannot be planned forward.
      if (direct.some((activity) => Object.hasOwn(activity, "sectionnumber") && sectionNumber(activity.sectionnumber) !== String(entry.number))) return refused;
    }
    return { order, byId };
  };

  const canonical = (value) => {
    const copy = JSON.parse(JSON.stringify(value));
    const unique = (entries) => {
      const seen = new Set();
      for (const entry of entries) {
        const entryId = id(entry?.id);
        if (!entryId || seen.has(entryId)) return false;
        seen.add(entryId);
      }
      return true;
    };
    if (!Array.isArray(copy.cm) || !Array.isArray(copy.section) || !unique(copy.cm) || !unique(copy.section)) return null;
    copy.cm.sort((left, right) => Number(id(left.id)) - Number(id(right.id)));
    copy.section.sort((left, right) => Number(id(left.id)) - Number(id(right.id)));
    return copy;
  };

  /**
   * The same course state with the fields Moodle builds from a section's place
   * standing in for themselves, for the sections whose place the change moves.
   * Both sides of the comparison are masked by the same rule, taken from the
   * state the person reviewed.
   */
  const masked = (state, moved, derivedTitle) => {
    const copy = canonical(state);
    if (!copy) return null;
    for (const entry of copy.section) {
      if (!moved.has(id(entry.id))) continue;
      for (const field of ["current", "sectionurl"]) if (Object.hasOwn(entry, field)) entry[field] = DERIVED;
      if (derivedTitle.has(id(entry.id)) && Object.hasOwn(entry, "title")) entry.title = DERIVED;
    }
    if (moved.size && object(copy.course) && Object.hasOwn(copy.course, "highlighted")) copy.course.highlighted = DERIVED;
    return copy;
  };

  const exactKeys = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
  const argumentsFor = (definition, args, binding) => {
    const courseId = id(binding?.courseId);
    if (!courseId) return null;
    const fields = definition.kind === "create"
      ? ["course_id", "expected_digest"]
      : definition.kind === "move"
        ? ["course_id", "section_id", "position", "expected_digest"]
        : ["course_id", "section_id", "expected_digest"];
    if (!exactKeys(args, fields) || id(args.course_id) !== courseId || !DIGEST.test(String(args.expected_digest || ""))) return null;
    const base = { courseId, expectedDigest: args.expected_digest };
    if (definition.kind === "create") return base;
    const sectionId = id(args.section_id);
    if (!sectionId) return null;
    if (definition.kind === "delete") return { ...base, sectionId };
    const position = Number.isSafeInteger(args.position) && args.position >= 1 && args.position <= MAX_POSITION ? args.position : 0;
    return position ? { ...base, sectionId, position } : null;
  };

  const sectionName = (section) => collapsed(section?.title || section?.rawtitle) || id(section?.id);

  /**
   * The exact change, bound to the state that was just read: the section, the
   * native target this action needs, the complete course state the change must
   * produce, and the sections whose place it moves.
   */
  const plan = (definition, state, args) => {
    const shape = courseShape(state);
    if (shape.error) return { error: shape.error };
    const { order } = shape;
    const expected = JSON.parse(JSON.stringify(state));
    const request = { action: definition.action, courseid: Number(args.courseId), ids: [], targetsectionid: null, targetcmid: null };
    const empty = { moved: new Set(), derivedTitle: new Set() };

    if (definition.kind === "create") {
      if (order.length >= MAX_ITEMS) return { error: "moodle_section_precondition_refused" };
      return { ...empty, expected, addedNumber: order.length, targets: [], request };
    }

    const section = shape.byId.get(args.sectionId);
    if (!section) return { error: "moodle_section_precondition_refused" };
    // Moodle does not delete or move the General section.
    if (Number(section.number) === 0) return { error: "moodle_section_general_refused" };
    const remaining = order.filter((entry) => id(entry.id) !== args.sectionId);
    let newOrder;
    let removed = [];
    let targets = [{ field: "section_id", label: "Section", name: sectionName(section) }];

    if (definition.kind === "delete") {
      const members = state.cm.filter((entry) => id(entry.sectionid) === args.sectionId);
      for (const activity of members) {
        const module = collapsed(activity.module, 64);
        // Removing a Question bank activity removes its categories and every
        // question in them, which reaches Quizzes outside this course.
        if (module === "qbank") return { error: "moodle_delete_section_question_bank_refused" };
        if (!module || !Object.hasOwn(MODULE_REMOVALS, module)) return { error: "moodle_delete_section_records_not_enumerated" };
        removed.push({ module_id: Number(id(activity.id)), name: collapsed(activity.name) || id(activity.id), module, removes: MODULE_REMOVALS[module] });
      }
      newOrder = remaining;
      expected.section = expected.section.filter((entry) => id(entry.id) !== args.sectionId);
      expected.cm = expected.cm.filter((entry) => id(entry.sectionid) !== args.sectionId);
      request.ids = [Number(args.sectionId)];
    } else {
      if (args.position > remaining.length) return { error: "moodle_section_position_out_of_range" };
      const target = remaining[args.position - 1];
      newOrder = [...remaining.slice(0, args.position), section, ...remaining.slice(args.position)];
      if (stable(newOrder.map((entry) => id(entry.id))) === stable(order.map((entry) => id(entry.id)))) return { error: "moodle_section_position_unchanged" };
      request.ids = [Number(args.sectionId)];
      // Moodle puts the moved section immediately after this one.
      request.targetsectionid = Number(id(target.id));
      targets = [...targets, { field: "position", label: "After section", name: sectionName(target) }];
    }

    const numbers = new Map(newOrder.map((entry, index) => [id(entry.id), index]));
    const moved = new Set([...numbers].filter(([sectionId, number]) => Number(shape.byId.get(sectionId).number) !== number).map(([sectionId]) => sectionId));
    const derivedTitle = new Set([...moved].filter((sectionId) => !collapsed(shape.byId.get(sectionId).rawtitle)));
    for (const entry of expected.section) entry.number = numbers.get(id(entry.id));
    for (const entry of expected.cm) {
      if (Object.hasOwn(entry, "sectionnumber")) entry.sectionnumber = numbers.get(id(entry.sectionid));
    }
    if (Array.isArray(expected.course?.sectionlist)) {
      const listed = new Map(state.course.sectionlist.map((value) => [id(value), value]));
      expected.course.sectionlist = newOrder.map((entry) => listed.get(id(entry.id)));
    }
    if (Object.hasOwn(expected.course || {}, "numsections")) expected.course.numsections = newOrder.length - 1;
    return { moved, derivedTitle, expected, section, removed, targets, request };
  };

  /**
   * The saved course state must be the planned one. A new section is the one
   * case where a field cannot be planned: Moodle assigns its ID and builds its
   * shown title, so those are read from the saved state, the new section must
   * be an empty visible section at the end of the course, and every other part
   * of the course must be exactly the state the person reviewed.
   */
  const verify = (definition, planned, before, after) => {
    if (courseShape(after).error) return null;
    if (definition.kind !== "create") {
      const expected = masked(planned.expected, planned.moved, planned.derivedTitle);
      const actual = masked(after, planned.moved, planned.derivedTitle);
      return expected && actual && stable(expected) === stable(actual) ? { section: null } : null;
    }
    const known = new Set(before.section.map((entry) => id(entry.id)));
    const added = after.section.filter((entry) => !known.has(id(entry.id)));
    if (added.length !== 1) return null;
    const created = added[0];
    const createdId = id(created.id);
    if (!createdId || Number(created.number) !== planned.addedNumber || created.visible !== true
      || created.hasrestrictions !== false || memberList(created)?.length !== 0) return null;
    const reduced = { ...after, section: after.section.filter((entry) => id(entry.id) !== createdId), course: { ...after.course } };
    if (Array.isArray(before.course?.sectionlist)) {
      const listed = Array.isArray(after.course?.sectionlist) ? after.course.sectionlist : [];
      if (listed.length !== before.course.sectionlist.length + 1 || id(listed[listed.length - 1]) !== createdId) return null;
      reduced.course.sectionlist = listed.slice(0, -1);
    }
    if (Object.hasOwn(before.course || {}, "numsections")) {
      if (Number(after.course?.numsections) !== Number(before.course.numsections) + 1) return null;
      reduced.course.numsections = before.course.numsections;
    }
    const expected = canonical(before);
    const actual = canonical(reduced);
    if (!expected || !actual || stable(expected) !== stable(actual)) return null;
    return { section: { section_id: Number(createdId), name: sectionName(created), number: Number(created.number) } };
  };

  const proofFor = (definition, planned) => ({
    method: "native_course_state_action",
    action: definition.action,
    route: AJAX_PATH,
    required_capability: definition.kind === "create"
      ? "moodle/course:update"
      : definition.kind === "delete"
        ? "moodle/course:update with moodle/course:movesections"
        : "moodle/course:movesections",
    scope: "one_section_in_the_approved_course",
    reversible_by_morrow: false,
    ...(definition.kind === "delete"
      ? {
        removes: SECTION_REMOVALS,
        activity_removals: ACTIVITY_REMOVALS,
        activities_removed: planned.removed,
        learner_records_removed: planned.removed.length > 0,
      }
      : {}),
    ...(definition.kind === "create" ? {} : { sections_renumbered: planned.moved.size }),
  });

  try {
    const context = currentContext();
    if (input?.mode !== "execute" || !context) return failure("moodle_session_unavailable");
    if (!live()) return failure("moodle_execution_expired");
    const definition = object(input.operation) && typeof input.operation.key === "string" ? definitions[input.operation.key] : null;
    if (!definition || input.operation.provider !== PROVIDER || input.operation.toolName !== definition.toolName
      || input.operation.readOnly !== definition.readOnly) return failure("moodle_operation_refused");
    if (!boundContext(context)) return failure("moodle_binding_mismatch");
    const args = argumentsFor(definition, input.arguments, input.binding);
    if (!args) return failure("moodle_section_arguments_invalid");

    const format = await courseFormat(context, args.courseId);
    if (format.error) return failure(format.error, format.status);
    const before = await readState(context, args.courseId);
    if (before.error) return failure(before.error, before.status);
    if (before.snapshotDigest !== args.expectedDigest) return failure("moodle_expected_digest_mismatch", before.status);
    const planned = plan(definition, before.state, args);
    if (planned.error) return failure(planned.error, before.status);

    // The course format and the complete state are read once more immediately
    // before the change, and the change is bound to that reading.
    const rechecked = currentContext();
    if (!sameContext(context, rechecked) || !boundContext(rechecked)) return failure("moodle_binding_mismatch");
    const freshFormat = await courseFormat(rechecked, args.courseId);
    if (freshFormat.error) return failure(freshFormat.error, freshFormat.status);
    if (freshFormat.format !== format.format) return failure("moodle_section_course_format_changed", freshFormat.status);
    const fresh = await readState(rechecked, args.courseId);
    if (fresh.error) return failure(fresh.error, fresh.status);
    if (fresh.snapshotDigest !== args.expectedDigest) return failure("moodle_expected_digest_mismatch", fresh.status);
    const confirmed = plan(definition, fresh.state, args);
    if (confirmed.error) return failure(confirmed.error, fresh.status);
    if (!sameContext(rechecked, currentContext())) return failure("moodle_binding_mismatch");

    const update = await ajax(rechecked, UPDATE_METHOD, confirmed.request, true);
    if (update.error) return failure(update.error, update.status);
    if (update.unconfirmed) return unconfirmedWrite(update.unconfirmed, update.status);

    const after = await readState(rechecked, args.courseId);
    if (after.error) return unconfirmedWrite("moodle_section_readback_unconfirmed", update.status);
    const afterFormat = await courseFormat(rechecked, args.courseId);
    if (afterFormat.error || afterFormat.format !== format.format) return unconfirmedWrite("moodle_section_readback_unconfirmed", update.status);
    const saved = verify(definition, confirmed, fresh.state, after.state);
    const result = {
      status: after.status,
      data: after.data,
      targets: [
        { field: "course_id", label: "Course", name: collapsed(after.state.course.fullname || after.state.course.name) || "Moodle course" },
        ...confirmed.targets,
        ...(saved?.section ? [{ field: "section_id", label: "New section", name: saved.section.name }] : []),
      ],
      snapshot_digest: after.snapshotDigest,
      proof: proofFor(definition, confirmed),
    };
    if (!saved) return unconfirmedWrite("moodle_section_write_not_verified", update.status, result);
    return {
      ok: true,
      sent: true,
      ...result,
      ...(saved.section ? { section: saved.section } : {}),
      verification: { schema: "morrow.browser-verification.v1", status: "verified" },
    };
  } catch (error) {
    if (dispatched.sent) return unconfirmedWrite("moodle_section_write_unconfirmed");
    const message = String(error?.message || error);
    return failure(message.startsWith("moodle_") ? message : "moodle_section_execution_failed");
  }
}
