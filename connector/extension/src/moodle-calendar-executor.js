/**
 * The calendar of one approved Moodle course: the events one month carries,
 * every date the course holds grouped by the activity that owns it, one exact
 * event, and the three writes that create, change, or remove one course event.
 *
 * An activity's own due, open and close dates reach this calendar as activity
 * events, so they are read here, one month at a time and again grouped by
 * activity. They are not written here: an activity's date belongs to the
 * activity, and changing the event Moodle builds from it changes nothing.
 *
 * Moodle 5.2.2 ships no core course Dates page and no core dates report, so the
 * grouped read is this course's own calendar and nothing else. An activity date
 * the calendar does not carry is not listed there, because it reads the
 * calendar and not each activity's own settings.
 *
 * Every route is native, fixed, and same-site:
 *
 * - `core_calendar_get_calendar_monthly_view`: one month of the course calendar.
 * - `core_calendar_get_calendar_event_by_id`: one exact event record.
 * - `core_get_fragment` with the calendar `event_form` callback: the event's
 *   own native form, which is what Moodle's own New event and Edit event
 *   screens load.
 * - `core_calendar_submit_create_update_form`: the one create or update dispatch.
 * - `core_calendar_delete_calendar_events`: the one deletion dispatch.
 *
 * https://github.com/moodle/moodle/blob/v5.2.2/public/calendar/externallib.php
 * https://github.com/moodle/moodle/blob/v5.2.2/public/calendar/lib.php
 *
 * Time. A calendar date is a wall-clock date in the civil time zone the
 * signed-in person has configured, and Morrow never converts one.
 *
 * - Every date Morrow returns is the year, month, day, hour and minute Moodle
 *   itself rendered: the month grid's own day cell for a listed event, and the
 *   event form's own date controls for one exact event.
 * - Every date Morrow sends is the year, month, day, hour and minute that were
 *   approved, written into those same native controls.
 * - Every result names the time zone Moodle states for that person,
 *   `M.cfg.usertimezone`, and refuses the operation when the page states none.
 * - Moodle's own instant, `timestart`, travels beside the civil fields as the
 *   site's own value. Morrow never derives a civil field from it and never
 *   compares one against it. That is what keeps a date on a daylight-saving
 *   boundary the date that was approved: the hour that was reviewed is the
 *   hour that is sent and the hour that is read back, whatever offset the site
 *   was using on either side of the change.
 *
 * Scope. The writes cover one course event in the approved course. An event an
 * activity owns is refused: its date belongs to the activity, changing or
 * removing the event does not change the activity, and Moodle builds the event
 * again. A repeated event is refused, because one change or one deletion can
 * reach the whole series. Personal, site and category events are refused,
 * because they are not this course. No read returns a learner identity.
 *
 * Every write reads the exact target first, requires the digest of the state
 * the person reviewed, reads the native form again immediately before it acts
 * and requires every control it does not set to be unchanged, sends exactly one
 * request, then reads the authoritative saved state back. A lost response or a
 * saved state that is not the approved one is `applied_or_unknown`, and is
 * never retried.
 *
 * Chrome serializes this function for a MAIN-world injection. Keep every
 * dependency inside the function body.
 */
