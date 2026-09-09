/**
 * The Moodle BigBlueButton route (`mod_bigbluebuttonbn`): read one activity,
 * read the creation form, create one hidden room, and update a room that is
 * provably closed. Creation and updates use the same bounded schedule and
 * room-setting contract.
 *
 * Morrow performs no BigBlueButton server action. It never joins, starts or
 * ends a meeting, never asks for a recording, and never sends a request to any
 * BigBlueButton server. It uses exactly two native Moodle routes:
 * `/lib/ajax/service.php` for the course state and `/course/modedit.php` for
 * the native activity form and its one save. It never opens
 * `/mod/bigbluebuttonbn/view.php`, `/mod/bigbluebuttonbn/bbb_view.php`, a
 * recording page, or the module's own `meeting_info` and `get_recordings`
 * services, and the save is sent with `redirect: "manual"` so Moodle's own
 * redirect target is never fetched.
 *
 * One thing is outside Morrow's control and is stated in every result. Moodle's
 * own settings page contacts the configured BigBlueButton server when it
 * renders: `mod_form.php` calls `bigbluebutton_proxy::get_server_version()` in
 * `definition()` and throws `general_error_unable_connect` when that fails. So
 * asking Moodle for this form makes Moodle's server talk to BigBlueButton.
 * Morrow's browser does not, and Morrow cannot stop Moodle's page from doing
 * it. `proof.bigbluebutton_server_request` is `none_from_morrow` and
 * `proof.moodle_contacts_bigbluebutton_to_render_form` is `true`.
 *
 * Four boundaries are specific to this module.
 *
 * 1. Whether a meeting is running is not on this form and is not anywhere else
 *    the browser can read: the live state lives on the BigBlueButton server,
 *    and the only Moodle route that reports it (`mod_bigbluebuttonbn_meeting_info`)
 *    asks that server. This route never asks. So Morrow uses the strongest
 *    signal the form itself carries: Moodle's own `instance::is_currently_open()`
 *    rule over the `openingtime` and `closingtime` controls. It fails closed:
 *    a create whose approved schedule would leave the room open at the site's
 *    own current time is refused before anything is sent, and a saved activity
 *    whose form gives no readable site clock reports `room_open_now: null`
 *    rather than guessing. `live_session_state` is always `not_read`.
 * 2. The guest join URL (`guestjoinurl`) and the guest password
 *    (`guestpassword`) stay in Chrome. Neither is returned, neither is accepted
 *    as an argument, and neither enters a digest preimage: the value map records
 *    only whether each one is set. A creation form that already allows guest
 *    access is refused, because a guest link is a door into the room for anyone
 *    who holds it and Morrow cannot see who does.
 * 3. The participant role mapping (`participants`) can name one person by user
 *    ID. It is never returned and never placed in a digest preimage as itself:
 *    the value map carries its own SHA-256 instead, so a changed mapping still
 *    invalidates the reviewed digest without the mapping crossing the bridge.
 *    A creation form whose mapping already names a single user is refused.
 * 4. Recording controls (`record`, `recordallfromstart`, `recordhidebutton`) and
 *    the participant mapping are read and reported, and are then sent back
 *    exactly as the reloaded form held them. This route changes none of them.
 *
 * Native source:
 * https://github.com/moodle/moodle/blob/v5.2.2/public/mod/bigbluebuttonbn/mod_form.php#L53-L115
 * (the form definition and its server version call), #L370-L468 (the room
 * block), #L600-L626 (the pre-uploaded presentation area), #L634-L664 (the
 * participant mapping), #L675-L700 (guest access), #L709-L720 (the schedule),
 * https://github.com/moodle/moodle/blob/v5.2.2/public/mod/bigbluebuttonbn/lib.php#L88-L120
 * (`bigbluebuttonbn_add_instance`),
 * https://github.com/moodle/moodle/blob/v5.2.2/public/mod/bigbluebuttonbn/classes/instance.php
 * (`is_currently_open`).
 *
 * Chrome serializes this function for a MAIN-world injection. Keep every
 * dependency inside the function body.
 */
