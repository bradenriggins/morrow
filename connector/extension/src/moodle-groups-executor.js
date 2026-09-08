/**
 * The group and grouping lifecycle of one approved Moodle course, and the
 * group mode of one activity in it.
 *
 * Every route here is one of Moodle's own group-management pages, and each one
 * calls `require_capability('moodle/course:managegroups')` at the exact course
 * context before it does anything:
 * https://github.com/moodle/moodle/blob/v5.2.2/public/group/group.php#L69-L76
 *
 * - A group is created or changed through the native group form,
 *   `POST /group/group.php`, with the complete successful-control set of the
 *   form that was just loaded. Only the name, the visibility and the
 *   participation flag are ever changed; every other control is carried
 *   through unchanged and compared afterwards.
 * - A group is deleted through `POST /group/delete.php` with Moodle's own
 *   confirmation fields. That removes the group's membership, its place in
 *   every grouping, its calendar events, its group conversation and its files,
 *   so the deletion names every member it removes before it is approved and
 *   refuses when that membership is not the membership that was approved.
 * - A member is added or removed through the native member form,
 *   `POST /group/members.php?group=<group>`, with Moodle's own `add` or
 *   `remove` control and one user in `addselect[]` or `removeselect[]`. The
 *   user must first appear in that form's own candidate list for this exact
 *   group, so an identity Moodle does not offer for this group is refused
 *   before anything is sent.
 * - A grouping is created or changed through `POST /group/grouping.php`, and
 *   the groups of a grouping are set through `POST /group/assign.php?id=<grouping>`.
 *   Moodle's own grouping form adds or removes in one submission, never both,
 *   so a requested set that both adds and removes groups is refused instead of
 *   being sent as two changes.
 * - The group mode of one activity is set through the same native course-format
 *   action the course page's own group-mode control uses,
 *   `core_courseformat_update_course` with `cm_nogroups`, `cm_separategroups`
 *   or `cm_visiblegroups`. That action requires `moodle/course:manageactivities`,
 *   not `moodle/course:managegroups`:
 *   https://github.com/moodle/moodle/blob/v5.2.2/public/course/format/classes/stateactions.php#L769-L791
 *
 * Two Moodle rules decide what a change here can and cannot do, and both are
 * enforced from Moodle's own state rather than from a role label.
 *
 * 1. Hidden membership. A group's visibility decides who sees the group and
 *    who sees its members, and Moodle freezes the visibility and participation
 *    controls as soon as the group has one member
 *    (https://github.com/moodle/moodle/blob/v5.2.2/public/group/group_form.php#L146-L157).
 *    A change to either control is therefore refused while the loaded form
 *    holds them frozen, and every membership change reports the visibility the
 *    group already has, because adding a member to a hidden-membership group
 *    does not make that member visible to other learners.
 * 2. Separate groups. An activity group mode changes what learners see of each
 *    other's work in that activity. A course that forces its own group mode
 *    overrides the activity's stored value, so the saved value is read back
 *    from the course state and the course setting is read as well, and the
 *    result states the mode that is actually in effect.
 *
 * Every write reads the exact state first, reads it once more immediately
 * before it acts, sends exactly one native POST, and then requires the
 * authoritative saved state back with exactly the approved change in it and
 * everything else unchanged. A lost response, or a saved state that is not the
 * approved one, is `applied_or_unknown`; it is never retried.
 *
 * Member identities stay inside this page world except where a result must
 * name them: the member one change moves, and every member a deletion removes.
 * Those leave as the Moodle user ID and the source name only, so the MCP
 * runtime projects them through the complete course participant roster and
 * fails closed on an identity that roster does not hold.
 *
 * Chrome serializes this function for a MAIN-world injection. Keep every
 * dependency inside the function body.
 */
