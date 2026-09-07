/**
 * The lifecycle of one activity inside one approved Moodle course: copy it,
 * remove it, or put it at an exact place in a section.
 *
 * All three use the same native course-format action endpoint the course page's
 * own editing controls use, `core_courseformat_update_course`, through
 * `/lib/ajax/service.php`, with the actions `cm_duplicate`, `cm_delete` and
 * `cm_move`. Each action requires `moodle/course:manageactivities` at the
 * course context, and duplication also requires the import backup and restore
 * capabilities, because Moodle copies an activity by running a single-activity
 * backup and restoring it into the same course.
 * https://github.com/moodle/moodle/blob/v5.2.2/public/course/format/classes/stateactions.php
 * https://github.com/moodle/moodle/blob/v5.2.2/public/course/format/classes/local/cmactions.php
 *
 * Four facts shape these operations, and each one is stated in the catalog text
 * and in the result.
 *
 * 1. Exact placement. `cm_move` takes a target section and, optionally, a
 *    target activity. Moodle inserts the moved activity immediately before that
 *    target activity, and at the end of the section when there is none. Morrow
 *    turns the requested position into that exact target activity from the
 *    complete section membership it has just read, so a position is a place in
 *    a list Morrow has seen, not an offset it hopes Moodle shares.
 * 2. Removal cannot be undone by Morrow. Moodle takes the activity out of the
 *    course at once and removes its records and files with a background task.
 *    Morrow has no route that brings any of it back, so the removal states
 *    exactly what goes with it before it is approved, and refuses an activity
 *    whose records Morrow cannot name.
 * 3. Duplication copies content and files, and the copy is a learner-visible
 *    activity whenever the original is one. Moodle's activity copy carries no
 *    learner submissions, attempts, responses or grades, because it runs the
 *    single-activity backup with user data switched off.
 * 4. An activity that delegates a section, and a section Moodle itself owns,
 *    are refused. Their contents are a subtree that this executor does not
 *    read, so it cannot state the complete result of changing one.
 *
 * Every operation reads the complete course state, requires the digest of the
 * state the person reviewed, reads the course format and the state once more
 * immediately before it acts, sends exactly one native action, then requires
 * the complete course state back with exactly the approved change in it. A lost
 * response or a state that is not the approved one is `applied_or_unknown`; it
 * is never retried.
 *
 * The returned course state, and the digest over it, are built exactly as
 * `moodle_get_contents` builds them, so the digest a person reviewed and the
 * digest this executor compares are the same value. That is also why the proof
 * block sits beside the data instead of inside it.
 *
 * Chrome serializes this function for a MAIN-world injection. Keep every
 * dependency inside the function body.
 */