export async function executeMoodleBigBlueButtonInPage(rawInput) {
  const PROVIDER = "moodle";
  const SCHEMA = "morrow.moodle-bigbluebuttonbn-activity.v1";
  const MODULE = "bigbluebuttonbn";
  const STATE_METHOD = "core_courseformat_get_state";
  const MODEDIT_PATH = "/course/modedit.php";
  const COURSE_VIEW_PATH = "/course/view.php";
  const AJAX_PATH = "/lib/ajax/service.php";
  const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
  const MAX_FORM_ENTRIES = 800;
  const MAX_FORM_BYTES = 512 * 1024;
  const MAX_VALUE_BYTES = 64 * 1024;
  const MAX_ACTIVITIES = 10_000;
  // mod_bigbluebuttonbn declares the name control as maxlength="64".
  const MAX_NAME_LENGTH = 64;
  const ID = /^[1-9][0-9]{0,18}$/;
  const COUNT = /^(?:0|[1-9][0-9]{0,8})$/;
  const DIGEST = /^[a-f0-9]{64}$/;
  const DATE_PART = /^(?:0|[1-9][0-9]{0,3})$/;
  const DATE_KEYS = ["year", "month", "day", "hour", "minute"];
  // The two guest-access credentials. Neither is returned and neither is read.
  const SECRET_FIELD = /^(?:guestjoinurl|guestpassword)$/;
  // The participant role mapping. It can name one person, so it is reduced to
  // its own hash before anything is digested and is never returned.
  const PARTICIPANT_FIELD = "participants";
  const TRANSIENT_FIELD = /(?:sesskey|statekey|_qf__|csrf|token|secret|password|authorization|cookie|(?:^|[\[_-])(?:draft|itemid)(?:$|[\]_-]))/i;
  const DRAFT_ITEM_FIELD = /\[itemid\]$/;
  // The module's own file areas: the introduction editor and the one
  // pre-uploaded presentation. The presentation control carries a draft item ID.
  const ALLOWED_DRAFT_FIELD = "introeditor[itemid]";
  const PRESENTATION_FIELD = "presentation";
  // Sending this control makes Moodle notify every enrolled learner.
  const NOTIFICATION_FIELD = "coursecontentnotification";
  const WAIT_FIELD = "wait";
  const OPENING_FIELD = "openingtime";
  const CLOSING_FIELD = "closingtime";
  const GUEST_ALLOWED_FIELD = "guestallowed";
  const ROOM_FLAGS = Object.freeze({
    wait_for_moderator: WAIT_FIELD,
    mute_on_start: "muteonstart",
  });
  const RECORDING_FLAGS = Object.freeze({
    enabled: "record",
    all_from_start: "recordallfromstart",
    hide_button: "recordhidebutton",
  });
  const LOCK_FLAGS = Object.freeze({
    disable_camera: "disablecam",
    disable_microphone: "disablemic",
    disable_private_chat: "disableprivatechat",
    disable_public_chat: "disablepublicchat",
    disable_note: "disablenote",
    hide_user_list: "hideuserlist",
  });
  const definitions = Object.freeze({
    "moodle.form.course.modedit.bigbluebuttonbn.read.v1": { toolName: "moodle_get_bigbluebuttonbn", readOnly: true, kind: "activity" },
    "moodle.form.course.modedit.bigbluebuttonbn.create.read.v1": { toolName: "moodle_get_bigbluebuttonbn_creation_form", readOnly: true, kind: "creation-form" },
    "moodle.form.course.modedit.bigbluebuttonbn.create.write.v1": { toolName: "moodle_create_bigbluebuttonbn", readOnly: false, kind: "create" },
    "moodle.form.course.modedit.bigbluebuttonbn.write.v1": { toolName: "moodle_update_bigbluebuttonbn", readOnly: false, kind: "update" },
  });

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
  // known: nothing was saved.
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
    if (!globalThis.crypto?.subtle || typeof globalThis.TextEncoder !== "function") throw new Error("moodle_bigbluebuttonbn_digest_unavailable");
    const bytes = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(stable(value)));
    return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
  };
  // Moodle's calendar month lengths, so a day the form could never hold is
  // refused before it becomes a schedule.
  const monthLength = (year, month) => {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  };
  const civil = (parts) => {
    if (!object(parts) || DATE_KEYS.some((key) => !Number.isInteger(parts[key]))) return null;
    if (Object.keys(parts).some((key) => !DATE_KEYS.includes(key))) return null;
    const { year, month, day, hour, minute } = parts;
    if (year < 1970 || year > 2100 || month < 1 || month > 12) return null;
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
    if (day < 1 || day > monthLength(year, month)) return null;
    return { year, month, day, hour, minute };
  };
  const compareCivil = (left, right) => {
    for (const key of DATE_KEYS) {
      if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
    }
    return 0;
  };
  const sameCivil = (left, right) => (left === null && right === null)
    || (object(left) && object(right) && compareCivil(left, right) === 0);
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
    const creating = definition.kind !== "activity" && definition.kind !== "update";
    const targetKey = creating ? "section_id" : "module_id";
    const required = definition.kind === "create"
      ? ["course_id", targetKey, "name", "opening_time", "expected_digest"]
      : definition.kind === "update"
        ? ["course_id", targetKey, "expected_digest"]
        : ["course_id", targetKey];
    const optional = definition.kind === "create"
      ? ["closing_time", "wait_for_moderator"]
      : definition.kind === "update"
        ? ["name", "opening_time", "closing_time", "wait_for_moderator"]
        : [];
    if (!exactKeys(args, required, optional) || id(args.course_id) !== courseId || !id(args[targetKey])) return null;
    const target = { courseId, targetId: id(args[targetKey]) };
    if (definition.kind !== "create" && definition.kind !== "update") return target;
    if (!DIGEST.test(String(args.expected_digest || ""))) return null;
    if (definition.kind === "update") {
      const settings = {};
      if (Object.hasOwn(args, "name")) {
        if (!validText(args.name, MAX_NAME_LENGTH) || collapsed(args.name, MAX_NAME_LENGTH) !== args.name) return null;
        settings.name = args.name;
      }
      if (Object.hasOwn(args, "opening_time")) {
        const openingTime = civil(args.opening_time);
        if (!openingTime) return null;
        let closingTime;
        if (Object.hasOwn(args, "closing_time")) {
          if (args.closing_time === null) {
            closingTime = null;
          } else {
            closingTime = civil(args.closing_time);
            if (!closingTime || compareCivil(closingTime, openingTime) <= 0) return null;
          }
          settings.closingTime = closingTime;
        }
        settings.openingTime = openingTime;
      } else if (Object.hasOwn(args, "closing_time")) {
        return null;
      }
      if (Object.hasOwn(args, "wait_for_moderator")) {
        if (typeof args.wait_for_moderator !== "boolean") return null;
        settings.waitForModerator = args.wait_for_moderator;
      }
      if (Object.keys(settings).length === 0) return null;
      return { ...target, expectedDigest: args.expected_digest, settings };
    }
    // A name Moodle would collapse could never equal the name it saves.
    if (!validText(args.name, MAX_NAME_LENGTH) || collapsed(args.name, MAX_NAME_LENGTH) !== args.name) return null;
    const openingTime = civil(args.opening_time);
    if (!openingTime) return null;
    let closingTime = null;
    if (Object.hasOwn(args, "closing_time")) {
      closingTime = civil(args.closing_time);
      // Moodle's own validation refuses a closing time at or before the opening time.
      if (!closingTime || compareCivil(closingTime, openingTime) <= 0) return null;
    }
    const settings = { openingTime, closingTime };
    if (Object.hasOwn(args, "wait_for_moderator")) {
      if (typeof args.wait_for_moderator !== "boolean") return null;
      settings.waitForModerator = args.wait_for_moderator;
    }
    return { ...target, name: args.name, expectedDigest: args.expected_digest, settings };
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
    } catch { return { error: "moodle_bigbluebuttonbn_read_unavailable" }; }
    if (!response.ok || !sameRoute(response.url, endpoint) || !sameContext(context, currentContext())) {
      return { error: "moodle_bigbluebuttonbn_read_unavailable", status: response.status };
    }
    const html = await boundedText(response);
    if (html === null || typeof globalThis.DOMParser !== "function") return { error: "moodle_bigbluebuttonbn_read_unavailable", status: response.status };
    try { return { status: response.status, document: new DOMParser().parseFromString(html, "text/html") }; }
    catch { return { error: "moodle_bigbluebuttonbn_read_unavailable", status: response.status }; }
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
    const result = await ajax(context, STATE_METHOD, { courseid: Number(courseId) }, "moodle_bigbluebuttonbn_course_state_unavailable");
    if (result.error) return result;
    const value = result.data;
    if (!object(value) || !object(value.course) || id(value.course.id) !== courseId
      || !Array.isArray(value.section) || !Array.isArray(value.cm)
      || value.cm.length > MAX_ACTIVITIES || value.section.length > MAX_ACTIVITIES) {
      return { error: "moodle_bigbluebuttonbn_course_state_unavailable", status: result.status };
    }
    return { status: result.status, course: value.course, sections: value.section, activities: value.cm };
  };
  const courseTarget = (state) => ({ field: "course_id", label: "Course", name: collapsed(state.course?.fullname || state.course?.name) || "Moodle course" });
  const sectionOf = (state, sectionId) => {
    const matches = state.sections.filter((entry) => object(entry) && id(entry.id) === sectionId);
    if (matches.length !== 1) return null;
    const number = sectionNumber(matches[0].number);
    return number === "" ? null : { id: sectionId, number, name: collapsed(matches[0].title || matches[0].rawtitle) || "Selected course section" };
  };
  const roomModuleOf = (state, moduleId) => {
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
  const rawMap = (entries) => {
    const values = {};
    for (const [name, value] of entries) {
      if (values[name] === undefined) values[name] = value;
      else if (Array.isArray(values[name])) values[name].push(value);
      else values[name] = [values[name], value];
    }
    return values;
  };
  const one = (values, name) => typeof values[name] === "string" ? values[name] : "";
  const anyValue = (values, name, wanted) => {
    const value = values[name];
    return Array.isArray(value) ? value.includes(wanted) : value === wanted;
  };
  const present = (values, name) => values[name] !== undefined;
  /**
   * The value map the digest is taken over. The two guest credentials are
   * reduced to whether they are set, the participant mapping to its own hash,
   * so neither a credential nor a user ID ever enters a digest preimage or a
   * result. Transient controls are dropped because they change on every load,
   * and so are the parts of a date selector whose enable box is off, because
   * Moodle renders the site's current time there and that changes every minute.
   */
  const valuesFrom = async (entries) => {
    const raw = rawMap(entries);
    const values = {};
    for (const [name, value] of entries) {
      if (SECRET_FIELD.test(name)) {
        values[name] = value ? "set" : "";
        continue;
      }
      if (name === PARTICIPANT_FIELD) {
        values[name] = `sha256:${await digest(value)}`;
        continue;
      }
      if (TRANSIENT_FIELD.test(name) || name === PRESENTATION_FIELD) continue;
      if (values[name] === undefined) values[name] = value;
      else if (Array.isArray(values[name])) values[name].push(value);
      else values[name] = [values[name], value];
    }
    for (const field of [OPENING_FIELD, CLOSING_FIELD]) {
      if (anyValue(raw, `${field}[enabled]`, "1")) continue;
      values[`${field}[enabled]`] = "0";
      for (const key of DATE_KEYS) delete values[`${field}[${key}]`];
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
  /**
   * The module declares two file areas: the introduction editor and the one
   * pre-uploaded presentation. Any other file control, or any other draft item
   * control, is not the form this route was written against.
   */
  const fileAreaProblem = (form, entries) => {
    if (form.querySelector('input[type="file"]')) return "moodle_bigbluebuttonbn_file_area_unexpected";
    const managers = [...form.querySelectorAll('[data-fieldtype="filemanager"], [data-fieldtype="filepicker"]')];
    const presentation = entries.filter(([name]) => name === PRESENTATION_FIELD);
    // The module declares one optional file area, the pre-uploaded presentation,
    // and its control is the draft item the file manager writes into. A file
    // area without that control, or a second one, is not this form.
    if (managers.length > 1 || managers.length !== presentation.length) return "moodle_bigbluebuttonbn_file_area_unexpected";
    const draftFields = [...new Set(entries.filter(([name]) => DRAFT_ITEM_FIELD.test(name)).map(([name]) => name))];
    if (draftFields.length > 1 || (draftFields.length === 1 && draftFields[0] !== ALLOWED_DRAFT_FIELD)) return "moodle_bigbluebuttonbn_file_area_unexpected";
    return "";
  };
  const namedControls = (form, name) => [...form.querySelectorAll("[name]")].filter((control) => control.getAttribute("name") === name);
  const textWritable = (form, name) => {
    const controls = namedControls(form, name).filter((control) => ["INPUT", "TEXTAREA"].includes(control.tagName));
    return controls.length === 1 && !controls[0].disabled;
  };
  // The site can freeze any room setting, and mod_form then renders it as a
  // hidden control instead of a checkbox. A frozen setting is not writable.
  const checkboxWritable = (form, name) => {
    const controls = namedControls(form, name);
    const boxes = controls.filter((control) => control.tagName === "INPUT" && String(control.getAttribute("type") || "").toLowerCase() === "checkbox");
    return boxes.length === 1 && !boxes[0].disabled && boxes[0].getAttribute("value") === "1";
  };
  // A date_time_selector is an enable box plus its five parts. All six must be
  // there and none of them disabled for a schedule to be writable.
  const dateWritable = (form, name) => {
    const boxes = namedControls(form, `${name}[enabled]`)
      .filter((control) => control.tagName === "INPUT" && String(control.getAttribute("type") || "").toLowerCase() === "checkbox");
    if (boxes.length !== 1 || boxes[0].disabled) return false;
    return DATE_KEYS.every((key) => {
      const parts = namedControls(form, `${name}[${key}]`);
      return parts.length === 1 && !parts[0].disabled;
    });
  };
  // The native control must itself offer the value Morrow sends, so no value
  // reaches Moodle that the form does not already permit.
  const selectAllows = (form, name, value) => {
    const selects = namedControls(form, name).filter((control) => control.tagName === "SELECT");
    if (selects.length !== 1 || selects[0].disabled || selects[0].multiple) return false;
    return [...selects[0].options || []].some((option) => String(option.value || "") === value);
  };
  const selectedOption = (form, name) => {
    const selects = namedControls(form, name).filter((control) => control.tagName === "SELECT");
    if (selects.length !== 1) return null;
    const selected = [...selects[0].options || []].filter((option) => option.selected);
    return selected.length === 1 ? { value: String(selected[0].value || ""), name: collapsed(selected[0].textContent) } : null;
  };
  const offeredValues = (form, name) => {
    const selects = namedControls(form, name).filter((control) => control.tagName === "SELECT");
    return selects.length === 1 ? [...selects[0].options || []].map((option) => String(option.value || "")).filter((value) => COUNT.test(value)).map(Number) : [];
  };
  // A checkbox, an advcheckbox and a frozen hidden control all answer the same
  // question the same way: does this control carry "1".
  const flagValue = (form, raw, name) => (namedControls(form, name).length ? anyValue(raw, name, "1") : null);
  const flagGroup = (form, raw, fields) => Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, flagValue(form, raw, field)]));
  const civilFromRaw = (raw, name) => {
    const parts = {};
    for (const key of DATE_KEYS) {
      const text = one(raw, `${name}[${key}]`);
      if (!DATE_PART.test(text)) return null;
      parts[key] = Number(text);
    }
    return civil(parts);
  };
  const scheduleFrom = (raw, name) => (anyValue(raw, `${name}[enabled]`, "1")
    ? { enabled: true, date: civilFromRaw(raw, name) }
    : { enabled: false, date: null });
  /**
   * Moodle's own room-open rule, `instance::is_currently_open()`: a room is open
   * unless the site's current time is before its opening time or after its
   * closing time. The site's current time is read from whichever schedule
   * selector is switched off, because Moodle renders the current site time in a
   * disabled optional date selector. When both are switched on there is no site
   * clock on the page, and the answer is `null`, not a guess.
   */
  const siteTimeFrom = (raw, opening, closing) => {
    if (!opening.enabled) return civilFromRaw(raw, OPENING_FIELD);
    if (!closing.enabled) return civilFromRaw(raw, CLOSING_FIELD);
    return null;
  };
  const roomOpenNow = (siteTime, opening, closing) => {
    if (!siteTime) return null;
    if (opening.date && compareCivil(siteTime, opening.date) < 0) return false;
    if (closing.date && compareCivil(siteTime, closing.date) > 0) return false;
    return true;
  };
  const participantShape = (raw) => {
    const value = one(raw, PARTICIPANT_FIELD);
    let rules;
    try { rules = JSON.parse(value); } catch { return null; }
    if (!Array.isArray(rules) || rules.length > 1_000 || rules.some((rule) => !object(rule))) return null;
    return {
      count: rules.length,
      names_a_user: rules.some((rule) => String(rule.selectiontype || "") === "user"),
    };
  };
  const endpointForCreationForm = (context, courseId, sectionId) => urlFor(context, MODEDIT_PATH, { add: MODULE, course: courseId, sectionid: sectionId, return: 0 });
  const endpointForActivity = (context, moduleId) => urlFor(context, MODEDIT_PATH, { update: moduleId, return: 0 });
  /**
   * Reads one native modedit form and proves it is the BigBlueButton form for
   * the exact approved target. `identity` names the hidden controls that must be
   * there exactly once with exactly these values.
   */
  const roomFormState = async (documentValue, context, endpoint, identity) => {
    const form = nativeForm(documentValue, endpoint);
    if (!form) return { error: "moodle_bigbluebuttonbn_form_invalid" };
    const entries = entriesFor(form);
    if (!entries) return { error: "moodle_bigbluebuttonbn_form_invalid" };
    const byName = (name) => entries.filter(([entryName]) => entryName === name).map(([, value]) => value);
    const once = (name, expected) => {
      const values = byName(name);
      return values.length === 1 && (expected === undefined || values[0] === expected);
    };
    if (!once("sesskey", context.sesskey)) return { error: "moodle_form_session_mismatch" };
    if (!once("modulename", MODULE)) return { error: "moodle_bigbluebuttonbn_form_invalid" };
    for (const [name, value] of Object.entries(identity)) {
      if (!once(name, value)) return { error: "moodle_bigbluebuttonbn_form_invalid" };
    }
    if (!once("name") || !once("introeditor[text]")) return { error: "moodle_bigbluebuttonbn_form_invalid" };
    if (!once(PARTICIPANT_FIELD)) return { error: "moodle_bigbluebuttonbn_form_invalid" };
    const areaProblem = fileAreaProblem(form, entries);
    if (areaProblem) return { error: areaProblem };
    const submit = saveAndReturnSubmit(form);
    if (!submit) return { error: "moodle_bigbluebuttonbn_form_invalid" };
    const raw = rawMap(entries);
    const participants = participantShape(raw);
    if (!participants) return { error: "moodle_bigbluebuttonbn_form_invalid" };
    const opening = scheduleFrom(raw, OPENING_FIELD);
    const closing = scheduleFrom(raw, CLOSING_FIELD);
    if ((opening.enabled && !opening.date) || (closing.enabled && !closing.date)) return { error: "moodle_bigbluebuttonbn_form_invalid" };
    const siteTime = siteTimeFrom(raw, opening, closing);
    const values = await valuesFrom(entries);
    // A result never carries the session key, whatever the control is called.
    if (Object.values(values).flat().includes(context.sesskey)) return { error: "moodle_bigbluebuttonbn_form_invalid" };
    const instanceType = selectedOption(form, "type");
    return {
      entries,
      values,
      element: form,
      action: new URL(form.getAttribute("action"), endpoint).href,
      nativeSesskey: context.sesskey,
      submit,
      name: collapsed(byName("name")[0], MAX_NAME_LENGTH),
      nameWritable: textWritable(form, "name"),
      hiddenAllowed: once("visible") && selectAllows(form, "visible", "0"),
      introductionEmpty: byName("introeditor[text]")[0].trim() === "",
      instanceType: instanceType && COUNT.test(instanceType.value) ? { value: Number(instanceType.value), name: instanceType.name } : null,
      offeredInstanceTypes: offeredValues(form, "type"),
      room: flagGroup(form, raw, ROOM_FLAGS),
      recording: flagGroup(form, raw, RECORDING_FLAGS),
      lock: flagGroup(form, raw, LOCK_FLAGS),
      guestAllowed: flagValue(form, raw, GUEST_ALLOWED_FIELD),
      guestMustApprove: flagValue(form, raw, "mustapproveuser"),
      guestJoinUrlPresent: one(values, "guestjoinurl") === "set",
      guestPasswordPresent: one(values, "guestpassword") === "set",
      userLimit: COUNT.test(one(raw, "userlimit")) ? Number(one(raw, "userlimit")) : null,
      presentationAreaPresent: present(raw, PRESENTATION_FIELD),
      participants,
      opening,
      closing,
      siteTime,
      roomOpenNow: roomOpenNow(siteTime, opening, closing),
      waitWritable: checkboxWritable(form, WAIT_FIELD),
      scheduleWritable: dateWritable(form, OPENING_FIELD) && dateWritable(form, CLOSING_FIELD),
      // Every control this route preserves. The one it can change on a create is
      // left out, and the two credential controls are named but never valued.
      protectedFields: [...new Set(entries.map(([name]) => name)
        .filter((name) => !TRANSIENT_FIELD.test(name) || SECRET_FIELD.test(name))
        .filter((name) => name !== "name" && name !== WAIT_FIELD && !name.startsWith(`${OPENING_FIELD}[`) && !name.startsWith(`${CLOSING_FIELD}[`)))].sort(),
    };
  };
  const proofFor = () => ({
    method: "native_form_read",
    route: MODEDIT_PATH,
    required_capability: "moodle/course:manageactivities",
    required_module_capability: "mod/bigbluebuttonbn:addinstance",
    scope: "one_bigbluebuttonbn_activity",
    module: MODULE,
    // Morrow performs no BigBlueButton server action of any kind.
    bigbluebutton_server_request: "none_from_morrow",
    // Moodle's own settings page asks the BigBlueButton server for its version
    // as it renders. Morrow cannot prevent that and does not claim otherwise.
    moodle_contacts_bigbluebutton_to_render_form: true,
    meeting_joined: false,
    meeting_started: false,
    meeting_ended: false,
    recording_requested: false,
    live_session_state: "not_read",
  });
  const roomFields = (form) => ({
    instance_type: form.instanceType ? form.instanceType.value : null,
    instance_type_name: form.instanceType ? form.instanceType.name : null,
    available_instance_types: form.offeredInstanceTypes,
    room: { ...form.room, user_limit: form.userLimit },
    recording: form.recording,
    lock: form.lock,
    guest_access: {
      allowed: form.guestAllowed,
      must_approve_user: form.guestMustApprove,
      join_url_present: form.guestJoinUrlPresent,
      password_present: form.guestPasswordPresent,
    },
    schedule: { opening_time: form.opening.date, closing_time: form.closing.date },
    site_time: form.siteTime,
    presentation_area_present: form.presentationAreaPresent,
    participant_rules: form.participants,
    introduction_empty: form.introductionEmpty,
  });
  const creationFormData = (courseId, section, form) => ({
    schema: SCHEMA,
    provider: PROVIDER,
    course_id: Number(courseId),
    section_id: Number(section.id),
    section_number: Number(section.number),
    module: MODULE,
    ...roomFields(form),
    schedule_writable: form.scheduleWritable,
    wait_for_moderator_writable: form.waitWritable,
    visible: false,
    protected_setting_names: form.protectedFields,
    proof: proofFor(),
  });
  const activityData = (courseId, module, form) => ({
    schema: SCHEMA,
    provider: PROVIDER,
    course_id: Number(courseId),
    module_id: Number(module.id),
    section_id: Number(module.sectionId),
    name: form.name,
    module: MODULE,
    ...roomFields(form),
    room_open_now: form.roomOpenNow,
    visible: module.visible,
    protected_setting_names: form.protectedFields,
    proof: proofFor(),
  });
  const snapshotDigest = (form) => digest({ values: form.values });
  const protectedDigest = (form, settings) => {
    const values = { ...form.values };
    if (Object.hasOwn(settings, "name")) delete values.name;
    if (Object.hasOwn(settings, "waitForModerator")) delete values[WAIT_FIELD];
    if (Object.hasOwn(settings, "openingTime")) {
      for (const name of Object.keys(values)) {
        if (name.startsWith(`${OPENING_FIELD}[`) || name.startsWith(`${CLOSING_FIELD}[`)) delete values[name];
      }
    }
    return digest({ values });
  };
  const readCreationForm = async (context, args) => {
    const state = await courseState(context, args.courseId);
    if (state.error) return failure(state.error, state.status);
    const section = sectionOf(state, args.targetId);
    if (!section) return failure("moodle_bigbluebuttonbn_section_target_invalid", state.status);
    const endpoint = endpointForCreationForm(context, args.courseId, args.targetId);
    const page = await readPage(context, endpoint);
    if (page.error) return failure(page.error, page.status);
    const form = await roomFormState(page.document, context, endpoint, { course: args.courseId, add: MODULE, section: section.number, update: "0", return: "0" });
    if (form.error) return failure(form.error, page.status);
    if (form.name !== "" || !form.introductionEmpty || !form.hiddenAllowed) return failure("moodle_bigbluebuttonbn_form_invalid", page.status);
    // A new activity has no schedule, so both selectors are switched off and
    // both render the site's current time. Without one there is no clock to
    // hold the room-open rule against.
    if (form.opening.enabled || form.closing.enabled) return failure("moodle_bigbluebuttonbn_form_invalid", page.status);
    const data = creationFormData(args.courseId, section, form);
    return {
      ok: true, sent: true, status: page.status, data,
      targets: [courseTarget(state), { field: "section_id", label: "Section", name: section.name }],
      snapshot_digest: await snapshotDigest(form), form, section, state,
    };
  };
  const readActivity = async (context, args) => {
    const state = await courseState(context, args.courseId);
    if (state.error) return failure(state.error, state.status);
    const module = roomModuleOf(state, args.targetId);
    if (!module) return failure("moodle_bigbluebuttonbn_module_target_invalid", state.status);
    const endpoint = endpointForActivity(context, args.targetId);
    const page = await readPage(context, endpoint);
    if (page.error) return failure(page.error, page.status);
    const form = await roomFormState(page.document, context, endpoint, { update: args.targetId, course: args.courseId, return: "0" });
    if (form.error) return failure(form.error, page.status);
    if (!form.name || form.name !== module.name) return failure("moodle_bigbluebuttonbn_module_target_invalid", page.status);
    const data = activityData(args.courseId, module, form);
    return {
      ok: true, sent: true, status: page.status, data,
      targets: [courseTarget(state), { field: "module_id", label: "BigBlueButton room", name: module.name }],
      snapshot_digest: await snapshotDigest(form), form, module, state,
    };
  };
  /**
   * Sends the one native save. The redirect is never followed, so no join,
   * recording or report route can be reached whatever Moodle answers with.
   * Chromium exposes a manual same-origin POST redirect as opaqueredirect, so
   * the authoritative readback that follows is the confirmation.
   */
  const postForm = async (context, form, courseId, overrides) => {
    const preflight = currentContext();
    if (!sameContext(context, preflight) || form.nativeSesskey !== preflight?.sesskey) return { error: "moodle_form_session_mismatch", notSent: true };
    const body = new URLSearchParams();
    for (const [name, value] of form.entries) {
      // Never notify learners.
      if (name === NOTIFICATION_FIELD) continue;
      if (Object.hasOwn(overrides, name)) continue;
      body.append(name, value);
    }
    // An override with no values removes that control, which is how an unticked
    // native checkbox is sent.
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
      const courseView = urlFor(context, COURSE_VIEW_PATH, { id: courseId });
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
  /**
   * The guard that decides whether this create may be sent at all. It is checked
   * on the reviewed form and again on the form that is actually sent, because
   * the site clock, the guest setting and the participant mapping all belong to
   * the page and not to the digest.
   */
  const sendGuard = (form, settings) => {
    if (!form.nameWritable || !form.scheduleWritable) return "moodle_bigbluebuttonbn_setting_not_writable";
    if (Object.hasOwn(settings, "waitForModerator") && !form.waitWritable) return "moodle_bigbluebuttonbn_setting_not_writable";
    if (form.guestAllowed === true) return "moodle_bigbluebuttonbn_guest_access_refused";
    if (form.participants.names_a_user) return "moodle_bigbluebuttonbn_participant_rule_names_user";
    if (!form.siteTime) return "moodle_bigbluebuttonbn_site_time_unavailable";
    // Morrow cannot see whether a meeting is running, so it refuses to open a
    // room that Moodle's own rule would already treat as open.
    if (compareCivil(settings.openingTime, form.siteTime) <= 0) return "moodle_bigbluebuttonbn_room_open_now";
    return "";
  };
  const updateGuard = (form, settings) => {
    // The form has no live-session state. A setting update is allowed only when
    // Moodle's own schedule rule can prove the room is closed right now.
    if (form.roomOpenNow !== false) return "moodle_bigbluebuttonbn_room_open_now";
    if (Object.hasOwn(settings, "name") && !form.nameWritable) return "moodle_bigbluebuttonbn_setting_not_writable";
    if (Object.hasOwn(settings, "waitForModerator") && !form.waitWritable) return "moodle_bigbluebuttonbn_setting_not_writable";
    if (Object.hasOwn(settings, "openingTime")) {
      if (!form.scheduleWritable || !form.siteTime) return "moodle_bigbluebuttonbn_setting_not_writable";
      const closingTime = Object.hasOwn(settings, "closingTime") ? settings.closingTime : form.closing.date;
      if (closingTime && compareCivil(closingTime, settings.openingTime) <= 0) return "moodle_bigbluebuttonbn_schedule_invalid";
      if (compareCivil(settings.openingTime, form.siteTime) <= 0) return "moodle_bigbluebuttonbn_room_open_now";
    }
    return "";
  };
  const scheduleOverrides = (settings, currentClosingTime = null) => {
    const overrides = { [`${OPENING_FIELD}[enabled]`]: ["1"] };
    for (const key of DATE_KEYS) overrides[`${OPENING_FIELD}[${key}]`] = [String(settings.openingTime[key])];
    const closingTime = Object.hasOwn(settings, "closingTime") ? settings.closingTime : currentClosingTime;
    if (closingTime) {
      overrides[`${CLOSING_FIELD}[enabled]`] = ["1"];
      for (const key of DATE_KEYS) overrides[`${CLOSING_FIELD}[${key}]`] = [String(closingTime[key])];
    } else {
      overrides[`${CLOSING_FIELD}[enabled]`] = [];
    }
    return overrides;
  };
  const runCreate = async (context, args) => {
    const before = await readCreationForm(context, args);
    if (!before.ok) return before;
    if (before.snapshot_digest !== args.expectedDigest) return failure("moodle_expected_digest_mismatch", before.status);
    const reviewProblem = sendGuard(before.form, args.settings);
    if (reviewProblem) return failure(reviewProblem, before.status);
    const refreshed = await readCreationForm(context, args);
    if (!refreshed.ok) return refreshed;
    if (refreshed.snapshot_digest !== args.expectedDigest || refreshed.form.action !== before.form.action) {
      return failure("moodle_expected_digest_mismatch", refreshed.status);
    }
    const sendProblem = sendGuard(refreshed.form, args.settings);
    if (sendProblem) return failure(sendProblem, refreshed.status);
    // The activity list read immediately before the dispatch is the baseline the
    // new module is found against, so nothing already there can match.
    const existingIds = new Set(refreshed.state.activities.map((entry) => id(object(entry) ? entry.id : "")).filter(Boolean));
    const overrides = { name: [args.name], visible: ["0"], ...scheduleOverrides(args.settings) };
    if (Object.hasOwn(args.settings, "waitForModerator")) overrides[WAIT_FIELD] = args.settings.waitForModerator ? ["1"] : [];
    const posted = await postForm(context, refreshed.form, args.courseId, overrides);
    if (posted.error) {
      if (posted.notSent === true) return failure(posted.error, refreshed.status);
      if (posted.validation === true) return appliedButRefused(posted.error, posted.status);
      return unconfirmedWrite("moodle_bigbluebuttonbn_create_unconfirmed", posted.status);
    }
    const after = await courseState(context, args.courseId);
    if (after.error) return unconfirmedWrite("moodle_bigbluebuttonbn_create_unconfirmed", posted.status);
    const created = after.activities.filter((entry) => object(entry) && !existingIds.has(id(entry.id))
      && String(entry.module || "") === MODULE && collapsed(entry.name) === args.name
      && id(entry.sectionid) === args.targetId && entry.visible === false);
    const moduleId = created.length === 1 ? id(created[0].id) : "";
    if (!moduleId) return unconfirmedWrite("moodle_bigbluebuttonbn_create_not_verified", posted.status);
    const saved = await readActivity(context, { courseId: args.courseId, targetId: moduleId });
    if (!saved.ok) return unconfirmedWrite("moodle_bigbluebuttonbn_create_not_verified", posted.status);
    // A setting the approval did not name is not claimed back, only the ones it did.
    const waitWrong = Object.hasOwn(args.settings, "waitForModerator")
      && saved.data.room.wait_for_moderator !== args.settings.waitForModerator;
    if (saved.data.name !== args.name || saved.data.section_id !== Number(args.targetId) || saved.data.visible !== false
      || !sameCivil(saved.data.schedule.opening_time, args.settings.openingTime)
      || !sameCivil(saved.data.schedule.closing_time, args.settings.closingTime)
      || waitWrong
      || saved.data.guest_access.allowed === true) {
      return unconfirmedWrite("moodle_bigbluebuttonbn_create_not_verified", posted.status);
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
    const reviewProblem = updateGuard(before.form, args.settings);
    if (reviewProblem) return failure(reviewProblem, before.status);
    const refreshed = await readActivity(context, args);
    if (!refreshed.ok) return refreshed;
    if (refreshed.snapshot_digest !== args.expectedDigest || refreshed.form.action !== before.form.action) {
      return failure("moodle_expected_digest_mismatch", refreshed.status);
    }
    const sendProblem = updateGuard(refreshed.form, args.settings);
    if (sendProblem) return failure(sendProblem, refreshed.status);
    const protectedBefore = await protectedDigest(refreshed.form, args.settings);
    const overrides = {};
    if (Object.hasOwn(args.settings, "name")) overrides.name = [args.settings.name];
    if (Object.hasOwn(args.settings, "openingTime")) {
      Object.assign(overrides, scheduleOverrides(args.settings, refreshed.form.closing.date));
    }
    if (Object.hasOwn(args.settings, "waitForModerator")) overrides[WAIT_FIELD] = args.settings.waitForModerator ? ["1"] : [];
    const posted = await postForm(context, refreshed.form, args.courseId, overrides);
    if (posted.error) {
      if (posted.notSent === true) return failure(posted.error, refreshed.status);
      if (posted.validation === true) return appliedButRefused(posted.error, posted.status);
      return unconfirmedWrite("moodle_bigbluebuttonbn_update_unconfirmed", posted.status);
    }
    const saved = await readActivity(context, args);
    if (!saved.ok) return unconfirmedWrite("moodle_bigbluebuttonbn_update_not_verified", posted.status);
    const protectedAfter = await protectedDigest(saved.form, args.settings);
    const expectedClosing = Object.hasOwn(args.settings, "openingTime")
      ? Object.hasOwn(args.settings, "closingTime") ? args.settings.closingTime : refreshed.form.closing.date
      : null;
    const wrongName = Object.hasOwn(args.settings, "name") && saved.data.name !== args.settings.name;
    const wrongSchedule = Object.hasOwn(args.settings, "openingTime")
      && (!sameCivil(saved.data.schedule.opening_time, args.settings.openingTime)
        || !sameCivil(saved.data.schedule.closing_time, expectedClosing));
    const wrongWait = Object.hasOwn(args.settings, "waitForModerator")
      && saved.data.room.wait_for_moderator !== args.settings.waitForModerator;
    if (protectedAfter !== protectedBefore || wrongName || wrongSchedule || wrongWait) {
      return unconfirmedWrite("moodle_bigbluebuttonbn_update_not_verified", posted.status);
    }
    return {
      ok: true, sent: true, status: posted.status ?? saved.status,
      data: { ...saved.data, updated: true },
      targets: saved.targets, snapshot_digest: saved.snapshot_digest,
      verification: { schema: "morrow.browser-verification.v1", status: "verified" },
    };
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
    if (!args) return failure("moodle_bigbluebuttonbn_arguments_invalid");
    if (definition.kind === "creation-form") return readResult(await readCreationForm(context, args));
    if (definition.kind === "activity") return readResult(await readActivity(context, args));
    return definition.kind === "update" ? await runUpdate(context, args) : await runCreate(context, args);
  } catch (error) {
    if (dispatched) return unconfirmedWrite("moodle_bigbluebuttonbn_write_unconfirmed");
    return failure(String(error?.message || error).startsWith("moodle_") ? String(error.message) : "moodle_bigbluebuttonbn_execution_failed");
  }
}