export async function executeMoodleCalendarInPage(rawInput) {
  const PROVIDER = "moodle";
  const AJAX_PATH = "/lib/ajax/service.php";
  const MONTH_METHOD = "core_calendar_get_calendar_monthly_view";
  const EVENT_METHOD = "core_calendar_get_calendar_event_by_id";
  const FRAGMENT_METHOD = "core_get_fragment";
  const SUBMIT_METHOD = "core_calendar_submit_create_update_form";
  const DELETE_METHOD = "core_calendar_delete_calendar_events";
  const FRAGMENT_COMPONENT = "calendar";
  const FRAGMENT_CALLBACK = "event_form";
  const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
  const MAX_MONTHS = 12;
  const MAX_EVENTS = 500;
  const MAX_FORM_ENTRIES = 400;
  const MAX_FORM_BYTES = 200_000;
  const MAX_VALUE_LENGTH = 100_000;
  const MAX_NAME = 254;
  const MAX_LOCATION = 255;
  const MAX_DESCRIPTION = 8_000;
  const MAX_DISPLAY = 300;
  const MAX_DURATION_MINUTES = 525_600;
  const MIN_YEAR = 1970;
  const MAX_YEAR = 2100;
  const ID = /^[1-9][0-9]*$/;
  const DIGEST = /^[a-f0-9]{64}$/;
  // The one event type Morrow writes. A course event belongs to the course
  // that everyone enrolled in it shares.
  const COURSE_EVENT_TYPE = "course";
  // Text Morrow sends. Markup and an ampersand are refused there, because Moodle
  // cleans those on the way in and a cleaned value is not the value that was
  // approved. Text Morrow reads back carries no such restriction: an event a
  // person has already named "Q&A" is read and reported as it is.
  const SAFE_LINE = /^[^<>&\u0000-\u001f\u007f]*$/;
  const SAFE_BLOCK = /^[^<>&\u0000-\u0009\u000b-\u001f\u007f]*$/;
  const definitions = Object.freeze({
    "moodle.ajax.core_calendar.course_events.read.v1": { toolName: "moodle_list_course_events", readOnly: true, kind: "list" },
    "moodle.ajax.core_calendar.course_dates.read.v1": { toolName: "moodle_get_course_dates", readOnly: true, kind: "dates" },
    "moodle.ajax.core_calendar.event.read.v1": { toolName: "moodle_get_event", readOnly: true, kind: "event" },
    "moodle.ajax.core_calendar.event_create.write.v1": { toolName: "moodle_create_course_event", readOnly: false, kind: "create" },
    "moodle.ajax.core_calendar.event_update.write.v1": { toolName: "moodle_update_event", readOnly: false, kind: "update" },
    "moodle.ajax.core_calendar.event_delete.write.v1": { toolName: "moodle_delete_event", readOnly: false, kind: "delete" },
  });
  // What Moodle removes when it deletes one course event, in the words an
  // instructor reads on the calendar. The event read carries this list, so the
  // person approving a deletion has already seen it.
  const DELETION_REMOVES = Object.freeze([
    "The calendar event itself, with its name, description, location, date, and duration",
    "The event's place in this course's calendar for everyone enrolled in the course",
    "The reminders Moodle still has to send for that event",
  ]);
  const DELETION_KEEPS = Object.freeze([
    "No activity, no activity date, no grade, and no learner work is removed",
  ]);
  // The controls this executor sets, and the controls Moodle fills with a value
  // that depends on when the form was loaded. Neither group can be compared
  // between two loads of the same form; every other control must be identical.
  const WRITTEN_CONTROLS = Object.freeze([
    "name", "location", "description[text]", "eventtype", "courseid", "duration", "timedurationminutes",
    "timestart[day]", "timestart[month]", "timestart[year]", "timestart[hour]", "timestart[minute]",
  ]);
  const DROPPED_CONTROLS = Object.freeze(["repeat", "repeats", "repeateditall"]);
  const DEFAULTED_CONTROLS = Object.freeze([
    "timedurationuntil[day]", "timedurationuntil[month]", "timedurationuntil[year]",
    "timedurationuntil[hour]", "timedurationuntil[minute]",
  ]);
  const object = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
  const input = (() => { try { return typeof rawInput === "string" ? JSON.parse(rawInput) : rawInput; } catch { return null; } })();
  const failure = (error, status) => ({ ok: false, sent: false, ...(Number.isInteger(status) ? { status } : {}), error });
  const incomplete = (status) => ({ ok: false, sent: false, complete: false, ...(Number.isInteger(status) ? { status } : {}), error: "moodle_calendar_result_incomplete" });
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
  const collapsed = (value, maximum) => {
    const text = String(value ?? "").replace(/\s+/g, " ").trim();
    return text && text.length <= maximum && !/[\u0000-\u001f\u007f]/.test(text) ? text : "";
  };
  const bool = (value) => (value === true || value === 1 ? true : value === false || value === 0 ? false : null);
  const whole = (value, minimum, maximum) => {
    const parsed = typeof value === "string" && /^(?:0|[1-9][0-9]*)$/.test(value) ? Number(value) : value;
    return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
  };
  // Gregorian calendar arithmetic on the civil fields alone. Date.UTC reaches
  // no time zone, and this asks only whether the day exists in that month, so a
  // date Moodle would silently roll into the next month is refused instead.
  const realDate = (year, month, day) => {
    const stamp = new Date(Date.UTC(year, month - 1, day));
    return stamp.getUTCFullYear() === year && stamp.getUTCMonth() === month - 1 && stamp.getUTCDate() === day;
  };
  const transientField = (name) => /(?:sesskey|statekey|_qf__|csrf|token|secret|password|authorization|cookie|(?:^|[\[_-])(?:draft|itemid)(?:$|[\]_-]))/i.test(name);
  const stable = (value) => {
    if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
    if (object(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
    return JSON.stringify(value === undefined ? null : value);
  };
  const digest = async (value) => {
    if (!globalThis.crypto?.subtle || typeof globalThis.TextEncoder !== "function") throw new Error("moodle_calendar_digest_unavailable");
    const bytes = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(stable(value)));
    return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
  };
  // Moodle renders an event's own time as display text in the site's language
  // and format. Morrow carries that text through as text and reads nothing
  // into it.
  const plainText = (value) => {
    const raw = String(value ?? "");
    if (!raw || raw.length > MAX_VALUE_LENGTH) return "";
    if (!raw.includes("<")) return collapsed(raw, MAX_DISPLAY);
    if (typeof globalThis.DOMParser !== "function") return "";
    let parsed;
    try { parsed = new DOMParser().parseFromString(raw, "text/html"); } catch { return ""; }
    return collapsed(parsed.body?.textContent ?? "", MAX_DISPLAY);
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
    return {
      origin: site.origin,
      siteUrl: site.href,
      basePath,
      principalId,
      anchorCourseId,
      sesskey: cfg.sesskey,
      // The course context the calendar form fragment is rendered in, and the
      // civil time zone this person's dates are written and read in. Both are
      // the page's own statement about itself.
      courseContextId: id(cfg.courseContextId),
      timeZone: collapsed(cfg.usertimezone, 100),
    };
  };
  const sameContext = (left, right) => left?.origin === right?.origin && left?.siteUrl === right?.siteUrl
    && left?.basePath === right?.basePath && left?.principalId === right?.principalId
    && left?.anchorCourseId === right?.anchorCourseId && left?.sesskey === right?.sesskey
    && left?.courseContextId === right?.courseContextId && left?.timeZone === right?.timeZone;
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
    } catch { return write ? { unconfirmed: "moodle_calendar_write_unconfirmed" } : { error: "moodle_calendar_service_unavailable" }; }
    const raw = await boundedText(response, endpoint, context);
    let payload;
    try { payload = typeof raw === "string" ? JSON.parse(raw) : null; } catch { payload = null; }
    const entry = Array.isArray(payload) && payload.length === 1 && object(payload[0]) ? payload[0] : null;
    if (!entry || entry.error !== undefined || entry.exception !== undefined) {
      return write
        ? { unconfirmed: "moodle_calendar_write_unconfirmed", status: response.status }
        : { error: "moodle_calendar_service_unavailable", status: response.status };
    }
    return { data: entry.data, status: response.status };
  };

  /**
   * One month of the course calendar, projected to the fields a person reads
   * and reviews. Each event's date is the civil date of the month grid's own
   * day cell, so nothing here is derived from an instant.
   */
  const readMonth = async (context, courseId, year, month) => {
    const response = await ajax(context, MONTH_METHOD, {
      year, month, courseid: Number(courseId), categoryid: 0, includenavigation: false, mini: true, day: 1,
    }, false);
    if (response.error) return { error: response.error, status: response.status };
    const value = response.data;
    if (!object(value) || !Array.isArray(value.weeks)) return { error: "moodle_calendar_month_invalid", status: response.status };
    const events = new Map();
    let courseName = "";
    for (const week of value.weeks) {
      if (!object(week) || !Array.isArray(week.days)) return { error: "moodle_calendar_month_invalid", status: response.status };
      for (const day of week.days) {
        if (!object(day) || !Array.isArray(day.events)) return { error: "moodle_calendar_month_invalid", status: response.status };
        const civilStart = { year: whole(day.year, MIN_YEAR, MAX_YEAR), month: whole(day.mon, 1, 12), day: whole(day.mday, 1, 31) };
        if (civilStart.year !== year || civilStart.month !== month || civilStart.day === null) {
          return { error: "moodle_calendar_month_invalid", status: response.status };
        }
        for (const entry of day.events) {
          if (!object(entry)) return { error: "moodle_calendar_month_invalid", status: response.status };
          // Moodle shows this person every event they may see in the calendar
          // of this course, which includes their own and the site's. Only the
          // events that name this exact course are returned.
          if (!object(entry.course) || id(entry.course.id) !== courseId) continue;
          const eventId = id(entry.id);
          const name = collapsed(entry.name, MAX_NAME);
          const eventType = collapsed(entry.eventtype, 40);
          const visible = bool(entry.visible);
          const timeStart = whole(entry.timestart, 0, Number.MAX_SAFE_INTEGER);
          const duration = whole(entry.timeduration, 0, Number.MAX_SAFE_INTEGER);
          if (!eventId || !name || !eventType || visible === null || timeStart === null || duration === null) {
            return { error: "moodle_calendar_month_invalid", status: response.status };
          }
          courseName = courseName || collapsed(entry.course.fullname, MAX_NAME);
          const existing = events.get(eventId);
          // Moodle repeats an event on every day it covers. The first cell is
          // the day it starts on.
          if (existing) {
            existing.spans_days = true;
            continue;
          }
          if (events.size >= MAX_EVENTS) return { limited: true, status: response.status };
          const moduleName = collapsed(entry.modulename, 40);
          // Moodle names the course module an activity event belongs to in the
          // same place it names the module type, so the two arrive together or
          // this is not the month Moodle meant.
          const courseModuleId = moduleName ? id(entry.instance) : "";
          if (moduleName && !courseModuleId) return { error: "moodle_calendar_month_invalid", status: response.status };
          events.set(eventId, {
            event_id: Number(eventId),
            name,
            event_type: eventType,
            civil_start: civilStart,
            display_time: plainText(entry.formattedtime),
            time_start_seconds: timeStart,
            duration_seconds: duration,
            visible,
            is_activity_event: Boolean(moduleName) || Boolean(collapsed(entry.component, 60)),
            activity_module: moduleName || null,
            activity_name: collapsed(entry.activityname, MAX_NAME) || null,
            activity_course_module_id: courseModuleId ? Number(courseModuleId) : null,
            is_repeat: (whole(entry.repeatid, 0, Number.MAX_SAFE_INTEGER) || 0) > 0,
            spans_days: false,
            can_edit: entry.canedit === true,
            can_delete: entry.candelete === true,
          });
        }
      }
    }
    const listed = [...events.values()].sort((left, right) => (left.time_start_seconds - right.time_start_seconds) || (left.event_id - right.event_id));
    const projection = { time_zone: context.timeZone, year, month, event_count: listed.length, events: listed };
    return { projection, courseName, status: response.status, monthDigest: await digest(projection) };
  };

  /**
   * One exact event record, as Moodle's own calendar reads it.
   */
  const readEvent = async (context, courseId, eventId) => {
    const response = await ajax(context, EVENT_METHOD, { eventid: Number(eventId) }, false);
    if (response.error) return { error: "moodle_calendar_event_unavailable", status: response.status };
    const value = object(response.data) && object(response.data.event) ? response.data.event : null;
    if (!value || id(value.id) !== String(eventId)) return { error: "moodle_calendar_event_invalid", status: response.status };
    const name = collapsed(value.name, MAX_NAME);
    const eventType = collapsed(value.eventtype, 40);
    const visible = bool(value.visible);
    const timeStart = whole(value.timestart, 0, Number.MAX_SAFE_INTEGER);
    const duration = whole(value.timeduration, 0, Number.MAX_SAFE_INTEGER);
    if (!name || !eventType || visible === null || timeStart === null || duration === null) {
      return { error: "moodle_calendar_event_invalid", status: response.status };
    }
    const eventCourseId = object(value.course) ? id(value.course.id) : "";
    const moduleName = collapsed(value.modulename, 40);
    return {
      status: response.status,
      courseName: object(value.course) ? collapsed(value.course.fullname, MAX_NAME) : "",
      inCourse: eventCourseId === courseId,
      event: {
        event_id: Number(eventId),
        name,
        event_type: eventType,
        course_id: eventCourseId ? Number(eventCourseId) : null,
        group_id: whole(value.groupid, 1, Number.MAX_SAFE_INTEGER),
        time_start_seconds: timeStart,
        duration_seconds: duration,
        duration_minutes: duration % 60 === 0 ? duration / 60 : null,
        display_time: plainText(value.formattedtime),
        visible,
        is_activity_event: Boolean(moduleName) || Boolean(collapsed(value.component, 60)),
        activity_module: moduleName || null,
        activity_name: collapsed(value.activityname, MAX_NAME) || null,
        is_repeat: (whole(value.repeatid, 0, Number.MAX_SAFE_INTEGER) || 0) > 0,
        can_edit: value.canedit === true,
        can_delete: value.candelete === true,
      },
    };
  };

  const entriesFor = (form) => {
    let values;
    try { values = [...new FormData(form).entries()]; } catch { return null; }
    if (values.length > MAX_FORM_ENTRIES) return null;
    let size = 0;
    const collected = [];
    for (const [name, value] of values) {
      if (typeof name !== "string" || !name || name.length > 255 || typeof value !== "string" || value.length > MAX_VALUE_LENGTH) return null;
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
  // The controls this executor does not set. Two loads of the same form must
  // agree on every one of them, and an update must give every one of them back
  // unchanged.
  const otherControls = (entries) => entries.filter(([name]) => !transientField(name)
    && !WRITTEN_CONTROLS.includes(name) && !DROPPED_CONTROLS.includes(name) && !DEFAULTED_CONTROLS.includes(name));

  /**
   * The event's own native form, loaded exactly as Moodle's calendar loads it.
   * It carries the civil date controls, the stored text, and every control a
   * write must preserve.
   */
  const readEventForm = async (context, courseId, eventId) => {
    const fragmentArgs = eventId
      ? [{ name: "eventid", value: String(eventId) }]
      : [{ name: "courseid", value: String(courseId) }];
    const response = await ajax(context, FRAGMENT_METHOD, {
      component: FRAGMENT_COMPONENT, callback: FRAGMENT_CALLBACK, contextid: Number(context.courseContextId), args: fragmentArgs,
    }, false);
    if (response.error) return { error: "moodle_calendar_form_unavailable", status: response.status };
    if (typeof response.data !== "string" || !response.data || response.data.length > MAX_RESPONSE_BYTES
      || typeof globalThis.DOMParser !== "function") return { error: "moodle_calendar_form_unavailable", status: response.status };
    let parsed;
    try { parsed = new DOMParser().parseFromString(response.data, "text/html"); } catch { return { error: "moodle_calendar_form_invalid", status: response.status }; }
    const forms = [...parsed.querySelectorAll("form")];
    if (forms.length !== 1) return { error: "moodle_calendar_form_invalid", status: response.status };
    const form = forms[0];
    const entries = entriesFor(form);
    if (!entries) return { error: "moodle_calendar_form_invalid", status: response.status };
    // The form Moodle rendered for this session, and for this exact event.
    if (one(entries, "sesskey") !== context.sesskey) return { error: "moodle_calendar_form_invalid", status: response.status };
    const formEventId = one(entries, "id");
    if (eventId ? formEventId !== String(eventId) : !(formEventId === null || formEventId === "0")) {
      return { error: "moodle_calendar_form_invalid", status: response.status };
    }
    const civil = {
      year: whole(one(entries, "timestart[year]"), MIN_YEAR, MAX_YEAR),
      month: whole(one(entries, "timestart[month]"), 1, 12),
      day: whole(one(entries, "timestart[day]"), 1, 31),
      hour: whole(one(entries, "timestart[hour]"), 0, 23),
      minute: whole(one(entries, "timestart[minute]"), 0, 59),
    };
    if (Object.values(civil).some((part) => part === null) || !realDate(civil.year, civil.month, civil.day)) {
      return { error: "moodle_calendar_form_invalid", status: response.status };
    }
    const name = String(one(entries, "name") ?? "");
    const location = String(one(entries, "location") ?? "");
    const description = String(one(entries, "description[text]") ?? "");
    if (name.length > MAX_NAME || location.length > MAX_LOCATION || description.length > MAX_DESCRIPTION) {
      return { error: "moodle_calendar_form_invalid", status: response.status };
    }
    // A control that carries the session key is a control Morrow will not send
    // back as ordinary form data.
    if (entries.some(([controlName, value]) => !transientField(controlName) && value === context.sesskey)) {
      return { error: "moodle_calendar_form_invalid", status: response.status };
    }
    return {
      status: response.status,
      entries,
      civil,
      values: { name, location, description },
      eventTypes: [...form.querySelectorAll('select[name="eventtype"] option')].map((option) => String(option.value ?? "")),
      courseOptions: [...form.querySelectorAll('select[name="courseid"] option')]
        .map((option) => ({ value: String(option.value ?? ""), label: collapsed(option.textContent, MAX_NAME) })),
      otherDigest: await digest(otherControls(entries)),
    };
  };

  const formBody = (entries, overrides) => {
    const body = new URLSearchParams();
    for (const [name, value] of entries) {
      if (Object.hasOwn(overrides, name) || DROPPED_CONTROLS.includes(name)) continue;
      body.append(name, value);
    }
    for (const [name, value] of Object.entries(overrides)) body.append(name, value);
    return body.toString();
  };
  const overridesFor = (args, courseId) => ({
    name: args.name,
    location: args.location,
    "description[text]": args.description,
    eventtype: COURSE_EVENT_TYPE,
    courseid: String(courseId),
    "timestart[day]": String(args.day),
    "timestart[month]": String(args.month),
    "timestart[year]": String(args.year),
    "timestart[hour]": String(args.hour),
    "timestart[minute]": String(args.minute),
    // Moodle stores a duration as a number of seconds. Minutes is the one input
    // mode that states that number exactly; the "until" mode would measure it
    // across the very daylight-saving change this executor refuses to guess at.
    duration: args.durationMinutes > 0 ? "2" : "0",
    timedurationminutes: String(args.durationMinutes),
  });
  const plannedState = (args, courseId) => ({
    name: args.name,
    location: args.location,
    description: args.description,
    event_type: COURSE_EVENT_TYPE,
    course_id: Number(courseId),
    civil_start: { year: args.year, month: args.month, day: args.day, hour: args.hour, minute: args.minute },
    duration_seconds: args.durationMinutes * 60,
    is_repeat: false,
    is_activity_event: false,
  });
  // The saved state, taken from the two native sources that state it exactly:
  // the wall-clock date and the stored text from the event's own form, and the
  // stored duration, type, course and series from the event record.
  const savedState = (form, event) => ({
    name: form.values.name,
    location: form.values.location,
    description: form.values.description,
    event_type: event.event_type,
    course_id: event.course_id,
    civil_start: form.civil,
    duration_seconds: event.duration_seconds,
    is_repeat: event.is_repeat,
    is_activity_event: event.is_activity_event,
  });

  const exactKeys = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
  const argumentsFor = (definition, args, binding) => {
    const courseId = id(binding?.courseId);
    if (!courseId || !object(args) || id(args.course_id) !== courseId) return null;
    const base = { courseId };
    if (definition.kind === "list" || definition.kind === "dates") {
      if (!exactKeys(args, ["course_id", "year", "month", "month_count"])) return null;
      const year = whole(args.year, MIN_YEAR, MAX_YEAR);
      const month = whole(args.month, 1, 12);
      const monthCount = whole(args.month_count, 1, MAX_MONTHS);
      return year !== null && month !== null && monthCount !== null ? { ...base, year, month, monthCount } : null;
    }
    if (definition.kind === "event") {
      if (!exactKeys(args, ["course_id", "event_id"])) return null;
      const eventId = id(args.event_id);
      return eventId ? { ...base, eventId } : null;
    }
    if (definition.kind === "delete") {
      if (!exactKeys(args, ["course_id", "event_id", "expected_digest"])) return null;
      const eventId = id(args.event_id);
      return eventId && DIGEST.test(String(args.expected_digest || "")) ? { ...base, eventId, expectedDigest: args.expected_digest } : null;
    }
    const fields = ["course_id", "name", "description", "location", "year", "month", "day", "hour", "minute", "duration_minutes", "expected_digest"];
    if (!exactKeys(args, definition.kind === "update" ? ["event_id", ...fields] : fields)) return null;
    const eventId = definition.kind === "update" ? id(args.event_id) : "";
    if (definition.kind === "update" && !eventId) return null;
    const name = typeof args.name === "string" ? args.name.trim() : "";
    const location = typeof args.location === "string" ? args.location.trim() : "";
    const description = typeof args.description === "string" ? args.description : "";
    if (!name || name.length > MAX_NAME || !SAFE_LINE.test(name)) return null;
    if (location.length > MAX_LOCATION || !SAFE_LINE.test(location)) return null;
    // A description Moodle would clean, or one whose ends the HTML form would
    // trim, is not a description Morrow can prove it saved.
    if (description.length > MAX_DESCRIPTION || !SAFE_BLOCK.test(description) || description !== description.trim()) return null;
    const year = whole(args.year, MIN_YEAR, MAX_YEAR);
    const month = whole(args.month, 1, 12);
    const day = whole(args.day, 1, 31);
    const hour = whole(args.hour, 0, 23);
    const minute = whole(args.minute, 0, 59);
    const durationMinutes = whole(args.duration_minutes, 0, MAX_DURATION_MINUTES);
    if (year === null || month === null || day === null || hour === null || minute === null || durationMinutes === null) return null;
    if (!realDate(year, month, day) || !DIGEST.test(String(args.expected_digest || ""))) return null;
    return {
      ...base,
      ...(eventId ? { eventId } : {}),
      name, location, description, year, month, day, hour, minute, durationMinutes,
      expectedDigest: args.expected_digest,
    };
  };

  const timeProof = (context) => ({
    time_zone: context.timeZone,
    time_zone_source: "moodle_user_configuration",
    wall_clock_conversion: "none",
  });
  const proofFor = (definition, context) => ({
    method: "native_calendar_service",
    route: AJAX_PATH,
    service: { list: MONTH_METHOD, dates: MONTH_METHOD, event: EVENT_METHOD, create: SUBMIT_METHOD, update: SUBMIT_METHOD, delete: DELETE_METHOD }[definition.kind] || "",
    required_capability: definition.readOnly ? "the capability Moodle enforces on this course's calendar" : "moodle/calendar:manageentries",
    scope: "one_course_calendar",
    learner_identity: "never_returned",
    ...timeProof(context),
    ...(definition.kind === "delete" ? { reversible_by_morrow: false, removes: DELETION_REMOVES, keeps: DELETION_KEEPS } : {}),
    ...(definition.kind === "create" || definition.kind === "update" ? { reversible_by_morrow: false, repeats_created: false } : {}),
  });
  const courseTarget = (name) => ({ field: "course_id", label: "Course", name: name || "Moodle course" });
  const eventTarget = (name) => ({ field: "event_id", label: "Event", name });

  try {
    const context = currentContext();
    if (input?.mode !== "execute" || !context) return failure("moodle_session_unavailable");
    if (!live()) return failure("moodle_execution_expired");
    const definition = object(input.operation) && typeof input.operation.key === "string" ? definitions[input.operation.key] : null;
    if (!definition || input.operation.provider !== PROVIDER || input.operation.toolName !== definition.toolName
      || input.operation.readOnly !== definition.readOnly) return failure("moodle_operation_refused");
    if (!boundContext(context)) return failure("moodle_binding_mismatch");
    if (input.privateAttachment !== undefined || input.privateConversation !== undefined) return failure("moodle_calendar_attachment_refused");
    const args = argumentsFor(definition, input.arguments, input.binding);
    if (!args) return failure("moodle_calendar_arguments_invalid");
    // Every date below is stated in this zone. Morrow will not report or send a
    // wall-clock date the page has named no zone for.
    if (!context.timeZone) return failure("moodle_calendar_timezone_unavailable");
    if (!context.courseContextId) return failure("moodle_calendar_course_context_unavailable");

    if (definition.kind === "list") {
      const months = [];
      let courseName = "";
      let status;
      let year = args.year;
      let month = args.month;
      let total = 0;
      for (let index = 0; index < args.monthCount; index += 1) {
        const read = await readMonth(context, args.courseId, year, month);
        if (read.limited) return incomplete(read.status);
        if (read.error) return failure(read.error, read.status);
        total += read.projection.event_count;
        if (total > MAX_EVENTS) return incomplete(read.status);
        courseName = courseName || read.courseName;
        status = read.status;
        months.push({ ...read.projection, month_digest: read.monthDigest });
        month = month === 12 ? 1 : month + 1;
        if (month === 1) year += 1;
      }
      const data = {
        schema: "morrow.moodle.course-events.v1",
        provider: PROVIDER,
        course_id: Number(args.courseId),
        ...timeProof(context),
        month_count: months.length,
        event_count: total,
        months,
        // Every event that names this course, and nothing else this person can
        // see in the same calendar.
        listed_events: "this_course_only",
      };
      return {
        ok: true,
        sent: false,
        complete: true,
        status,
        data: { ...data, proof: proofFor(definition, context) },
        targets: [courseTarget(courseName)],
        snapshot_digest: await digest(data),
      };
    }

    if (definition.kind === "dates") {
      // Every dated entry this course carries across the window, kept once and
      // grouped by the activity that owns it. The months are read in order and
      // each month is already in Moodle's own order, so an activity first
      // appears at its earliest date and its dates stay in that order.
      const kept = new Map();
      const activities = new Map();
      const courseEntries = [];
      let courseName = "";
      let status;
      let year = args.year;
      let month = args.month;
      for (let index = 0; index < args.monthCount; index += 1) {
        const read = await readMonth(context, args.courseId, year, month);
        if (read.limited) return incomplete(read.status);
        if (read.error) return failure(read.error, read.status);
        courseName = courseName || read.courseName;
        status = read.status;
        for (const entry of read.projection.events) {
          // An entry that runs from one month into the next stands in both
          // grids. It is kept in the first month of this window that shows it,
          // and that entry is the one that says it spans days.
          const already = kept.get(entry.event_id);
          if (already) {
            already.spans_days = true;
            continue;
          }
          if (kept.size >= MAX_EVENTS) return incomplete(read.status);
          const date = {
            event_id: entry.event_id,
            name: entry.name,
            event_type: entry.event_type,
            civil_start: entry.civil_start,
            display_time: entry.display_time,
            time_start_seconds: entry.time_start_seconds,
            visible: entry.visible,
            spans_days: entry.spans_days,
          };
          kept.set(entry.event_id, date);
          if (entry.activity_course_module_id === null) {
            courseEntries.push(date);
            continue;
          }
          const activity = activities.get(entry.activity_course_module_id) || {
            course_module_id: entry.activity_course_module_id,
            activity_module: entry.activity_module,
            activity_name: entry.activity_name,
            date_count: 0,
            dates: [],
          };
          activity.dates.push(date);
          activity.date_count = activity.dates.length;
          activities.set(entry.activity_course_module_id, activity);
        }
        month = month === 12 ? 1 : month + 1;
        if (month === 1) year += 1;
      }
      const data = {
        schema: "morrow.moodle.course-dates.v1",
        provider: PROVIDER,
        course_id: Number(args.courseId),
        ...timeProof(context),
        from: { year: args.year, month: args.month },
        month_count: args.monthCount,
        dated_entry_count: kept.size,
        activity_count: activities.size,
        activities: [...activities.values()],
        // The dated entries of this course that no activity owns.
        course_entries: courseEntries,
        // Moodle ships no core Dates page, so this is the course calendar and
        // nothing else: an activity date the calendar does not carry is absent.
        dates_source: "course_calendar",
        listed_entries: "this_course_only",
      };
      return {
        ok: true,
        sent: false,
        complete: true,
        status,
        data: { ...data, proof: proofFor(definition, context) },
        targets: [courseTarget(courseName)],
        snapshot_digest: await digest(data),
      };
    }

    // Every remaining operation is about one exact event: the read a person
    // reviews, and the two writes and the deletion that act on it.
    const eventState = async (eventId) => {
      const record = await readEvent(context, args.courseId, eventId);
      if (record.error) return record;
      // An activity owns its own dates and its own form. Morrow reads the
      // activity event and never opens a form for it.
      const form = record.event.is_activity_event ? null : await readEventForm(context, args.courseId, eventId);
      if (form?.error) return { error: form.error, status: form.status };
      const data = {
        schema: "morrow.moodle.calendar-event.v1",
        provider: PROVIDER,
        course_id: Number(args.courseId),
        ...timeProof(context),
        ...record.event,
        in_this_course: record.inCourse,
        writable_by_morrow: record.inCourse && !record.event.is_activity_event && !record.event.is_repeat
          && record.event.event_type === COURSE_EVENT_TYPE && record.event.can_edit && record.event.can_delete,
        civil_start: form ? form.civil : null,
        description: form ? form.values.description : null,
        location: form ? form.values.location : null,
        form_digest: form ? form.otherDigest : null,
        // What a deletion of this event removes, stated before it is approved.
        deletion_removes: DELETION_REMOVES,
        deletion_keeps: DELETION_KEEPS,
        deletion_reversible_by_morrow: false,
      };
      return { record, form, data, status: record.status, snapshotDigest: await digest(data) };
    };

    if (definition.kind === "event") {
      const state = await eventState(args.eventId);
      if (state.error) return failure(state.error, state.status);
      return {
        ok: true,
        sent: false,
        complete: true,
        status: state.status,
        data: { ...state.data, proof: proofFor(definition, context) },
        targets: [courseTarget(state.record.courseName), eventTarget(state.record.event.name)],
        snapshot_digest: state.snapshotDigest,
      };
    }

    // A write acts on an event Morrow writes at all, and only after the
    // reviewed state is still the exact saved state.
    const writable = (state) => {
      if (!state.record.inCourse) return "moodle_calendar_event_not_in_course";
      if (state.record.event.is_activity_event) return "moodle_calendar_activity_event_refused";
      if (state.record.event.is_repeat) return "moodle_calendar_repeat_event_refused";
      if (state.record.event.event_type !== COURSE_EVENT_TYPE) return "moodle_calendar_event_type_refused";
      if (!state.record.event.can_edit) return "moodle_calendar_event_not_editable";
      if (definition.kind === "delete" && !state.record.event.can_delete) return "moodle_calendar_event_not_deletable";
      return "";
    };

    if (definition.kind === "delete") {
      const state = await eventState(args.eventId);
      if (state.error) return failure(state.error, state.status);
      if (state.snapshotDigest !== args.expectedDigest) return failure("moodle_expected_digest_mismatch", state.status);
      const refusal = writable(state);
      if (refusal) return failure(refusal, state.status);
      const civil = state.data.civil_start;
      const before = await readMonth(context, args.courseId, civil.year, civil.month);
      if (before.limited) return incomplete(before.status);
      if (before.error) return failure(before.error, before.status);
      if (!before.projection.events.some((entry) => entry.event_id === Number(args.eventId))) {
        return failure("moodle_calendar_precondition_refused", before.status);
      }

      // The event and its month are read once more immediately before the
      // deletion, and the deletion is bound to that reading.
      const rechecked = currentContext();
      if (!sameContext(context, rechecked) || !boundContext(rechecked)) return failure("moodle_binding_mismatch");
      const fresh = await eventState(args.eventId);
      if (fresh.error) return failure(fresh.error, fresh.status);
      if (fresh.snapshotDigest !== args.expectedDigest) return failure("moodle_expected_digest_mismatch", fresh.status);
      const freshMonth = await readMonth(rechecked, args.courseId, civil.year, civil.month);
      if (freshMonth.limited) return incomplete(freshMonth.status);
      if (freshMonth.error) return failure(freshMonth.error, freshMonth.status);
      if (freshMonth.monthDigest !== before.monthDigest) return failure("moodle_calendar_precondition_refused", freshMonth.status);
      if (!sameContext(rechecked, currentContext())) return failure("moodle_binding_mismatch");

      const removal = await ajax(rechecked, DELETE_METHOD, { events: [{ eventid: Number(args.eventId), repeat: false }] }, true);
      if (removal.error) return failure(removal.error, removal.status);
      if (removal.unconfirmed) return unconfirmedWrite(removal.unconfirmed, removal.status);

      const after = await readMonth(rechecked, args.courseId, civil.year, civil.month);
      if (after.limited || after.error) return unconfirmedWrite("moodle_calendar_readback_unconfirmed", removal.status);
      const expected = {
        ...before.projection,
        event_count: before.projection.event_count - 1,
        events: before.projection.events.filter((entry) => entry.event_id !== Number(args.eventId)),
      };
      const gone = await readEvent(rechecked, args.courseId, args.eventId);
      const result = {
        status: after.status,
        data: {
          schema: "morrow.moodle.calendar-event-removed.v1",
          provider: PROVIDER,
          course_id: Number(args.courseId),
          event_id: Number(args.eventId),
          ...timeProof(context),
          name: state.record.event.name,
          civil_start: civil,
          month: { ...after.projection, month_digest: after.monthDigest },
          proof: proofFor(definition, context),
        },
        targets: [courseTarget(state.record.courseName), eventTarget(state.record.event.name)],
        snapshot_digest: after.monthDigest,
      };
      // The month must come back as exactly the reviewed month with that one
      // event gone, and the event itself must no longer be readable.
      if (stable(after.projection) !== stable(expected) || !gone.error) {
        return unconfirmedWrite("moodle_calendar_write_not_verified", removal.status, result);
      }
      return { ok: true, sent: true, ...result, verification: { schema: "morrow.browser-verification.v1", status: "verified" } };
    }

    // Create and update. Both write the approved wall-clock date into the
    // native form's own date controls and change nothing else.
    const planned = plannedState(args, args.courseId);
    let before = null;
    let priorState = null;
    if (definition.kind === "update") {
      priorState = await eventState(args.eventId);
      if (priorState.error) return failure(priorState.error, priorState.status);
      if (priorState.snapshotDigest !== args.expectedDigest) return failure("moodle_expected_digest_mismatch", priorState.status);
      const refusal = writable(priorState);
      if (refusal) return failure(refusal, priorState.status);
      if (stable(savedState(priorState.form, priorState.record.event)) === stable(planned)) {
        return failure("moodle_calendar_event_unchanged", priorState.status);
      }
    } else {
      before = await readMonth(context, args.courseId, args.year, args.month);
      if (before.limited) return incomplete(before.status);
      if (before.error) return failure(before.error, before.status);
      if (before.monthDigest !== args.expectedDigest) return failure("moodle_expected_digest_mismatch", before.status);
    }

    const reviewed = definition.kind === "update" ? priorState.form : await readEventForm(context, args.courseId, "");
    if (reviewed.error) return failure(reviewed.error, reviewed.status);
    // Moodle offers the course event type, and this course as its target, only
    // to a person who may manage this course's calendar entries.
    if (!reviewed.eventTypes.includes(COURSE_EVENT_TYPE)
      || !reviewed.courseOptions.some((option) => id(option.value) === args.courseId)) {
      return failure("moodle_calendar_course_event_not_permitted", reviewed.status);
    }
    const courseName = reviewed.courseOptions.find((option) => id(option.value) === args.courseId)?.label
      || (definition.kind === "update" ? priorState.record.courseName : before.courseName);

    // The form is loaded once more immediately before the write. Every control
    // this executor does not set must be exactly the reviewed one.
    const rechecked = currentContext();
    if (!sameContext(context, rechecked) || !boundContext(rechecked)) return failure("moodle_binding_mismatch");
    const fresh = await readEventForm(rechecked, args.courseId, definition.kind === "update" ? args.eventId : "");
    if (fresh.error) return failure(fresh.error, fresh.status);
    if (fresh.otherDigest !== reviewed.otherDigest) return failure("moodle_calendar_form_changed", fresh.status);
    if (definition.kind === "update") {
      const freshState = await eventState(args.eventId);
      if (freshState.error) return failure(freshState.error, freshState.status);
      if (freshState.snapshotDigest !== args.expectedDigest) return failure("moodle_expected_digest_mismatch", freshState.status);
    } else {
      const freshMonth = await readMonth(rechecked, args.courseId, args.year, args.month);
      if (freshMonth.limited) return incomplete(freshMonth.status);
      if (freshMonth.error) return failure(freshMonth.error, freshMonth.status);
      if (freshMonth.monthDigest !== args.expectedDigest) return failure("moodle_expected_digest_mismatch", freshMonth.status);
    }
    if (!sameContext(rechecked, currentContext())) return failure("moodle_binding_mismatch");

    const submitted = await ajax(rechecked, SUBMIT_METHOD, { formdata: formBody(fresh.entries, overridesFor(args, args.courseId)) }, true);
    if (submitted.error) return failure(submitted.error, submitted.status);
    if (submitted.unconfirmed) return unconfirmedWrite(submitted.unconfirmed, submitted.status);
    if (!object(submitted.data) || submitted.data.validationerror === true) {
      return unconfirmedWrite("moodle_calendar_form_rejected", submitted.status);
    }

    let savedId = definition.kind === "update" ? args.eventId : "";
    if (definition.kind === "create") {
      const after = await readMonth(rechecked, args.courseId, args.year, args.month);
      if (after.limited || after.error) return unconfirmedWrite("moodle_calendar_readback_unconfirmed", submitted.status);
      const known = new Set(before.projection.events.map((entry) => entry.event_id));
      const added = after.projection.events.filter((entry) => !known.has(entry.event_id));
      const reported = object(submitted.data.event) ? id(submitted.data.event.id) : "";
      // Exactly one event was added, it is the event Moodle named, and the rest
      // of the month is exactly the month that was reviewed.
      if (added.length !== 1 || (reported && reported !== String(added[0].event_id))
        || stable(after.projection.events.filter((entry) => entry.event_id !== added[0].event_id)) !== stable(before.projection.events)) {
        return unconfirmedWrite("moodle_calendar_write_not_verified", submitted.status);
      }
      savedId = String(added[0].event_id);
    }

    const saved = await eventState(savedId);
    if (saved.error) return unconfirmedWrite("moodle_calendar_readback_unconfirmed", submitted.status);
    const result = {
      status: saved.status,
      data: { ...saved.data, proof: proofFor(definition, context) },
      targets: [courseTarget(courseName), eventTarget(saved.record.event.name)],
      snapshot_digest: saved.snapshotDigest,
    };
    if (!saved.form || stable(savedState(saved.form, saved.record.event)) !== stable(planned)) {
      return unconfirmedWrite("moodle_calendar_write_not_verified", submitted.status, result);
    }
    // An update must give back every control it did not set, unchanged.
    if (definition.kind === "update" && saved.form.otherDigest !== reviewed.otherDigest) {
      return unconfirmedWrite("moodle_calendar_write_not_verified", submitted.status, result);
    }
    return { ok: true, sent: true, ...result, verification: { schema: "morrow.browser-verification.v1", status: "verified" } };
  } catch (error) {
    if (dispatched.sent) return unconfirmedWrite("moodle_calendar_write_unconfirmed");
    const message = String(error?.message || error);
    return failure(message.startsWith("moodle_") ? message : "moodle_calendar_execution_failed");
  }
}