export async function executeMoodleActivityLifecycleInPage(rawInput) {
  const PROVIDER = "moodle";
  const AJAX_PATH = "/lib/ajax/service.php";
  const COURSE_FORM_PATH = "/course/edit.php";
  const STATE_METHOD = "core_courseformat_get_state";
  const UPDATE_METHOD = "core_courseformat_update_course";
  const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
  const MAX_ITEMS = 10_000;
  const MAX_POSITION = 10_000;
  const MAX_NAME_LENGTH = 1_333;
  // The move contract of this course connection covers the two built-in course
  // formats whose section order is the course order.
  const SUPPORTED_FORMATS = ["topics", "weeks"];
  const ID = /^[1-9][0-9]*$/;
  const DIGEST = /^[a-f0-9]{64}$/;
  const definitions = Object.freeze({
    "moodle.ajax.core_courseformat_update_course.cm_duplicate.v1": { toolName: "moodle_duplicate_activity", readOnly: false, kind: "duplicate", action: "cm_duplicate" },
    "moodle.ajax.core_courseformat_update_course.cm_delete.v1": { toolName: "moodle_delete_activity", readOnly: false, kind: "delete", action: "cm_delete" },
    "moodle.ajax.core_courseformat_update_course.cm_move_to_position.v1": { toolName: "moodle_move_activity_to_position", readOnly: false, kind: "move", action: "cm_move" },
  });
  // What Moodle removes with any activity, whatever its type. `course_delete_module`
  // calls the module's own delete, then removes the activity's context with every
  // file in it, its grade item and grades, its completion records, its calendar
  // events, its tags, comments and ratings, and the course-module record itself.
  // https://github.com/moodle/moodle/blob/v5.2.2/public/course/lib.php
  const COURSE_REMOVALS = Object.freeze([
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
  // every module a site installs itself.
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
  const DUPLICATE_COPIES = Object.freeze([
    "The activity's settings and content",
    "Every file the activity stores, in every one of its file areas",
    "Its access restrictions and completion settings",
  ]);
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
    if (!globalThis.crypto?.subtle || typeof globalThis.TextEncoder !== "function") throw new Error("moodle_activity_lifecycle_digest_unavailable");
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
    } catch { return { error: "moodle_activity_lifecycle_course_format_unverified" }; }
    const html = await boundedText(response, endpoint, context);
    if (typeof html !== "string" || typeof globalThis.DOMParser !== "function") return { error: "moodle_activity_lifecycle_course_format_unverified", status: response.status };
    let parsed;
    try { parsed = new DOMParser().parseFromString(html, "text/html"); } catch { return { error: "moodle_activity_lifecycle_course_format_unverified", status: response.status }; }
    const forms = [...parsed.querySelectorAll("form")].filter((form) => {
      let action;
      try { action = new URL(form.getAttribute("action") || "", endpoint); } catch { return false; }
      return action.origin === context.origin && action.pathname === `${context.basePath}${COURSE_FORM_PATH}`;
    });
    if (forms.length !== 1) return { error: "moodle_activity_lifecycle_course_format_unverified", status: response.status };
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
    if (id(control("id")) !== courseId) return { error: "moodle_activity_lifecycle_course_format_unverified", status: response.status };
    const format = control("format");
    if (!SUPPORTED_FORMATS.includes(format)) return { error: "moodle_activity_lifecycle_course_format_unverified", status: response.status };
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
    } catch { return write ? { unconfirmed: "moodle_activity_lifecycle_write_unconfirmed" } : { error: "moodle_activity_lifecycle_state_unavailable" }; }
    const raw = await boundedText(response, endpoint, context);
    let payload;
    try { payload = typeof raw === "string" ? JSON.parse(raw) : null; } catch { payload = null; }
    const entry = Array.isArray(payload) && payload.length === 1 && object(payload[0]) ? payload[0] : null;
    if (!entry || entry.error !== undefined || entry.exception !== undefined) {
      return write
        ? { unconfirmed: "moodle_activity_lifecycle_write_unconfirmed", status: response.status }
        : { error: "moodle_activity_lifecycle_state_unavailable", status: response.status };
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
      || !Array.isArray(value.section) || !Array.isArray(value.cm)) return { error: "moodle_activity_lifecycle_state_invalid", status: response.status };
    // A course beyond the projection bound would be compared against a
    // shortened copy of itself, so it is refused instead.
    if (value.section.length > MAX_ITEMS || value.cm.length > MAX_ITEMS) return { error: "moodle_activity_lifecycle_course_too_large", status: response.status };
    const state = sanitize(value);
    const data = contentData(state);
    return { state, data, status: response.status, snapshotDigest: await digest(data) };
  };

  const oneEntry = (entries, targetId) => {
    const matches = Array.isArray(entries) ? entries.filter((entry) => id(entry?.id) === targetId) : [];
    return matches.length === 1 ? matches[0] : null;
  };
  const ordinarySection = (entry) => Boolean(entry) && (entry.component === null || entry.component === "") && sectionNumber(entry.number) !== "";
  const openSection = (entry) => ordinarySection(entry) && entry.visible === true && entry.hasrestrictions === false;
  const memberList = (section) => {
    if (!Array.isArray(section?.cmlist) || section.cmlist.some((entry) => !id(entry)) || new Set(section.cmlist.map(id)).size !== section.cmlist.length) return null;
    return section.cmlist;
  };
  // The section's own membership list must be exactly the activities that name
  // it, so a placement is computed from a list Morrow has read in full.
  const membershipComplete = (state, section) => {
    const list = memberList(section);
    if (!list) return false;
    const sectionId = id(section.id);
    const direct = state.cm.filter((entry) => id(entry?.sectionid) === sectionId).map((entry) => id(entry?.id));
    return direct.length === list.length && direct.every((cmId) => cmId && list.some((listed) => id(listed) === cmId));
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
    if (!unique(copy.cm) || !unique(copy.section)) return null;
    copy.cm.sort((left, right) => Number(id(left.id)) - Number(id(right.id)));
    copy.section.sort((left, right) => Number(id(left.id)) - Number(id(right.id)));
    return copy;
  };

  const exactKeys = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
  const argumentsFor = (definition, args, binding) => {
    const courseId = id(binding?.courseId);
    if (!courseId) return null;
    const fields = definition.kind === "move"
      ? ["course_id", "module_id", "target_section_id", "position", "expected_digest"]
      : ["course_id", "module_id", "expected_digest"];
    if (!exactKeys(args, fields) || id(args.course_id) !== courseId || !id(args.module_id) || !DIGEST.test(String(args.expected_digest || ""))) return null;
    const base = { courseId, moduleId: id(args.module_id), expectedDigest: args.expected_digest };
    if (definition.kind !== "move") return base;
    const targetSectionId = id(args.target_section_id);
    const position = Number.isSafeInteger(args.position) && args.position >= 1 && args.position <= MAX_POSITION ? args.position : 0;
    return targetSectionId && position ? { ...base, targetSectionId, position } : null;
  };

  /**
   * The exact change, bound to the state that was just read: the activity, its
   * section, the native target this action needs, and the complete course state
   * the change must produce.
   */
  const plan = (definition, state, args) => {
    const activity = oneEntry(state.cm, args.moduleId);
    const source = activity ? oneEntry(state.section, id(activity.sectionid)) : null;
    if (!activity || !source) return { error: "moodle_activity_lifecycle_precondition_refused" };
    const module = collapsed(activity.module, 64);
    // An activity that delegates a section carries a subtree this executor does
    // not read, and a section Moodle owns is part of one.
    if (activity.hasdelegatedsection !== false || module === "subsection"
      || (source.component !== "" && source.component !== null)) return { error: "moodle_activity_lifecycle_delegated_refused" };
    if (!ordinarySection(source) || !membershipComplete(state, source)) return { error: "moodle_activity_lifecycle_precondition_refused" };
    const sourceList = memberList(source);
    const member = sourceList.filter((entry) => id(entry) === args.moduleId);
    if (!module || member.length !== 1) return { error: "moodle_activity_lifecycle_precondition_refused" };
    const expected = JSON.parse(JSON.stringify(state));
    const expectedActivity = oneEntry(expected.cm, args.moduleId);
    const expectedSource = oneEntry(expected.section, id(source.id));
    if (!expectedActivity || !expectedSource) return { error: "moodle_activity_lifecycle_precondition_refused" };
    const targets = [
      { field: "module_id", label: "Activity", name: collapsed(activity.name) || args.moduleId },
    ];

    if (definition.kind === "delete") {
      // Removing a Question bank activity removes its categories and every
      // question in them, which reaches Quizzes outside this course.
      if (module === "qbank") return { error: "moodle_delete_activity_question_bank_refused" };
      if (!Object.hasOwn(MODULE_REMOVALS, module)) return { error: "moodle_delete_activity_records_not_enumerated" };
      expected.cm = expected.cm.filter((entry) => id(entry?.id) !== args.moduleId);
      expectedSource.cmlist = expectedSource.cmlist.filter((entry) => id(entry) !== args.moduleId);
      return {
        activity,
        source,
        expected,
        targets: [...targets, { field: "section_id", label: "Section", name: collapsed(source.title || source.rawtitle) || id(source.id) }],
        removes: [...COURSE_REMOVALS, ...MODULE_REMOVALS[module]],
        request: { action: definition.action, courseid: Number(args.courseId), ids: [Number(args.moduleId)], targetsectionid: null, targetcmid: null },
      };
    }

    // A copy and a placement both put an activity at a known place in a
    // section, so both need a section whose order is learner-visible and a
    // placed activity Moodle is not treating as an exception.
    if (!openSection(source) || activity.visible !== true || activity.stealth !== false
      || activity.hascmrestrictions !== false || activity.uservisible !== true || activity.accessvisible !== true) {
      return { error: "moodle_activity_lifecycle_precondition_refused" };
    }

    if (definition.kind === "duplicate") {
      return {
        activity,
        source,
        expected,
        targets: [...targets, { field: "section_id", label: "Section", name: collapsed(source.title || source.rawtitle) || id(source.id) }],
        copies: DUPLICATE_COPIES,
        request: { action: definition.action, courseid: Number(args.courseId), ids: [Number(args.moduleId)], targetsectionid: null, targetcmid: null },
      };
    }

    const destination = oneEntry(state.section, args.targetSectionId);
    if (!destination || !openSection(destination) || !membershipComplete(state, destination)) return { error: "moodle_activity_lifecycle_precondition_refused" };
    const destinationList = memberList(destination);
    const remaining = destinationList.filter((entry) => id(entry) !== args.moduleId);
    const index = args.position - 1;
    if (index > remaining.length) return { error: "moodle_activity_position_out_of_range" };
    const placed = [...remaining.slice(0, index), member[0], ...remaining.slice(index)];
    if (id(destination.id) === id(source.id) && stable(placed) === stable(destinationList)) return { error: "moodle_activity_position_unchanged" };
    const expectedDestination = oneEntry(expected.section, args.targetSectionId);
    if (!expectedDestination) return { error: "moodle_activity_lifecycle_precondition_refused" };
    expectedSource.cmlist = expectedSource.cmlist.filter((entry) => id(entry) !== args.moduleId);
    expectedDestination.cmlist = placed;
    expectedActivity.sectionid = destination.id;
    if (Object.hasOwn(expectedActivity, "sectionnumber")) expectedActivity.sectionnumber = destination.number;
    return {
      activity,
      source,
      destination,
      expected,
      targets: [...targets, { field: "target_section_id", label: "Destination section", name: collapsed(destination.title || destination.rawtitle) || id(destination.id) }],
      request: {
        action: definition.action,
        courseid: Number(args.courseId),
        ids: [Number(args.moduleId)],
        targetsectionid: Number(args.targetSectionId),
        // Moodle puts the moved activity immediately before this one, and at
        // the end of the section when there is none.
        targetcmid: index < remaining.length ? Number(id(remaining[index])) : null,
      },
    };
  };

  /**
   * The saved course state must be the planned one. A copy is the one case
   * where a field cannot be planned: Moodle assigns the new activity's ID, and
   * it names the copy in the site language. Those two are read from the saved
   * state, the copy's type, section, visibility, and access fields must match
   * the original, the copy must sit immediately after the original, and the
   * rest of the course state must be unchanged. Fields that Moodle derives
   * from the new ID, such as its address, are not compared.
   */
  const verify = (definition, planned, after) => {
    const expected = canonical(planned.expected);
    const actual = canonical(after);
    if (!expected || !actual) return null;
    if (definition.kind !== "duplicate") return stable(expected) === stable(actual) ? { copy: null } : null;
    const known = new Set(expected.cm.map((entry) => id(entry.id)));
    const added = actual.cm.filter((entry) => !known.has(id(entry.id)));
    if (added.length !== 1) return null;
    const copy = added[0];
    const copyId = id(copy.id);
    const original = expected.cm.find((entry) => id(entry.id) === id(planned.activity.id));
    const carried = ["module", "sectionid", "sectionnumber", "visible", "stealth", "hasdelegatedsection", "hascmrestrictions", "uservisible", "accessvisible"];
    if (!copyId || !original || !collapsed(copy.name) || carried.some((field) => stable(copy[field]) !== stable(original[field]))) return null;
    const source = expected.section.find((entry) => id(entry.id) === id(planned.source.id));
    const savedSource = actual.section.find((entry) => id(entry.id) === id(planned.source.id));
    const list = memberList(savedSource);
    if (!source || !list) return null;
    // The copy sits immediately after the original, and nothing else in the
    // section moved.
    const withoutCopy = list.filter((entry) => id(entry) !== copyId);
    const at = withoutCopy.findIndex((entry) => id(entry) === id(planned.activity.id));
    if (at < 0 || stable(withoutCopy) !== stable(source.cmlist) || id(list[at + 1]) !== copyId) return null;
    const reduced = { ...actual, cm: actual.cm.filter((entry) => id(entry.id) !== copyId), section: actual.section.map((entry) => (id(entry.id) === id(source.id) ? { ...entry, cmlist: withoutCopy } : entry)) };
    return stable(expected) === stable(reduced) ? { copy: { module_id: Number(copyId), name: collapsed(copy.name) } } : null;
  };

  const proofFor = (definition, planned) => ({
    method: "native_course_state_action",
    action: definition.action,
    route: AJAX_PATH,
    required_capability: definition.kind === "duplicate"
      ? "moodle/course:manageactivities with moodle/backup:backuptargetimport and moodle/restore:restoretargetimport"
      : "moodle/course:manageactivities",
    scope: "one_activity_in_the_approved_course",
    reversible_by_morrow: false,
    ...(definition.kind === "delete" ? { removes: planned.removes, learner_records_removed: true } : {}),
    ...(definition.kind === "duplicate" ? { copies: planned.copies, learner_work_copied: false } : {}),
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
    if (!args) return failure("moodle_activity_lifecycle_arguments_invalid");

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
    if (freshFormat.format !== format.format) return failure("moodle_activity_lifecycle_course_format_changed", freshFormat.status);
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
    if (after.error) return unconfirmedWrite("moodle_activity_lifecycle_readback_unconfirmed", update.status);
    const afterFormat = await courseFormat(rechecked, args.courseId);
    if (afterFormat.error || afterFormat.format !== format.format) return unconfirmedWrite("moodle_activity_lifecycle_readback_unconfirmed", update.status);
    const saved = verify(definition, confirmed, after.state);
    const result = {
      status: after.status,
      data: after.data,
      targets: [
        { field: "course_id", label: "Course", name: collapsed(after.state.course.fullname || after.state.course.name) || "Moodle course" },
        ...confirmed.targets,
      ],
      snapshot_digest: after.snapshotDigest,
      proof: proofFor(definition, confirmed),
    };
    if (!saved) return unconfirmedWrite("moodle_activity_lifecycle_write_not_verified", update.status, result);
    return {
      ok: true,
      sent: true,
      ...result,
      ...(saved.copy ? { copy: saved.copy } : {}),
      verification: { schema: "morrow.browser-verification.v1", status: "verified" },
    };
  } catch (error) {
    if (dispatched.sent) return unconfirmedWrite("moodle_activity_lifecycle_write_unconfirmed");
    const message = String(error?.message || error);
    return failure(message.startsWith("moodle_") ? message : "moodle_activity_lifecycle_execution_failed");
  }
}