export async function executeMoodleGroupsLifecycleInPage(rawInput) {
  const PROVIDER = "moodle";
  const AJAX_PATH = "/lib/ajax/service.php";
  const GROUP_FORM_PATH = "/group/group.php";
  const GROUP_DELETE_PATH = "/group/delete.php";
  const GROUP_MEMBERS_PATH = "/group/members.php";
  const GROUP_INDEX_PATH = "/group/index.php";
  const GROUPING_FORM_PATH = "/group/grouping.php";
  const GROUPINGS_PATH = "/group/groupings.php";
  const GROUPING_ASSIGN_PATH = "/group/assign.php";
  const COURSE_FORM_PATH = "/course/edit.php";
  const GROUP_LIST_METHOD = "core_group_get_course_groups";
  const STATE_METHOD = "core_courseformat_get_state";
  const UPDATE_METHOD = "core_courseformat_update_course";
  const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
  const MAX_FORM_ENTRIES = 600;
  const MAX_FORM_BYTES = 256 * 1024;
  const MAX_VALUE_BYTES = 32 * 1024;
  const MAX_GROUPS = 500;
  const MAX_GROUPINGS = 200;
  const MAX_MEMBERS = 10_000;
  const MAX_ITEMS = 10_000;
  const MAX_NAME_LENGTH = 254;
  const ID = /^[1-9][0-9]{0,18}$/;
  const DIGEST = /^[a-f0-9]{64}$/;
  const COUNT = /^(?:0|[1-9][0-9]{0,8})$/;
  // Moodle escapes a stored group or grouping name for display, so a name that
  // carries a markup character comes back as an entity and cannot be compared
  // with the requested one. Morrow writes a plain name and refuses the rest.
  const WRITABLE_NAME = /^[^<>&"'\u0000-\u001f\u007f]+$/;
  const TRANSIENT_FIELD = /(?:sesskey|statekey|_qf__|csrf|token|secret|password|authorization|cookie|(?:^|[\[_-])(?:draft|itemid)(?:$|[\]_-]))/i;
  // Moodle mints a new draft item id for the group picture area every time the
  // form is loaded, so that control cannot be compared across two loads. It is
  // still carried through the one POST with every other control.
  const DRAFT_FIELD = /^imagefile$/;
  // public/group/lib.php groups_delete_group.
  const GROUP_REMOVALS = Object.freeze([
    "The group, its name, its description and its picture, with the files stored in them",
    "The membership of every member listed below. Each of them stops being in this group",
    "Its place in every grouping that holds it",
    "Its calendar events",
    "Its group conversation and the messages in it, where group messaging is on",
  ]);
  const GROUP_MODES = Object.freeze({
    0: { action: "cm_nogroups", label: "No groups" },
    1: { action: "cm_separategroups", label: "Separate groups" },
    2: { action: "cm_visiblegroups", label: "Visible groups" },
  });
  const VISIBILITY_LABELS = Object.freeze({
    0: "Visible to everyone in the course",
    1: "Members see the group and its other members",
    2: "Members see the group but not its other members",
    3: "Only staff who can manage groups see the group",
  });
  const definitions = Object.freeze({
    "moodle.page.group.groupings.read.v1": { toolName: "moodle_get_course_groupings", readOnly: true, kind: "groupings_read" },
    "moodle.form.group.create.v1": { toolName: "moodle_create_group", readOnly: false, kind: "group_create" },
    "moodle.form.group.update.v1": { toolName: "moodle_update_group", readOnly: false, kind: "group_update" },
    "moodle.form.group.delete.v1": { toolName: "moodle_delete_group", readOnly: false, kind: "group_delete" },
    "moodle.form.group.member.add.v1": { toolName: "moodle_add_group_member", readOnly: false, kind: "member_add" },
    "moodle.form.group.member.remove.v1": { toolName: "moodle_remove_group_member", readOnly: false, kind: "member_remove" },
    "moodle.form.grouping.create.v1": { toolName: "moodle_create_grouping", readOnly: false, kind: "grouping_create" },
    "moodle.form.grouping.update.v1": { toolName: "moodle_update_grouping", readOnly: false, kind: "grouping_update" },
    "moodle.form.grouping.groups.set.v1": { toolName: "moodle_set_grouping_groups", readOnly: false, kind: "grouping_groups" },
    "moodle.ajax.core_courseformat_update_course.cm_groupmode.v1": { toolName: "moodle_set_activity_group_mode", readOnly: false, kind: "activity_group_mode" },
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
  // A native form that refused its own input saved nothing, and Morrow says so
  // instead of reporting an outcome it does not know.
  const refusedByForm = (status) => ({
    ok: false,
    sent: true,
    ...(Number.isInteger(status) ? { status } : {}),
    outcomeUnknown: false,
    verification: { schema: "morrow.browser-verification.v1", status: "mismatch", reason: "moodle_form_validation_failed" },
    error: "moodle_form_validation_failed",
  });
  const id = (value) => (Number.isSafeInteger(value) && value > 0 ? String(value) : ID.test(String(value ?? "")) ? String(value) : "");
  const collapsed = (value, maximum = MAX_NAME_LENGTH) => {
    const text = String(value ?? "").replace(/\s+/g, " ").trim();
    return text && text.length <= maximum && !/[\u0000-\u001f\u007f]/.test(text) ? text : "";
  };
  const stable = (value) => {
    if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
    if (object(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
    return JSON.stringify(value === undefined ? null : value);
  };
  const digest = async (value) => {
    if (!globalThis.crypto?.subtle || typeof globalThis.TextEncoder !== "function") throw new Error("moodle_groups_digest_unavailable");
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
    if (declared !== null && declared !== undefined && (!COUNT.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) return null;
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

  const readDocument = async (context, endpoint, error) => {
    if (!live()) return { error: "moodle_execution_expired" };
    let response;
    try {
      response = await fetch(endpoint, { method: "GET", credentials: "include", cache: "no-store", redirect: "error", headers: { Accept: "text/html" } });
    } catch { return { error }; }
    const html = await boundedText(response, endpoint, context);
    if (typeof html !== "string" || typeof globalThis.DOMParser !== "function") return { error, status: response.status };
    try { return { status: response.status, document: new DOMParser().parseFromString(html, "text/html") }; } catch { return { error, status: response.status }; }
  };
  const readJson = async (context, endpoint, error) => {
    if (!live()) return { error: "moodle_execution_expired" };
    let response;
    try {
      response = await fetch(endpoint, { method: "GET", credentials: "include", cache: "no-store", redirect: "error", headers: { Accept: "application/json" } });
    } catch { return { error }; }
    const raw = await boundedText(response, endpoint, context);
    try { return { status: response.status, value: typeof raw === "string" ? JSON.parse(raw) : null }; } catch { return { error, status: response.status }; }
  };
  const ajax = async (context, methodName, args, write, error) => {
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
    } catch { return write ? { unconfirmed: "moodle_groups_write_unconfirmed" } : { error }; }
    const raw = await boundedText(response, endpoint, context);
    let payload;
    try { payload = typeof raw === "string" ? JSON.parse(raw) : null; } catch { payload = null; }
    const entry = Array.isArray(payload) && payload.length === 1 && object(payload[0]) ? payload[0] : null;
    if (!entry || entry.error !== undefined || entry.exception !== undefined) {
      return write ? { unconfirmed: "moodle_groups_write_unconfirmed", status: response.status } : { error, status: response.status };
    }
    return { data: entry.data, status: response.status };
  };

  /**
   * One native POST, to a fixed route, with a body built only from the form
   * that was just loaded. `expect` is what the native route answers with: its
   * own redirect, or the same page rendered again.
   */
  const post = async (context, action, body, expect, redirectTo, marker = "") => {
    const preflight = currentContext();
    if (!sameContext(context, preflight)) return { error: "moodle_binding_mismatch" };
    if (!live()) return { error: "moodle_execution_expired" };
    let response;
    try {
      dispatched.sent = true;
      response = await fetch(action.href, {
        method: "POST",
        credentials: "include",
        cache: "no-store",
        redirect: "manual",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "text/html" },
        body,
      });
    } catch { return { unconfirmed: "moodle_groups_write_unconfirmed" }; }
    if (!sameContext(context, currentContext())) return { unconfirmed: "moodle_groups_write_unconfirmed", status: response.status };
    if (expect === "page") {
      return response.ok && sameRoute(response.url, action)
        ? { sent: true, status: response.status }
        : { unconfirmed: "moodle_groups_write_unconfirmed", status: response.status };
    }
    // Chromium exposes a manual same-origin POST redirect as opaqueredirect and
    // does not follow it, so the fixed route plus the saved-state readback below
    // is the confirmation.
    if (response.type === "opaqueredirect") return { sent: true };
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      // A native Moodle form that refuses its own input renders itself again
      // instead of redirecting. That is a saved-nothing answer, not an unknown
      // one, so it is reported as the refusal it is and is not retried.
      if (marker && response.ok) {
        const rendered = await boundedText(response, action, context);
        if (typeof rendered === "string" && rendered.includes(`name="${marker}"`)) return { validation: true, status: response.status };
      }
      return { unconfirmed: "moodle_groups_write_unconfirmed", status: response.status };
    }
    let redirect;
    try { redirect = new URL(response.headers.get("location") || "", action); } catch { return { unconfirmed: "moodle_groups_write_unconfirmed", status: response.status }; }
    return redirect.origin === redirectTo.origin && redirect.pathname === redirectTo.pathname
      ? { sent: true, status: response.status }
      : { unconfirmed: "moodle_groups_write_unconfirmed", status: response.status };
  };

  const namedControls = (form, name) => [...form.querySelectorAll("[name]")].filter((control) => control.getAttribute("name") === name);
  const entriesFor = (form) => {
    let values;
    try { values = [...new FormData(form).entries()]; } catch { return null; }
    if (values.length > MAX_FORM_ENTRIES) return null;
    let size = 0;
    const entries = [];
    for (const [name, value] of values) {
      if (typeof name !== "string" || !name || name.length > 255 || typeof value !== "string" || value.length > MAX_VALUE_BYTES) return null;
      size += name.length + value.length;
      if (size > MAX_FORM_BYTES) return null;
      entries.push([name, value]);
    }
    return entries;
  };
  const primarySubmit = (form) => {
    const buttons = [...form.querySelectorAll('input[type="submit"][name], button[type="submit"][name]')]
      .filter((element) => !element.disabled && /^submitbutton(?:[0-9]+)?$/i.test(element.getAttribute("name") || "") && typeof element.value === "string");
    return buttons.length === 1 && buttons[0].value.length <= 500 ? { name: buttons[0].getAttribute("name"), value: buttons[0].value } : null;
  };
  const nativeForm = (documentValue, endpoint) => {
    const matches = [...documentValue.querySelectorAll("form")].filter((form) => {
      if (String(form.getAttribute("method") || "").toLowerCase() !== "post") return false;
      const action = form.getAttribute("action");
      if (action === null) return false;
      try {
        const nativeAction = new URL(action, endpoint);
        return nativeAction.origin === endpoint.origin && nativeAction.pathname === endpoint.pathname
          && !nativeAction.hash && !nativeAction.username && !nativeAction.password;
      } catch { return false; }
    });
    return matches.length === 1 ? matches[0] : null;
  };
  const writableSelect = (form, name, value) => {
    const selects = namedControls(form, name).filter((control) => control.tagName === "SELECT");
    return selects.length === 1 && !selects[0].disabled && !selects[0].multiple
      && [...selects[0].options].some((option) => String(option.value) === value);
  };
  const writableText = (form, name) => {
    const controls = namedControls(form, name);
    const editable = controls.filter((control) => control.tagName === "INPUT"
      && ["", "text"].includes(String(control.getAttribute("type") || "").toLowerCase()));
    return controls.length === 1 && editable.length === 1 && !editable[0].disabled && !editable[0].readOnly;
  };
  // Moodle's advanced checkbox is a hidden control plus the box itself. Both
  // carry the change, so the native form reads it whichever half it takes.
  const writableAdvCheckbox = (form, name) => {
    const controls = namedControls(form, name);
    const boxes = controls.filter((control) => control.tagName === "INPUT"
      && String(control.getAttribute("type") || "").toLowerCase() === "checkbox");
    return controls.length === 2 && boxes.length === 1 && !boxes[0].disabled && boxes[0].value === "1";
  };

  /**
   * The native form of one group or grouping, with the complete control set it
   * would submit, the digest of everything one change does not name, and the
   * bound identity fields that prove the form is the approved target.
   */
  const loadNativeForm = async (context, endpoint, changeable, expected, error, requireSubmit = true) => {
    const page = await readDocument(context, endpoint, error);
    if (page.error) return page;
    const form = nativeForm(page.document, endpoint);
    if (!form) return { error, status: page.status };
    const entries = entriesFor(form);
    if (!entries) return { error, status: page.status };
    const byName = (name) => entries.filter(([entryName]) => entryName === name).map(([, value]) => value);
    const one = (name, value) => { const found = byName(name); return found.length === 1 && found[0] === value; };
    if (!one("sesskey", context.sesskey)) return { error: "moodle_form_session_mismatch", status: page.status };
    for (const [name, accepted] of Object.entries(expected)) {
      if (!(Array.isArray(accepted) ? accepted : [accepted]).some((value) => one(name, value))) return { error, status: page.status };
    }
    const submit = requireSubmit ? primarySubmit(form) : null;
    if (requireSubmit && !submit) return { error, status: page.status };
    const marker = entries.map(([name]) => name).find((name) => name.startsWith("_qf__")) || "";
    const protectedEntries = entries.filter(([name]) => !TRANSIENT_FIELD.test(name) && !DRAFT_FIELD.test(name) && !changeable.has(name));
    if (protectedEntries.some(([, value]) => value === context.sesskey)) return { error, status: page.status };
    return {
      status: page.status,
      state: {
        form,
        entries,
        action: new URL(form.getAttribute("action"), endpoint),
        submit,
        marker,
        protectedDigest: await digest(protectedEntries),
      },
    };
  };
  const formBody = (state, changes) => {
    const body = new URLSearchParams();
    const carried = new Set();
    for (const [name, value] of state.entries) {
      if (changes.has(name)) carried.add(name);
      body.append(name, changes.has(name) ? changes.get(name) : value);
    }
    for (const [name, value] of changes) if (!carried.has(name)) body.append(name, value);
    body.append(state.submit.name, state.submit.value);
    return body;
  };

  /**
   * The course's own group list, from the one core group read Moodle registers
   * for browser AJAX. Descriptions, ID numbers and enrolment keys are dropped.
   */
  const groupList = async (context, courseId) => {
    const response = await ajax(context, GROUP_LIST_METHOD, { courseid: Number(courseId) }, false, "moodle_course_groups_unavailable");
    if (response.error) return response;
    let raw;
    try { raw = typeof response.data === "string" ? JSON.parse(response.data) : response.data; } catch { raw = null; }
    if (!Array.isArray(raw)) return { error: "moodle_course_groups_invalid", status: response.status };
    if (raw.length > MAX_GROUPS) return { incomplete: true, status: response.status };
    const groups = [];
    const seen = new Set();
    for (const entry of raw) {
      const groupId = id(entry?.id);
      const name = collapsed(entry?.name, 1_000);
      const visibility = entry?.visibility;
      if (!groupId || id(entry?.courseid) !== courseId || !name || seen.has(groupId)
        || !Number.isSafeInteger(visibility) || visibility < 0 || visibility > 3
        || typeof entry?.participation !== "boolean") return { error: "moodle_course_groups_invalid", status: response.status };
      seen.add(groupId);
      groups.push({ group_id: groupId, name, visibility, participation: entry.participation });
    }
    groups.sort((left, right) => Number(left.group_id) - Number(right.group_id));
    return { groups, status: response.status };
  };

  /**
   * One group's saved membership, through Moodle's own group-management member
   * route. The identities stay here until a result has to name them.
   */
  const groupMembers = async (context, courseId, groupId) => {
    const endpoint = urlFor(context, GROUP_INDEX_PATH, { id: courseId, group: groupId, action: "ajax_getmembersingroup" });
    const response = await readJson(context, endpoint, "moodle_group_members_unavailable");
    if (response.error) return response;
    if (!Array.isArray(response.value)) return { error: "moodle_group_members_invalid", status: response.status };
    const members = [];
    const seen = new Set();
    for (const role of response.value) {
      if (!object(role) || !Array.isArray(role.users)) return { error: "moodle_group_members_invalid", status: response.status };
      for (const user of role.users) {
        const userId = id(user?.id);
        const name = collapsed(user?.name, 2_000);
        if (!userId || !name || seen.has(userId)) return { error: "moodle_group_members_invalid", status: response.status };
        seen.add(userId);
        members.push({ user_id: userId, name });
        if (members.length > MAX_MEMBERS) return { incomplete: true, status: response.status };
      }
    }
    members.sort((left, right) => Number(left.user_id) - Number(right.user_id));
    return { members, status: response.status };
  };

  /**
   * The complete canonical snapshot returned by moodle_get_course_groups. Raw
   * learner IDs remain inside the browser result until the Gateway projects
   * them through the course roster.
   */
  const courseGroupsState = async (context, courseId) => {
    const listed = await groupList(context, courseId);
    if (listed.error || listed.incomplete) return listed;
    const memberships = new Map();
    let memberCount = 0;
    for (const group of listed.groups) {
      const membership = await groupMembers(context, courseId, group.group_id);
      if (membership.error || membership.incomplete) return membership;
      memberCount += membership.members.length;
      if (memberCount > MAX_MEMBERS) return { incomplete: true, status: membership.status };
      memberships.set(group.group_id, membership.members);
    }
    const data = {
      course_id: courseId,
      groups: listed.groups.map((group) => ({
        id: group.group_id,
        name: group.name,
        visibility: group.visibility,
        participation: group.participation,
        membership: memberships.get(group.group_id) || [],
      })),
    };
    return { groups: listed.groups, memberships, data, status: listed.status, snapshotDigest: await digest(data) };
  };

  /**
   * The user IDs Moodle's own member form offers as candidates for one exact
   * group, and the form itself. A user that form does not offer is not a
   * candidate for this group, whatever the request says, so an addition is
   * refused before anything is sent.
   */
  const memberCandidates = async (context, groupId) => {
    const endpoint = urlFor(context, GROUP_MEMBERS_PATH, { group: groupId });
    const loaded = await loadNativeForm(context, endpoint, new Set(), {}, "moodle_group_member_form_invalid", false);
    if (loaded.error) return loaded;
    const selects = namedControls(loaded.state.form, "addselect[]").filter((control) => control.tagName === "SELECT");
    if (selects.length !== 1) return { error: "moodle_group_member_form_invalid", status: loaded.status };
    const options = [...selects[0].querySelectorAll("option")];
    const valued = options.filter((option) => option.hasAttribute("value"));
    // An empty candidate list is one value-less option under one heading. Moodle
    // writes a second heading instead when it has stopped listing candidates
    // because the course holds more of them than its own user-selector limit
    // (public/user/selector/lib.php too_many_results), and that is not the same
    // statement as "this course has no candidate for this group".
    if (!valued.length) {
      return options.length > 1
        ? { error: "moodle_group_member_list_bounded", status: loaded.status }
        : { status: loaded.status, state: loaded.state, addable: new Set() };
    }
    const ids = valued.map((option) => id(option.getAttribute("value")));
    if (ids.some((value) => !value) || new Set(ids).size !== ids.length) {
      return { error: "moodle_group_member_form_invalid", status: loaded.status };
    }
    return { status: loaded.status, state: loaded.state, addable: new Set(ids) };
  };

  /**
   * Every grouping of the course, from the native groupings page, with the
   * exact group IDs of each one from that grouping's own native assign page.
   */
  const groupingsState = async (context, courseId) => {
    const endpoint = urlFor(context, GROUPINGS_PATH, { id: courseId });
    const page = await readDocument(context, endpoint, "moodle_course_groupings_unavailable");
    if (page.error) return page;
    const tables = [...page.document.querySelectorAll("table")];
    if (tables.length !== 1) return { error: "moodle_course_groupings_invalid", status: page.status };
    const rows = [...tables[0].querySelectorAll("tbody > tr")];
    if (rows.length > MAX_GROUPINGS) return { incomplete: true, status: page.status };
    const linkTarget = (cell, path, expectedSearch) => {
      const found = [...cell.querySelectorAll("a[href]")].map((link) => {
        let target;
        try { target = new URL(link.getAttribute("href"), endpoint); } catch { return ""; }
        if (target.origin !== endpoint.origin || target.pathname !== `${context.basePath}${path}`) return "";
        const params = new URLSearchParams(target.search);
        if ([...params.keys()].length !== Object.keys(expectedSearch).length + 1) return "";
        for (const [name, value] of Object.entries(expectedSearch)) if (params.get(name) !== value) return "";
        return id(params.get("id"));
      }).filter(Boolean);
      return found.length === 1 ? found[0] : "";
    };
    const groupings = [];
    const seen = new Set();
    for (const row of rows) {
      const cells = [...row.querySelectorAll("td")];
      if (cells.length !== 4) return { error: "moodle_course_groupings_invalid", status: page.status };
      const name = collapsed(cells[0].textContent, 1_000);
      const activityCount = String(cells[2].textContent || "").trim();
      const groupingId = linkTarget(cells[3], GROUPING_FORM_PATH, {});
      const assignId = linkTarget(cells[3], GROUPING_ASSIGN_PATH, {});
      if (!name || !COUNT.test(activityCount) || !groupingId || assignId !== groupingId || seen.has(groupingId)) {
        return { error: "moodle_course_groupings_invalid", status: page.status };
      }
      seen.add(groupingId);
      groupings.push({ grouping_id: groupingId, name, activity_count: Number(activityCount) });
    }
    for (const grouping of groupings) {
      const assigned = await groupingGroups(context, grouping.grouping_id);
      if (assigned.error) return { error: assigned.error, status: assigned.status };
      grouping.group_ids = assigned.groupIds;
    }
    groupings.sort((left, right) => Number(left.grouping_id) - Number(right.grouping_id));
    const data = { course_id: courseId, groupings };
    return { data, status: page.status, snapshotDigest: await digest(data) };
  };

  /**
   * One grouping's own native assign page, which is both the group set Moodle
   * holds for it and the route that changes that set.
   */
  const groupingGroups = async (context, groupingId) => {
    const endpoint = urlFor(context, GROUPING_ASSIGN_PATH, { id: groupingId });
    const loaded = await loadNativeForm(context, endpoint, new Set(), {}, "moodle_grouping_assign_form_invalid", false);
    if (loaded.error) return loaded;
    const optionIds = (name) => {
      const selects = namedControls(loaded.state.form, `${name}[]`).filter((control) => control.tagName === "SELECT");
      if (selects.length !== 1) return null;
      const options = [...selects[0].querySelectorAll("option")];
      const valued = options.filter((option) => option.hasAttribute("value"));
      if (!valued.length) return options.length <= 1 ? [] : null;
      // public/group/assign.php writes each option value as "<group id>.".
      const ids = valued.map((option) => id(String(option.getAttribute("value")).replace(/\.$/, "")));
      if (ids.some((value) => !value) || new Set(ids).size !== ids.length || ids.length > MAX_GROUPS) return null;
      return ids;
    };
    const current = optionIds("removeselect");
    const available = optionIds("addselect");
    if (!current || !available) return { error: "moodle_grouping_assign_form_invalid", status: loaded.status };
    if (new Set([...current, ...available]).size !== current.length + available.length) {
      return { error: "moodle_grouping_assign_form_invalid", status: loaded.status };
    }
    return {
      status: loaded.status,
      state: loaded.state,
      groupIds: [...current].sort((left, right) => Number(left) - Number(right)),
    };
  };

  /**
   * The course group setting, from the native course settings form. A course
   * that forces its own group mode overrides every activity's stored value,
   * so an activity group mode is reported against this.
   */
  const courseGroupSetting = async (context, courseId) => {
    const endpoint = urlFor(context, COURSE_FORM_PATH, { id: courseId });
    const page = await readDocument(context, endpoint, "moodle_course_group_setting_unverified");
    if (page.error) return page;
    const form = nativeForm(page.document, endpoint);
    if (!form) return { error: "moodle_course_group_setting_unverified", status: page.status };
    const selected = (name) => {
      const selects = namedControls(form, name).filter((control) => control.tagName === "SELECT");
      if (selects.length !== 1 || selects[0].multiple) return "";
      const chosen = [...selects[0].options].filter((option) => option.selected);
      return chosen.length === 1 ? String(chosen[0].value ?? "") : "";
    };
    const hidden = (name) => {
      const controls = namedControls(form, name).filter((control) => control.tagName === "INPUT");
      return controls.length === 1 ? String(controls[0].value ?? "") : "";
    };
    if (hidden("id") !== courseId) return { error: "moodle_course_group_setting_unverified", status: page.status };
    const mode = selected("groupmode");
    const force = selected("groupmodeforce");
    if (!Object.hasOwn(GROUP_MODES, mode) || (force !== "0" && force !== "1")) {
      return { error: "moodle_course_group_setting_unverified", status: page.status };
    }
    return { status: page.status, mode: Number(mode), forced: force === "1" };
  };

  // The course-state projection and digest of moodle_get_contents, kept
  // identical so one reviewed digest covers that read and this change.
  const redact = (value) => value.replace(/([?&](?:sesskey|token|csrf|password|secret)=)[^&#\s]+/gi, "$1[redacted]");
  const sanitize = (value, depth = 0) => {
    if (depth > 24) return null;
    if (Array.isArray(value)) return value.slice(0, MAX_ITEMS).map((entry) => sanitize(entry, depth + 1));
    if (!object(value)) return typeof value === "string" ? redact(value.slice(0, MAX_RESPONSE_BYTES)) : value;
    const output = {};
    for (const [key, child] of Object.entries(value)) {
      if (TRANSIENT_FIELD.test(key)) continue;
      output[key] = sanitize(child, depth + 1);
    }
    return output;
  };
  const contentData = (value) => ({
    course: sanitize(value.course),
    sections: value.section.map((entry) => sanitize(entry)).slice(0, MAX_ITEMS),
    activities: value.cm.map((entry) => sanitize(entry)).slice(0, MAX_ITEMS),
  });
  // The state's own list order is not part of the course, so both sides of the
  // comparison are put in the same order by id before they are compared.
  const canonical = (data) => {
    const copy = JSON.parse(JSON.stringify(data));
    const unique = (entries) => {
      const seen = new Set();
      for (const entry of entries) {
        const entryId = id(entry?.id);
        if (!entryId || seen.has(entryId)) return false;
        seen.add(entryId);
      }
      return true;
    };
    if (!Array.isArray(copy.sections) || !Array.isArray(copy.activities) || !unique(copy.sections) || !unique(copy.activities)) return null;
    copy.sections.sort((left, right) => Number(id(left.id)) - Number(id(right.id)));
    copy.activities.sort((left, right) => Number(id(left.id)) - Number(id(right.id)));
    return copy;
  };
  const courseState = async (context, courseId) => {
    const response = await ajax(context, STATE_METHOD, { courseid: Number(courseId) }, false, "moodle_course_state_unavailable");
    if (response.error) return response;
    let value;
    try { value = typeof response.data === "string" ? JSON.parse(response.data) : null; } catch { value = null; }
    if (!object(value) || !object(value.course) || id(value.course.id) !== courseId
      || !Array.isArray(value.section) || !Array.isArray(value.cm)) return { error: "moodle_course_state_invalid", status: response.status };
    if (value.section.length > MAX_ITEMS || value.cm.length > MAX_ITEMS) return { error: "moodle_course_state_invalid", status: response.status };
    const state = sanitize(value);
    const data = contentData(state);
    return { state, data, status: response.status, snapshotDigest: await digest(data) };
  };

  const exactKeys = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
  const optionalKeys = (value, required, optional) => object(value)
    && required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
  const writableName = (value) => {
    const name = collapsed(value);
    return name && WRITABLE_NAME.test(name) ? name : "";
  };
  const visibilityOf = (value) => (Number.isSafeInteger(value) && value >= 0 && value <= 3 ? value : null);

  const argumentsFor = (definition, args, binding) => {
    const courseId = id(binding?.courseId);
    if (!courseId || !object(args) || id(args.course_id) !== courseId) return null;
    const base = { courseId };
    if (definition.kind === "groupings_read") {
      return exactKeys(args, ["course_id"]) ? base : null;
    }
    if (definition.kind === "group_create") {
      if (!optionalKeys(args, ["course_id", "name", "expected_digest"], ["visibility", "participation"])) return null;
      const name = writableName(args.name);
      const visibility = Object.hasOwn(args, "visibility") ? visibilityOf(args.visibility) : undefined;
      if (!name || visibility === null || !DIGEST.test(String(args.expected_digest || ""))
        || (Object.hasOwn(args, "participation") && typeof args.participation !== "boolean")) return null;
      return { ...base, name, expectedDigest: args.expected_digest, ...(visibility === undefined ? {} : { visibility }), ...(Object.hasOwn(args, "participation") ? { participation: args.participation } : {}) };
    }
    if (definition.kind === "group_update") {
      if (!optionalKeys(args, ["course_id", "group_id", "expected_group_name", "expected_digest"], ["name", "visibility", "participation"])) return null;
      const groupId = id(args.group_id);
      const expectedName = collapsed(args.expected_group_name, 1_000);
      const name = Object.hasOwn(args, "name") ? writableName(args.name) : undefined;
      const visibility = Object.hasOwn(args, "visibility") ? visibilityOf(args.visibility) : undefined;
      if (!groupId || !expectedName || name === "" || visibility === null || !DIGEST.test(String(args.expected_digest || ""))
        || (Object.hasOwn(args, "participation") && typeof args.participation !== "boolean")
        || (name === undefined && visibility === undefined && !Object.hasOwn(args, "participation"))) return null;
      return {
        ...base, groupId, expectedName, expectedDigest: args.expected_digest,
        ...(name === undefined ? {} : { name }),
        ...(visibility === undefined ? {} : { visibility }),
        ...(Object.hasOwn(args, "participation") ? { participation: args.participation } : {}),
      };
    }
    if (definition.kind === "group_delete") {
      if (!exactKeys(args, ["course_id", "group_id", "expected_group_name", "expected_member_count", "expected_digest"])) return null;
      const groupId = id(args.group_id);
      const expectedName = collapsed(args.expected_group_name, 1_000);
      const expectedMembers = Number.isSafeInteger(args.expected_member_count) && args.expected_member_count >= 0
        && args.expected_member_count <= MAX_MEMBERS ? args.expected_member_count : null;
      return groupId && expectedName && expectedMembers !== null && DIGEST.test(String(args.expected_digest || ""))
        ? { ...base, groupId, expectedName, expectedMembers, expectedDigest: args.expected_digest } : null;
    }
    if (definition.kind === "member_add" || definition.kind === "member_remove") {
      if (!exactKeys(args, ["course_id", "group_id", "expected_group_name", "user_id", "expected_digest"])) return null;
      const groupId = id(args.group_id);
      const expectedName = collapsed(args.expected_group_name, 1_000);
      const userId = id(args.user_id);
      return groupId && expectedName && userId && DIGEST.test(String(args.expected_digest || ""))
        ? { ...base, groupId, expectedName, userId, expectedDigest: args.expected_digest } : null;
    }
    if (definition.kind === "grouping_create") {
      if (!exactKeys(args, ["course_id", "name", "expected_digest"])) return null;
      const name = writableName(args.name);
      return name && DIGEST.test(String(args.expected_digest || "")) ? { ...base, name, expectedDigest: args.expected_digest } : null;
    }
    if (definition.kind === "grouping_update") {
      if (!exactKeys(args, ["course_id", "grouping_id", "name", "expected_digest"])) return null;
      const groupingId = id(args.grouping_id);
      const name = writableName(args.name);
      return groupingId && name && DIGEST.test(String(args.expected_digest || ""))
        ? { ...base, groupingId, name, expectedDigest: args.expected_digest } : null;
    }
    if (definition.kind === "grouping_groups") {
      if (!exactKeys(args, ["course_id", "grouping_id", "group_ids", "expected_digest"])) return null;
      const groupingId = id(args.grouping_id);
      if (!groupingId || !Array.isArray(args.group_ids) || args.group_ids.length > MAX_GROUPS
        || !DIGEST.test(String(args.expected_digest || ""))) return null;
      const groupIds = args.group_ids.map((value) => id(value));
      if (groupIds.some((value) => !value) || new Set(groupIds).size !== groupIds.length) return null;
      return { ...base, groupingId, groupIds: groupIds.sort((left, right) => Number(left) - Number(right)), expectedDigest: args.expected_digest };
    }
    if (definition.kind === "activity_group_mode") {
      if (!exactKeys(args, ["course_id", "module_id", "group_mode", "expected_digest"])) return null;
      const moduleId = id(args.module_id);
      const groupMode = Number.isSafeInteger(args.group_mode) && Object.hasOwn(GROUP_MODES, args.group_mode) ? args.group_mode : null;
      return moduleId && groupMode !== null && DIGEST.test(String(args.expected_digest || ""))
        ? { ...base, moduleId, groupMode, expectedDigest: args.expected_digest } : null;
    }
    return null;
  };

  const groupProof = (extra = {}) => ({
    method: "native_group_form",
    required_capability: "moodle/course:managegroups",
    scope: "one_group_in_the_approved_course",
    reversible_by_morrow: false,
    ...extra,
  });
  const groupOf = (groups, groupId) => groups.find((entry) => entry.group_id === groupId) || null;
  const otherGroups = (groups, groupId) => groups.filter((entry) => entry.group_id !== groupId);
  const otherGroupings = (groupings, groupingId) => groupings.filter((entry) => entry.grouping_id !== groupingId);
  const publicGroup = (group) => ({
    group_id: group.group_id,
    name: group.name,
    visibility: group.visibility,
    visibility_meaning: VISIBILITY_LABELS[group.visibility],
    participation: group.participation,
  });

  /**
   * The group list, read again and compared as a whole: the approved change is
   * the only difference between the list before and the list after.
   */
  const listAfter = async (context, courseId, posted, expected) => {
    const after = await groupList(context, courseId);
    if (after.error || after.incomplete) return { unconfirmed: "moodle_groups_readback_unconfirmed", status: posted.status };
    return stable(expected(after.groups)) === stable(after.groups) ? { groups: after.groups, status: posted.status ?? after.status } : null;
  };

  const runGroupCreate = async (context, args) => {
    let before = await groupList(context, args.courseId);
    if (before.error) return failure(before.error, before.status);
    if (before.incomplete) return failure("moodle_course_groups_incomplete", before.status);
    if (before.groups.some((entry) => entry.name === args.name)) return failure("moodle_group_name_taken", before.status);
    const endpoint = urlFor(context, GROUP_FORM_PATH, { courseid: args.courseId });
    const changeable = new Set(["name", ...(args.visibility === undefined ? [] : ["visibility"]), ...(args.participation === undefined ? [] : ["participation"])]);
    // A new group's hidden id control carries no value yet.
    const loaded = await loadNativeForm(context, endpoint, changeable, { courseid: args.courseId, id: ["", "0"] }, "moodle_group_form_invalid");
    if (loaded.error) return failure(loaded.error, loaded.status);
    const state = loaded.state;
    if (!writableText(state.form, "name")) return failure("moodle_group_form_invalid", loaded.status);
    const changes = new Map([["name", args.name]]);
    if (args.visibility !== undefined) {
      if (!writableSelect(state.form, "visibility", String(args.visibility))) return failure("moodle_group_visibility_locked", loaded.status);
      changes.set("visibility", String(args.visibility));
    }
    if (args.participation !== undefined) {
      if (!writableAdvCheckbox(state.form, "participation")) return failure("moodle_group_visibility_locked", loaded.status);
      changes.set("participation", args.participation ? "1" : "0");
    }
    const reviewed = await courseGroupsState(context, args.courseId);
    if (reviewed.error) return failure(reviewed.error, reviewed.status);
    if (reviewed.incomplete) return failure("moodle_course_groups_incomplete", reviewed.status);
    if (reviewed.snapshotDigest !== args.expectedDigest) return failure("moodle_expected_digest_mismatch", reviewed.status);
    if (reviewed.groups.some((entry) => entry.name === args.name)) return failure("moodle_group_name_taken", reviewed.status);
    before = { groups: reviewed.groups, status: reviewed.status };
    const posted = await post(context, state.action, formBody(state, changes), "redirect", urlFor(context, GROUP_INDEX_PATH, { id: args.courseId }), state.marker);
    if (posted.error) return failure(posted.error, posted.status);
    if (posted.validation) return refusedByForm(posted.status);
    if (posted.unconfirmed) return unconfirmedWrite(posted.unconfirmed, posted.status);
    const after = await groupList(context, args.courseId);
    if (after.error || after.incomplete) return unconfirmedWrite("moodle_groups_readback_unconfirmed", posted.status);
    const known = new Set(before.groups.map((entry) => entry.group_id));
    const added = after.groups.filter((entry) => !known.has(entry.group_id));
    const carried = after.groups.filter((entry) => known.has(entry.group_id));
    if (added.length !== 1 || added[0].name !== args.name || stable(carried) !== stable(before.groups)
      || (args.visibility !== undefined && added[0].visibility !== args.visibility)
      || (args.participation !== undefined && added[0].participation !== args.participation)) {
      return unconfirmedWrite("moodle_group_write_not_verified", posted.status);
    }
    return {
      ok: true,
      sent: true,
      status: posted.status ?? after.status,
      data: { course_id: args.courseId, group: publicGroup(added[0]), groups: after.groups.map(publicGroup) },
      proof: groupProof({ route: GROUP_FORM_PATH, action: "create" }),
      verification: { schema: "morrow.browser-verification.v1", status: "verified" },
    };
  };

  const runGroupUpdate = async (context, args) => {
    let before = await groupList(context, args.courseId);
    if (before.error) return failure(before.error, before.status);
    if (before.incomplete) return failure("moodle_course_groups_incomplete", before.status);
    let target = groupOf(before.groups, args.groupId);
    if (!target) return failure("moodle_group_absent", before.status);
    if (target.name !== args.expectedName) return failure("moodle_expected_group_name_mismatch", before.status);
    if (args.name !== undefined && before.groups.some((entry) => entry.group_id !== args.groupId && entry.name === args.name)) {
      return failure("moodle_group_name_taken", before.status);
    }
    const endpoint = urlFor(context, GROUP_FORM_PATH, { id: args.groupId });
    const changeable = new Set([
      ...(args.name === undefined ? [] : ["name"]),
      ...(args.visibility === undefined ? [] : ["visibility"]),
      ...(args.participation === undefined ? [] : ["participation"]),
    ]);
    const loaded = await loadNativeForm(context, endpoint, changeable, { courseid: args.courseId, id: args.groupId }, "moodle_group_form_invalid");
    if (loaded.error) return failure(loaded.error, loaded.status);
    const state = loaded.state;
    const changes = new Map();
    if (args.name !== undefined) {
      if (!writableText(state.form, "name")) return failure("moodle_group_form_invalid", loaded.status);
      changes.set("name", args.name);
    }
    // Moodle freezes both controls once the group has a member, which is the
    // form's own statement that its hidden-membership setting is now fixed.
    if (args.visibility !== undefined) {
      if (!writableSelect(state.form, "visibility", String(args.visibility))) return failure("moodle_group_visibility_locked", loaded.status);
      changes.set("visibility", String(args.visibility));
    }
    if (args.participation !== undefined) {
      if (!writableAdvCheckbox(state.form, "participation")) return failure("moodle_group_visibility_locked", loaded.status);
      changes.set("participation", args.participation ? "1" : "0");
    }
    const reviewed = await courseGroupsState(context, args.courseId);
    if (reviewed.error) return failure(reviewed.error, reviewed.status);
    if (reviewed.incomplete) return failure("moodle_course_groups_incomplete", reviewed.status);
    if (reviewed.snapshotDigest !== args.expectedDigest) return failure("moodle_expected_digest_mismatch", reviewed.status);
    const reviewedTarget = groupOf(reviewed.groups, args.groupId);
    if (!reviewedTarget || reviewedTarget.name !== args.expectedName) return failure("moodle_expected_group_name_mismatch", reviewed.status);
    if (args.name !== undefined && reviewed.groups.some((entry) => entry.group_id !== args.groupId && entry.name === args.name)) {
      return failure("moodle_group_name_taken", reviewed.status);
    }
    before = { groups: reviewed.groups, status: reviewed.status };
    target = reviewedTarget;
    const posted = await post(context, state.action, formBody(state, changes), "redirect", urlFor(context, GROUP_INDEX_PATH, { id: args.courseId }), state.marker);
    if (posted.error) return failure(posted.error, posted.status);
    if (posted.validation) return refusedByForm(posted.status);
    if (posted.unconfirmed) return unconfirmedWrite(posted.unconfirmed, posted.status);
    const saved = {
      ...target,
      ...(args.name === undefined ? {} : { name: args.name }),
      ...(args.visibility === undefined ? {} : { visibility: args.visibility }),
      ...(args.participation === undefined ? {} : { participation: args.participation }),
    };
    const verified = await listAfter(context, args.courseId, posted, () => [...otherGroups(before.groups, args.groupId), saved]
      .sort((left, right) => Number(left.group_id) - Number(right.group_id)));
    if (!verified) return unconfirmedWrite("moodle_group_write_not_verified", posted.status);
    if (verified.unconfirmed) return unconfirmedWrite(verified.unconfirmed, verified.status);
    // Every control the change did not name has to come back the way it was.
    const reloaded = await loadNativeForm(context, endpoint, changeable, { courseid: args.courseId, id: args.groupId }, "moodle_group_form_invalid");
    if (reloaded.error) return unconfirmedWrite("moodle_groups_readback_unconfirmed", posted.status);
    if (reloaded.state.protectedDigest !== state.protectedDigest) return unconfirmedWrite("moodle_group_write_not_verified", posted.status);
    return {
      ok: true,
      sent: true,
      status: verified.status,
      data: { course_id: args.courseId, group: publicGroup(saved), groups: verified.groups.map(publicGroup) },
      proof: groupProof({ route: GROUP_FORM_PATH, action: "update", protected_settings_digest: state.protectedDigest }),
      verification: { schema: "morrow.browser-verification.v1", status: "verified" },
    };
  };

  const runGroupDelete = async (context, args) => {
    const reviewed = await courseGroupsState(context, args.courseId);
    if (reviewed.error) return failure(reviewed.error, reviewed.status);
    if (reviewed.incomplete) return failure("moodle_course_groups_incomplete", reviewed.status);
    if (reviewed.snapshotDigest !== args.expectedDigest) return failure("moodle_expected_digest_mismatch", reviewed.status);
    const before = { groups: reviewed.groups, status: reviewed.status };
    let target = groupOf(before.groups, args.groupId);
    if (!target) return failure("moodle_group_absent", before.status);
    if (target.name !== args.expectedName) return failure("moodle_expected_group_name_mismatch", before.status);
    const membership = { members: reviewed.memberships.get(args.groupId) || [], status: reviewed.status };
    // The approval named a membership. A deletion that would take a different
    // set of learners with it is not the approved deletion.
    if (membership.members.length !== args.expectedMembers) return failure("moodle_expected_member_count_mismatch", membership.status);
    const action = urlFor(context, GROUP_DELETE_PATH, {});
    const body = new URLSearchParams({ courseid: args.courseId, groups: args.groupId, sesskey: context.sesskey, confirm: "1" });
    const posted = await post(context, action, body, "redirect", urlFor(context, GROUP_INDEX_PATH, { id: args.courseId }));
    if (posted.error) return failure(posted.error, posted.status);
    if (posted.unconfirmed) return unconfirmedWrite(posted.unconfirmed, posted.status);
    const verified = await listAfter(context, args.courseId, posted, () => otherGroups(before.groups, args.groupId));
    if (!verified) return unconfirmedWrite("moodle_group_write_not_verified", posted.status);
    if (verified.unconfirmed) return unconfirmedWrite(verified.unconfirmed, verified.status);
    return {
      ok: true,
      sent: true,
      status: verified.status,
      data: {
        course_id: args.courseId,
        deleted_group: publicGroup(target),
        removed_members: membership.members,
        groups: verified.groups.map(publicGroup),
      },
      proof: groupProof({
        route: GROUP_DELETE_PATH,
        action: "delete",
        removes: GROUP_REMOVALS,
        members_removed: membership.members.length,
        learner_records_removed: membership.members.length > 0,
      }),
      verification: { schema: "morrow.browser-verification.v1", status: "verified" },
    };
  };

  const runMemberChange = async (context, definition, args) => {
    const adding = definition.kind === "member_add";
    let before = await groupList(context, args.courseId);
    if (before.error) return failure(before.error, before.status);
    if (before.incomplete) return failure("moodle_course_groups_incomplete", before.status);
    let target = groupOf(before.groups, args.groupId);
    if (!target) return failure("moodle_group_absent", before.status);
    if (target.name !== args.expectedName) return failure("moodle_expected_group_name_mismatch", before.status);
    let membership = await groupMembers(context, args.courseId, args.groupId);
    if (membership.error) return failure(membership.error, membership.status);
    if (membership.incomplete) return failure("moodle_course_groups_incomplete", membership.status);
    let present = membership.members.find((entry) => entry.user_id === args.userId) || null;
    if (adding && present) return failure("moodle_group_member_already_present", membership.status);
    if (!adding && !present) return failure("moodle_group_member_absent", membership.status);
    // Adding binds the identity through Moodle's own candidate list for this
    // exact group, so an identity that list does not offer is refused before
    // anything is sent. Removing binds it through the saved membership above,
    // which is the complete list and is not capped.
    const candidates = await memberCandidates(context, args.groupId);
    if (candidates.error) return failure(candidates.error, candidates.status);
    if (adding && !candidates.addable.has(args.userId)) return failure("moodle_group_member_not_available", candidates.status);
    const state = candidates.state;
    const reviewed = await courseGroupsState(context, args.courseId);
    if (reviewed.error) return failure(reviewed.error, reviewed.status);
    if (reviewed.incomplete) return failure("moodle_course_groups_incomplete", reviewed.status);
    if (reviewed.snapshotDigest !== args.expectedDigest) return failure("moodle_expected_digest_mismatch", reviewed.status);
    const reviewedTarget = groupOf(reviewed.groups, args.groupId);
    if (!reviewedTarget || reviewedTarget.name !== args.expectedName) return failure("moodle_expected_group_name_mismatch", reviewed.status);
    membership = { members: reviewed.memberships.get(args.groupId) || [], status: reviewed.status };
    const reviewedPresent = membership.members.find((entry) => entry.user_id === args.userId) || null;
    if (adding && reviewedPresent) return failure("moodle_group_member_already_present", reviewed.status);
    if (!adding && !reviewedPresent) return failure("moodle_group_member_absent", reviewed.status);
    before = { groups: reviewed.groups, status: reviewed.status };
    target = reviewedTarget;
    present = reviewedPresent;
    // The member form saves from three controls only: the session key it was
    // loaded with, the one user, and Moodle's own add or remove button.
    const body = new URLSearchParams();
    for (const [name, value] of state.entries) if (name === "sesskey") body.append(name, value);
    body.append(adding ? "addselect[]" : "removeselect[]", args.userId);
    body.append(adding ? "add" : "remove", "1");
    const posted = await post(context, state.action, body, "page");
    if (posted.error) return failure(posted.error, posted.status);
    if (posted.unconfirmed) return unconfirmedWrite(posted.unconfirmed, posted.status);
    const after = await groupMembers(context, args.courseId, args.groupId);
    if (after.error || after.incomplete) return unconfirmedWrite("moodle_groups_readback_unconfirmed", posted.status);
    const expectedMembers = adding
      ? [...membership.members, { user_id: args.userId, name: "" }].map((entry) => entry.user_id).sort((left, right) => Number(left) - Number(right))
      : membership.members.filter((entry) => entry.user_id !== args.userId).map((entry) => entry.user_id);
    if (stable(after.members.map((entry) => entry.user_id)) !== stable(expectedMembers)) {
      return unconfirmedWrite("moodle_group_write_not_verified", posted.status);
    }
    const listVerified = await listAfter(context, args.courseId, posted, () => before.groups);
    if (!listVerified) return unconfirmedWrite("moodle_group_write_not_verified", posted.status);
    if (listVerified.unconfirmed) return unconfirmedWrite(listVerified.unconfirmed, listVerified.status);
    const member = adding
      ? after.members.find((entry) => entry.user_id === args.userId) || { user_id: args.userId }
      : present;
    return {
      ok: true,
      sent: true,
      status: listVerified.status,
      data: {
        course_id: args.courseId,
        group: publicGroup(target),
        member,
        member_count: after.members.length,
      },
      proof: groupProof({
        route: GROUP_MEMBERS_PATH,
        action: adding ? "add_member" : "remove_member",
        // Membership does not change who can see the group or its members.
        group_visibility: target.visibility,
        group_visibility_meaning: VISIBILITY_LABELS[target.visibility],
      }),
      verification: { schema: "morrow.browser-verification.v1", status: "verified" },
    };
  };

  const groupingProof = (extra = {}) => ({
    method: "native_grouping_form",
    required_capability: "moodle/course:managegroups",
    scope: "one_grouping_in_the_approved_course",
    reversible_by_morrow: false,
    ...extra,
  });

  const runGroupingWrite = async (context, definition, args) => {
    const before = await groupingsState(context, args.courseId);
    if (before.error) return failure(before.error, before.status);
    if (before.incomplete) return failure("moodle_course_groupings_incomplete", before.status);
    if (before.snapshotDigest !== args.expectedDigest) return failure("moodle_expected_digest_mismatch", before.status);
    const groupings = before.data.groupings;
    const target = definition.kind === "grouping_create" ? null : groupings.find((entry) => entry.grouping_id === args.groupingId) || null;
    if (definition.kind !== "grouping_create" && !target) return failure("moodle_grouping_absent", before.status);
    if (definition.kind !== "grouping_groups" && groupings.some((entry) => entry.grouping_id !== args.groupingId && entry.name === args.name)) {
      return failure("moodle_grouping_name_taken", before.status);
    }

    let posted;
    let expected;
    if (definition.kind === "grouping_groups") {
      const available = await groupList(context, args.courseId);
      if (available.error) return failure(available.error, available.status);
      if (available.incomplete) return failure("moodle_course_groups_incomplete", available.status);
      const courseGroups = new Set(available.groups.map((entry) => entry.group_id));
      if (args.groupIds.some((groupId) => !courseGroups.has(groupId))) return failure("moodle_group_absent", available.status);
      const held = new Set(target.group_ids);
      const additions = args.groupIds.filter((groupId) => !held.has(groupId));
      const removals = target.group_ids.filter((groupId) => !args.groupIds.includes(groupId));
      if (!additions.length && !removals.length) return failure("moodle_grouping_groups_unchanged", before.status);
      // The native grouping form adds or removes in one submission, never both,
      // and Morrow sends one POST, so a set that needs both is two changes.
      if (additions.length && removals.length) return failure("moodle_grouping_groups_two_directions", before.status);
      const assign = await groupingGroups(context, args.groupingId);
      if (assign.error) return failure(assign.error, assign.status);
      if (stable(assign.groupIds) !== stable(target.group_ids)) return failure("moodle_expected_digest_mismatch", assign.status);
      const body = new URLSearchParams();
      for (const [name, value] of assign.state.entries) if (name === "sesskey") body.append(name, value);
      for (const groupId of additions.length ? additions : removals) body.append(additions.length ? "addselect[]" : "removeselect[]", groupId);
      body.append(additions.length ? "add" : "remove", "1");
      posted = await post(context, assign.state.action, body, "page");
      expected = () => [...otherGroupings(groupings, args.groupingId), { ...target, group_ids: args.groupIds }]
        .sort((left, right) => Number(left.grouping_id) - Number(right.grouping_id));
    } else {
      const endpoint = definition.kind === "grouping_create"
        ? urlFor(context, GROUPING_FORM_PATH, { courseid: args.courseId })
        : urlFor(context, GROUPING_FORM_PATH, { id: args.groupingId });
      const bound = definition.kind === "grouping_create" ? { courseid: args.courseId, id: ["", "0"] } : { courseid: args.courseId, id: args.groupingId };
      const loaded = await loadNativeForm(context, endpoint, new Set(["name"]), bound, "moodle_grouping_form_invalid");
      if (loaded.error) return failure(loaded.error, loaded.status);
      if (!writableText(loaded.state.form, "name")) return failure("moodle_grouping_form_invalid", loaded.status);
      posted = await post(context, loaded.state.action, formBody(loaded.state, new Map([["name", args.name]])), "redirect", urlFor(context, GROUPINGS_PATH, { id: args.courseId }), loaded.state.marker);
      expected = definition.kind === "grouping_update"
        ? () => [...otherGroupings(groupings, args.groupingId), { ...target, name: args.name }]
          .sort((left, right) => Number(left.grouping_id) - Number(right.grouping_id))
        : null;
    }
    if (posted.error) return failure(posted.error, posted.status);
    if (posted.validation) return refusedByForm(posted.status);
    if (posted.unconfirmed) return unconfirmedWrite(posted.unconfirmed, posted.status);

    const after = await groupingsState(context, args.courseId);
    if (after.error || after.incomplete) return unconfirmedWrite("moodle_groupings_readback_unconfirmed", posted.status);
    const saved = after.data.groupings;
    let created = null;
    if (definition.kind === "grouping_create") {
      const known = new Set(groupings.map((entry) => entry.grouping_id));
      const added = saved.filter((entry) => !known.has(entry.grouping_id));
      const carried = saved.filter((entry) => known.has(entry.grouping_id));
      if (added.length !== 1 || added[0].name !== args.name || added[0].activity_count !== 0
        || added[0].group_ids.length !== 0 || stable(carried) !== stable(groupings)) {
        return unconfirmedWrite("moodle_grouping_write_not_verified", posted.status);
      }
      created = added[0];
    } else if (stable(expected(saved)) !== stable(saved)) {
      return unconfirmedWrite("moodle_grouping_write_not_verified", posted.status);
    }
    return {
      ok: true,
      sent: true,
      status: posted.status ?? after.status,
      data: {
        ...after.data,
        grouping: created || saved.find((entry) => entry.grouping_id === args.groupingId),
      },
      snapshot_digest: after.snapshotDigest,
      proof: groupingProof({
        route: definition.kind === "grouping_groups" ? GROUPING_ASSIGN_PATH : GROUPING_FORM_PATH,
        action: definition.kind === "grouping_create" ? "create" : definition.kind === "grouping_update" ? "update" : "set_groups",
      }),
      verification: { schema: "morrow.browser-verification.v1", status: "verified" },
    };
  };

  const runActivityGroupMode = async (context, args) => {
    const setting = await courseGroupSetting(context, args.courseId);
    if (setting.error) return failure(setting.error, setting.status);
    const before = await courseState(context, args.courseId);
    if (before.error) return failure(before.error, before.status);
    if (before.snapshotDigest !== args.expectedDigest) return failure("moodle_expected_digest_mismatch", before.status);
    const activity = before.state.cm.find((entry) => id(entry?.id) === args.moduleId) || null;
    if (!activity) return failure("moodle_activity_absent", before.status);
    if (!Number.isSafeInteger(activity.groupmode) || !Object.hasOwn(GROUP_MODES, activity.groupmode)) {
      return failure("moodle_activity_group_mode_invalid", before.status);
    }
    if (activity.groupmode === args.groupMode) return failure("moodle_activity_group_mode_unchanged", before.status);

    const rechecked = currentContext();
    if (!sameContext(context, rechecked) || !boundContext(rechecked)) return failure("moodle_binding_mismatch");
    const fresh = await courseState(rechecked, args.courseId);
    if (fresh.error) return failure(fresh.error, fresh.status);
    if (fresh.snapshotDigest !== args.expectedDigest) return failure("moodle_expected_digest_mismatch", fresh.status);
    const freshSetting = await courseGroupSetting(rechecked, args.courseId);
    if (freshSetting.error) return failure(freshSetting.error, freshSetting.status);
    if (freshSetting.forced !== setting.forced || freshSetting.mode !== setting.mode) {
      return failure("moodle_course_group_setting_changed", freshSetting.status);
    }

    const update = await ajax(rechecked, UPDATE_METHOD, {
      action: GROUP_MODES[args.groupMode].action,
      courseid: Number(args.courseId),
      ids: [Number(args.moduleId)],
      targetsectionid: null,
      targetcmid: null,
    }, true, "moodle_activity_group_mode_unavailable");
    if (update.error) return failure(update.error, update.status);
    if (update.unconfirmed) return unconfirmedWrite(update.unconfirmed, update.status);

    const after = await courseState(rechecked, args.courseId);
    if (after.error) return unconfirmedWrite("moodle_course_state_readback_unconfirmed", update.status);
    const expected = canonical(fresh.data);
    const saved = canonical(after.data);
    const planned = expected?.activities.find((entry) => id(entry?.id) === args.moduleId);
    if (!expected || !saved || !planned) return unconfirmedWrite("moodle_activity_group_mode_not_verified", update.status);
    planned.groupmode = args.groupMode;
    if (stable(expected) !== stable(saved)) return unconfirmedWrite("moodle_activity_group_mode_not_verified", update.status);
    const effective = setting.forced ? setting.mode : args.groupMode;
    return {
      ok: true,
      sent: true,
      status: update.status ?? after.status,
      data: {
        course_id: args.courseId,
        module_id: args.moduleId,
        group_mode: args.groupMode,
        group_mode_meaning: GROUP_MODES[args.groupMode].label,
        course_forces_group_mode: setting.forced,
        effective_group_mode: effective,
        effective_group_mode_meaning: GROUP_MODES[effective].label,
      },
      snapshot_digest: after.snapshotDigest,
      proof: {
        method: "native_course_state_action",
        action: GROUP_MODES[args.groupMode].action,
        route: AJAX_PATH,
        required_capability: "moodle/course:manageactivities",
        scope: "one_activity_in_the_approved_course",
        reversible_by_morrow: false,
        // A course that forces its own group mode overrides the saved activity
        // value, so the saved value is not what learners get.
        saved_value_in_effect: !setting.forced,
      },
      verification: { schema: "morrow.browser-verification.v1", status: "verified" },
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
    const args = argumentsFor(definition, input.arguments, input.binding);
    if (!args) return failure("moodle_groups_arguments_invalid");

    if (definition.kind === "groupings_read") {
      const state = await groupingsState(context, args.courseId);
      if (state.error) return failure(state.error, state.status);
      if (state.incomplete) return failure("moodle_course_groupings_incomplete", state.status);
      return {
        ok: true,
        sent: false,
        complete: true,
        status: state.status,
        data: {
          ...state.data,
          proof: {
            method: "native_groupings_page",
            route: GROUPINGS_PATH,
            required_capability: "moodle/course:managegroups",
            scope: "every_grouping_of_the_approved_course",
          },
        },
        snapshot_digest: state.snapshotDigest,
      };
    }
    if (definition.kind === "group_create") return await runGroupCreate(context, args);
    if (definition.kind === "group_update") return await runGroupUpdate(context, args);
    if (definition.kind === "group_delete") return await runGroupDelete(context, args);
    if (definition.kind === "member_add" || definition.kind === "member_remove") return await runMemberChange(context, definition, args);
    if (definition.kind === "activity_group_mode") return await runActivityGroupMode(context, args);
    return await runGroupingWrite(context, definition, args);
  } catch (error) {
    if (dispatched.sent) return unconfirmedWrite("moodle_groups_write_unconfirmed");
    const message = String(error?.message || error);
    return failure(message.startsWith("moodle_") ? message : "moodle_groups_execution_failed");
  }
}
