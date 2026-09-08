/**
 * The enrolment and role writes of one exact Moodle course: enrol one person
 * through the course's own manual enrolment method, suspend one enrolment,
 * unenrol one person, and assign or remove one role.
 *
 * Enrolment and role assignment are two different things in Moodle, and they
 * stay two different things here. An enrolment decides whether a person is in
 * the course at all. A role assignment decides what they can do in it. Each of
 * the five operations is its own catalog action with its own approval, and none
 * of them changes the other concept as a side effect: the enrolment gives the
 * role the site's own manual enrolment method is set to give, and the two role
 * writes change no enrolment.
 *
 * Every write binds the learner through the course participant roster. The
 * Moodle user ID reaches this function, the participants table is read in this
 * page world, and the write is refused unless that ID is exactly one row of
 * that table. `moodle_enrol_participant` is the one write whose person is not
 * on the roster yet, so it binds against the candidate list Moodle's own manual
 * enrolment page offers for this exact course, and refuses unless that list
 * holds the ID exactly once. No name, email address, profile link, or any other
 * identity text leaves this function, for the target or for anyone else in the
 * course.
 *
 * The routes are the ones the site's own controls use.
 * - Enrol: one POST of the native manual enrolment page,
 *   https://github.com/moodle/moodle/blob/v5.2.2/public/enrol/manual/manage.php
 *   found from this course's own enrolment methods page,
 *   https://github.com/moodle/moodle/blob/v5.2.2/public/enrol/instances.php
 * - Suspend: one POST of the native enrolment editing form,
 *   https://github.com/moodle/moodle/blob/v5.2.2/public/enrol/editenrolment.php
 * - Unenrol: one POST of the confirmation Moodle itself renders at
 *   https://github.com/moodle/moodle/blob/v5.2.2/public/enrol/unenroluser.php
 * - Role writes: one core_update_inplace_editable call for the core_role
 *   user_roles editable, the route the participants page's own role control
 *   uses.
 *   https://github.com/moodle/moodle/blob/v5.2.2/public/user/classes/output/user_roles_editable.php
 *
 * Six rules hold for all five operations.
 *
 * 1. The reviewed state is the complete participant list `moodle_get_course_participants`
 *    returns, rebuilt here in exactly that shape, so the digest a person
 *    reviewed and the digest this executor compares are the same value.
 * 2. The list is read again immediately before the dispatch and must still be
 *    the reviewed one, so nothing is sent against a roster that moved.
 * 3. Exactly one native request is sent. It is never sent twice, and a lost
 *    response is reported as applied but unconfirmed.
 * 4. The participant record is read back afterwards and must hold exactly the
 *    approved change. Every other participant must come back unchanged.
 * 5. A role write sends the complete role list Moodle's own control sends, so
 *    it is built from the roles that control offers and refuses when the person
 *    holds a role the principal cannot assign, because Morrow cannot rewrite a
 *    list it cannot state.
 * 6. Moodle keeps a role that the enrolment method granted and protects. That
 *    removal cannot be sent as anything else, so `moodle_remove_role` reports
 *    the result as unconfirmed with the role still in place, and nothing is
 *    sent again.
 *
 * Chrome serializes this function for a MAIN-world injection. Keep every
 * dependency inside the function body.
 */
export async function executeMoodleEnrolmentInPage(rawInput) {
  const PROVIDER = "moodle";
  const SCHEMA = "morrow.moodle-enrolment-write.v1";
  const PARTICIPANTS_SCHEMA = "morrow.moodle-course-participants.v1";
  const AJAX_PATH = "/lib/ajax/service.php";
  const TABLE_METHOD = "core_table_get_dynamic_table_content";
  const ROLE_METHOD = "core_update_inplace_editable";
  const INSTANCES_PATH = "/enrol/instances.php";
  const MANUAL_MANAGE_PATH = "/enrol/manual/manage.php";
  const EDIT_ENROLMENT_PATH = "/enrol/editenrolment.php";
  const UNENROL_PATH = "/enrol/unenroluser.php";
  const ROLE_COMPONENT = "core_role";
  const ROLE_ITEMTYPE = "user_roles";
  // The two capabilities the participants table itself needs. Moodle renders
  // the enrolment column only for a principal who holds the second one, and
  // every one of these writes reads that column.
  const READ_CAPABILITIES = ["moodle/course:viewparticipants", "moodle/course:enrolreview"];
  // The bounds of the participant list read, kept identical to
  // connector/extension/src/moodle-participants-read.js so the digest matches.
  const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
  const PAGE_SIZE = 100;
  const MAX_PARTICIPANTS = 500;
  const MAX_PAGE_REQUESTS = MAX_PARTICIPANTS / PAGE_SIZE;
  const MAX_ROLES = 20;
  const MAX_ENROLMENTS = 20;
  const MAX_LABEL = 200;
  const MAX_SECONDS = 253_402_300_799;
  const MAX_FORM_ENTRIES = 600;
  const MAX_FORM_BYTES = 256 * 1024;
  const MAX_VALUE_BYTES = 32 * 1024;
  const MAX_OPTIONS = 500;
  const ID = /^[1-9][0-9]{0,18}$/;
  const DIGEST = /^[a-f0-9]{64}$/;
  const TRANSIENT_FIELD = /(?:sesskey|statekey|csrf|token|secret|password|authorization|cookie)/i;
  // Moodle's own enrolment status values on the enrolment editing form.
  // https://github.com/moodle/moodle/blob/v5.2.2/public/lib/enrollib.php
  const STATUS_ACTIVE = "0";
  const STATUS_SUSPENDED = "1";
  const STATUS_FIELD = "status";
  // What a full unenrolment takes with it, in the words an instructor reads on
  // the course. Moodle removes all of this when the last enrolment of a person
  // in a course is removed.
  // https://github.com/moodle/moodle/blob/v5.2.2/public/lib/enrollib.php
  const UNENROL_REMOVALS = Object.freeze([
    "Their place in the course. They lose access to it and to everything in it",
    "Every grade and every piece of feedback they hold in this course's gradebook",
    "Their submissions, attempts and the files they uploaded in this course's activities",
    "Their completion records and their participation history in this course",
    "Their group memberships in this course",
    "Their role assignments in this course",
  ]);
  const definitions = Object.freeze({
    "moodle.form.enrol.participant.enrol.write.v1": Object.freeze({
      toolName: "moodle_enrol_participant",
      readOnly: false,
      kind: "enrol",
      capabilities: Object.freeze([...READ_CAPABILITIES, "enrol/manual:enrol"]),
      route: MANUAL_MANAGE_PATH,
    }),
    "moodle.form.enrol.participant.suspend.write.v1": Object.freeze({
      toolName: "moodle_suspend_participant",
      readOnly: false,
      kind: "suspend",
      capabilities: Object.freeze([...READ_CAPABILITIES, "enrol/manual:manage"]),
      route: EDIT_ENROLMENT_PATH,
    }),
    "moodle.form.enrol.participant.unenrol.write.v1": Object.freeze({
      toolName: "moodle_unenrol_participant",
      readOnly: false,
      kind: "unenrol",
      capabilities: Object.freeze([...READ_CAPABILITIES, "enrol/manual:unenrol"]),
      route: UNENROL_PATH,
    }),
    "moodle.ajax.core_update_inplace_editable.user_roles.assign.v1": Object.freeze({
      toolName: "moodle_assign_role",
      readOnly: false,
      kind: "assign_role",
      capabilities: Object.freeze([...READ_CAPABILITIES, "moodle/role:assign"]),
      route: AJAX_PATH,
    }),
    "moodle.ajax.core_update_inplace_editable.user_roles.remove.v1": Object.freeze({
      toolName: "moodle_remove_role",
      readOnly: false,
      kind: "remove_role",
      capabilities: Object.freeze([...READ_CAPABILITIES, "moodle/role:assign"]),
      route: AJAX_PATH,
    }),
  });

  const object = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
  const id = (value) => {
    const raw = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : typeof value === "string" ? value : "";
    return ID.test(raw) ? raw : "";
  };
  const text = (value, maximum = 1_024) => typeof value === "string" && value.length > 0 && value.length <= maximum
    && !/[\u0000-\u001f\u007f]/.test(value);
  const label = (value) => {
    const collapsed = String(value ?? "").replace(/\s+/g, " ").trim();
    return text(collapsed, MAX_LABEL) ? collapsed : "";
  };
  const failure = (error, status) => ({ ok: false, sent: false, ...(Number.isInteger(status) ? { status } : {}), error });
  const unconfirmedWrite = (error, status, data) => ({
    ok: false,
    sent: true,
    ...(Number.isInteger(status) ? { status } : {}),
    outcomeUnknown: true,
    ...(data ? { data } : {}),
    verification: { schema: "morrow.browser-verification.v1", status: "unconfirmed", reason: error },
    error,
  });
  // Moodle answers a submission it refuses by rendering the same form again,
  // which saved nothing. That ending is known, not uncertain.
  const refusedWrite = (status, data) => ({
    ok: false,
    sent: true,
    status,
    outcomeUnknown: false,
    ...(data ? { data } : {}),
    verification: { schema: "morrow.browser-verification.v1", status: "mismatch", reason: "moodle_form_validation_failed" },
    error: "moodle_form_validation_failed",
  });
  const stable = (value) => {
    if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
    if (object(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
    return JSON.stringify(value === undefined ? null : value);
  };
  const digest = async (value) => {
    if (!globalThis.crypto?.subtle || typeof globalThis.TextEncoder !== "function") return "";
    const bytes = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(stable(value)));
    return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
  };
  const currentContext = () => {
    const cfg = globalThis.M?.cfg;
    if (!object(cfg) || typeof cfg.wwwroot !== "string" || !text(cfg.sesskey)) return null;
    const principalId = id(cfg.userId);
    if (!principalId) return null;
    let site;
    try { site = new URL(cfg.wwwroot); } catch { return null; }
    if (site.protocol !== "https:" || site.search || site.hash || site.username || site.password) return null;
    const basePath = site.pathname.replace(/\/$/, "");
    const currentPath = String(globalThis.location?.pathname || "");
    if (site.origin !== globalThis.location?.origin || !(currentPath === basePath || currentPath.startsWith(`${basePath}/`))) return null;
    const configuredCourse = id(cfg.courseId);
    const bodyCourse = String(globalThis.document?.body?.className || "").match(/(?:^|\s)course-([1-9][0-9]*)(?:\s|$)/)?.[1] || "";
    if (configuredCourse && bodyCourse && configuredCourse !== bodyCourse) return null;
    const courseId = configuredCourse || bodyCourse;
    if (!courseId) return null;
    return { origin: site.origin, siteUrl: site.href, basePath, principalId, courseId, sesskey: cfg.sesskey };
  };
  const sameContext = (left, right) => Boolean(left) && Boolean(right) && left.origin === right.origin
    && left.siteUrl === right.siteUrl && left.basePath === right.basePath && left.principalId === right.principalId
    && left.courseId === right.courseId && left.sesskey === right.sesskey;
  const bindingValid = (context, binding) => object(binding) && binding.origin === context.origin
    && binding.siteUrl === context.siteUrl && id(binding.principalId) === context.principalId
    && id(binding.courseId) === context.courseId;
  const urlFor = (context, path, query) => {
    const result = new URL(context.siteUrl);
    result.pathname = `${context.basePath}${path}`;
    result.search = query ? new URLSearchParams(query).toString() : "";
    result.hash = "";
    return result;
  };
  const sameRoute = (actual, expected) => {
    try {
      const received = new URL(actual);
      const target = new URL(expected);
      return received.origin === target.origin && received.pathname === target.pathname
        && !received.hash && !received.username && !received.password;
    } catch { return false; }
  };
  const boundedText = async (response) => {
    const declared = response?.headers?.get?.("content-length");
    if (declared !== null && (!/^(?:0|[1-9][0-9]*)$/.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) return null;
    let value;
    try { value = await response.text(); } catch { return null; }
    return typeof value === "string" && value.length <= MAX_RESPONSE_BYTES ? value : null;
  };
  const parseHtml = (html) => {
    if (typeof html !== "string" || typeof globalThis.DOMParser !== "function") return null;
    try { return new DOMParser().parseFromString(html, "text/html"); } catch { return null; }
  };

  /** One call of Moodle's own AJAX service, bound to this session and course. */
  const ajax = async (context, method, methodArgs, expiresAt, isWrite = false) => {
    if (Date.now() >= expiresAt || !sameContext(context, currentContext())) return { error: "moodle_enrolment_context_changed" };
    const endpoint = urlFor(context, AJAX_PATH, { sesskey: context.sesskey, info: method });
    let response;
    try {
      if (isWrite) writeAttempted = true;
      response = await fetch(endpoint, {
        method: "POST", credentials: "include", cache: "no-store", redirect: "error",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify([{ index: 0, methodname: method, args: methodArgs }]),
      });
    } catch { return { error: "moodle_enrolment_request_failed" }; }
    if (!response.ok || !sameRoute(response.url, endpoint)) return { error: "moodle_enrolment_service_unavailable", status: response.status };
    const raw = await boundedText(response);
    if (raw === null) return { error: "moodle_enrolment_response_unavailable", status: response.status };
    let payload;
    try { payload = JSON.parse(raw); } catch { return { error: "moodle_enrolment_response_invalid", status: response.status }; }
    if (!Array.isArray(payload) || payload.length !== 1 || !object(payload[0]) || payload[0].index !== 0
      || payload[0].error || payload[0].exception || !("data" in payload[0])) {
      return { error: "moodle_enrolment_service_unavailable", status: response.status };
    }
    try {
      const data = typeof payload[0].data === "string" ? JSON.parse(payload[0].data) : payload[0].data;
      return { data, status: response.status };
    } catch { return { error: "moodle_enrolment_response_invalid", status: response.status }; }
  };

  /**
   * Moodle writes 0, or omits the attribute, when an enrolment has no bound. A
   * value that is present but is not a plain timestamp is refused rather than
   * guessed at.
   */
  const instant = (value) => {
    if (value === null || value === undefined || value === "") return null;
    const raw = String(value);
    if (!/^(?:0|[1-9][0-9]{0,11})$/.test(raw)) return undefined;
    const seconds = Number(raw);
    if (seconds === 0) return null;
    if (seconds > MAX_SECONDS) return undefined;
    return new Date(seconds * 1000).toISOString();
  };
  /** The user enrolment ID Moodle put in its own action link for this row. */
  const enrolmentActionId = (node, context, path, action) => {
    const links = [...node.querySelectorAll(`a[href][data-action="${action}"]`)];
    if (links.length !== 1) return "";
    let target;
    try { target = new URL(links[0].getAttribute("href") || "", context.siteUrl); } catch { return ""; }
    if (target.origin !== context.origin || target.pathname !== `${context.basePath}${path}`) return "";
    return id(target.searchParams.get("ue") || "");
  };
  const roleOptions = (node) => {
    let parsed;
    try { parsed = JSON.parse(node.getAttribute("data-options") || ""); } catch { return null; }
    if (!object(parsed) || !Array.isArray(parsed.options) || parsed.options.length > MAX_OPTIONS) return null;
    const options = [];
    for (const option of parsed.options) {
      if (!object(option)) return null;
      const roleId = id(option.key);
      const name = label(option.value);
      if (!roleId || !name) return null;
      options.push({ role_id: roleId, name });
    }
    return options;
  };
  /**
   * The role list of the participants page's own role control, which carries it
   * as a JSON array of role IDs, both in the table markup and in the answer the
   * update route returns.
   */
  const roleIds = (raw) => {
    let parsed;
    try { parsed = JSON.parse(String(raw ?? "")); } catch { return null; }
    if (!Array.isArray(parsed) || parsed.length > MAX_ROLES) return null;
    const values = [];
    for (const entry of parsed) {
      const roleId = id(entry);
      if (!roleId || values.includes(roleId)) return null;
      values.push(roleId);
    }
    return values;
  };

  /**
   * One page of the participants table, parsed twice over: once into exactly
   * the projection `moodle_get_course_participants` returns, which is what the
   * digest covers, and once into the write anchors Moodle rendered beside it —
   * the user enrolment IDs of its own action links and the role control's own
   * item, value and options.
   */
  const parseParticipantsPage = (context, courseId, html) => {
    const documentValue = parseHtml(html);
    if (!documentValue) return { error: "moodle_enrolment_response_invalid" };
    const wrappers = [...documentValue.querySelectorAll('div[data-region="core_table/dynamic"]')].filter((node) => (
      node.getAttribute("data-table-component") === "core_user"
      && node.getAttribute("data-table-handler") === "participants"
      && node.getAttribute("data-table-uniqueid") === `user-index-participants-${courseId}`
    ));
    if (wrappers.length !== 1) return { error: "moodle_enrolment_participants_table_missing" };
    const declared = wrappers[0].getAttribute("data-table-total-rows") || "";
    if (!/^(?:0|[1-9][0-9]{0,6})$/.test(declared)) return { error: "moodle_enrolment_participants_table_invalid" };
    const participants = [];
    const anchors = [];
    for (const row of wrappers[0].querySelectorAll("tr")) {
      const checkboxes = row.querySelectorAll("input.usercheckbox");
      if (checkboxes.length === 0) continue;
      if (checkboxes.length !== 1) return { error: "moodle_enrolment_participants_row_invalid" };
      const userId = /^user([1-9][0-9]{0,18})$/.exec(checkboxes[0].getAttribute("name") || "")?.[1] || "";
      const roleNodes = [...row.querySelectorAll(`[data-itemtype="${ROLE_ITEMTYPE}"]`)]
        .filter((node) => node.getAttribute("data-component") === ROLE_COMPONENT);
      if (!userId || roleNodes.length !== 1) return { error: "moodle_enrolment_participants_row_invalid" };
      const roles = String(roleNodes[0].textContent || "").split(",").map(label).filter((value) => value.length > 0);
      if (roles.length > MAX_ROLES) return { bound: true };
      const enrolmentNodes = [...row.querySelectorAll("[data-status][data-enrolinstancename]")]
        .filter((node) => !node.parentElement || node.parentElement.closest("[data-status][data-enrolinstancename]") === null);
      if (enrolmentNodes.length === 0) return { error: "moodle_enrolment_detail_unavailable" };
      if (enrolmentNodes.length > MAX_ENROLMENTS) return { bound: true };
      const methods = [];
      const enrolments = [];
      for (const node of enrolmentNodes) {
        const method = label(node.getAttribute("data-enrolinstancename"));
        const status = label(node.getAttribute("data-status"));
        const start = instant(node.getAttribute("data-timestart"));
        const end = instant(node.getAttribute("data-timeend"));
        if (!method || !status || start === undefined || end === undefined) {
          return { error: "moodle_enrolment_participants_row_invalid" };
        }
        methods.push(method);
        enrolments.push({
          method,
          status,
          start,
          end,
          editId: enrolmentActionId(node, context, EDIT_ENROLMENT_PATH, "editenrolment"),
          unenrolId: enrolmentActionId(node, context, UNENROL_PATH, "unenrol"),
        });
      }
      participants.push({ user_id: userId, roles, enrolment_methods: methods });
      anchors.push({
        user_id: userId,
        enrolments,
        role: {
          itemId: String(roleNodes[0].getAttribute("data-itemid") || ""),
          values: roleIds(roleNodes[0].getAttribute("data-value")),
          options: roleOptions(roleNodes[0]),
        },
      });
    }
    return { totalRows: Number(declared), participants, anchors };
  };

  /**
   * The complete participant list of this course, in exactly the shape and the
   * bounds `moodle_get_course_participants` uses, with the write anchors kept
   * beside it. A course past the bound is incomplete, never a partial list.
   */
  const participantsScan = async (context, courseId, expiresAt) => {
    const participants = [];
    const rows = new Map();
    let totalRows = null;
    let pageRequestCount = 0;
    for (let page = 0; page < MAX_PAGE_REQUESTS; page += 1) {
      const result = await ajax(context, TABLE_METHOD, {
        component: "core_user",
        handler: "participants",
        uniqueid: `user-index-participants-${courseId}`,
        sortdata: [{ sortby: "lastname", sortorder: 4 }],
        filters: [{ name: "courseid", jointype: 1, values: [Number(courseId)] }],
        jointype: 1,
        firstinitial: "",
        lastinitial: "",
        pagenumber: page + 1,
        pagesize: PAGE_SIZE,
        hiddencolumns: [],
        resetpreferences: false,
      }, expiresAt);
      if (result.error) return { error: result.error, status: result.status };
      if (!object(result.data) || typeof result.data.html !== "string") {
        return { error: "moodle_enrolment_response_invalid", status: result.status };
      }
      pageRequestCount += 1;
      const parsed = parseParticipantsPage(context, courseId, result.data.html);
      if (parsed.bound) return { error: "moodle_enrolment_participants_incomplete", status: result.status };
      if (parsed.error) return { error: parsed.error, status: result.status };
      if (totalRows === null) totalRows = parsed.totalRows;
      else if (totalRows !== parsed.totalRows) return { error: "moodle_enrolment_participants_changed", status: result.status };
      if (totalRows > MAX_PARTICIPANTS) return { error: "moodle_enrolment_participants_incomplete", status: result.status };
      const expectedRows = Math.min(PAGE_SIZE, Math.max(0, totalRows - (page * PAGE_SIZE)));
      if (parsed.participants.length !== expectedRows) return { error: "moodle_enrolment_participants_incomplete", status: result.status };
      for (let index = 0; index < parsed.participants.length; index += 1) {
        const participant = parsed.participants[index];
        if (rows.has(participant.user_id)) return { error: "moodle_enrolment_duplicate_identity", status: result.status };
        rows.set(participant.user_id, { record: participant, anchor: parsed.anchors[index] });
        participants.push(participant);
      }
      if (participants.length === totalRows) {
        const data = {
          schema: PARTICIPANTS_SCHEMA,
          provider: PROVIDER,
          course_id: Number(courseId),
          participant_count: participants.length,
          participants,
          proof: {
            method: TABLE_METHOD,
            complete: true,
            required_capabilities: [...READ_CAPABILITIES],
            participant_limit: MAX_PARTICIPANTS,
            page_size: PAGE_SIZE,
            page_request_limit: MAX_PAGE_REQUESTS,
            page_request_count: pageRequestCount,
            total_rows: totalRows,
          },
        };
        const snapshotDigest = await digest(data);
        if (!snapshotDigest) return { error: "moodle_enrolment_digest_unavailable", status: result.status };
        return { data, digest: snapshotDigest, rows, status: result.status };
      }
    }
    return { error: "moodle_enrolment_participants_incomplete" };
  };
  /** Everyone except the person this change names, as the digest sees them. */
  const othersDigest = (scan, userId) => digest(scan.data.participants.filter((entry) => entry.user_id !== userId));

  const readPage = async (context, endpoint) => {
    let response;
    try {
      response = await fetch(endpoint, { method: "GET", credentials: "include", cache: "no-store", redirect: "error", headers: { Accept: "text/html" } });
    } catch { return { error: "moodle_enrolment_page_unavailable" }; }
    if (!response.ok || !sameRoute(response.url, endpoint) || !sameContext(context, currentContext())) {
      return { error: "moodle_enrolment_page_unavailable", status: response.status };
    }
    const html = await boundedText(response);
    const documentValue = parseHtml(html);
    return documentValue ? { status: response.status, document: documentValue } : { error: "moodle_enrolment_page_unavailable", status: response.status };
  };
  /** The one POST form of this page that submits back to this exact route. */
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
  const selectFor = (form, name) => {
    const selects = namedControls(form, name).filter((control) => control.tagName === "SELECT");
    return selects.length === 1 && !selects[0].disabled ? selects[0] : null;
  };
  const optionValues = (select) => [...select.options].map((option) => String(option.value ?? ""));
  const submitControl = (form, name) => {
    const controls = namedControls(form, name)
      .filter((control) => (control.tagName === "INPUT" || control.tagName === "BUTTON") && String(control.type || "").toLowerCase() === "submit");
    return controls.length === 1 ? { name, value: String(controls[0].value ?? "") } : null;
  };
  /**
   * The loaded form, carried through unchanged except for the controls one
   * reviewed change names, and sent exactly once.
   */
  const postForm = async (context, action, entries, changes, submit) => {
    const preflight = currentContext();
    if (!sameContext(context, preflight)) return { error: "moodle_enrolment_context_changed" };
    const body = new URLSearchParams();
    const carried = new Set();
    for (const [field, value] of entries) {
      if (!changes.has(field)) { body.append(field, value); continue; }
      if (carried.has(field)) continue;
      carried.add(field);
      for (const replacement of changes.get(field) || []) body.append(field, replacement);
    }
    for (const [field, values] of changes) if (!carried.has(field)) for (const value of values || []) body.append(field, value);
    if (submit) body.append(submit.name, submit.value);
    let response;
    try {
      writeAttempted = true;
      response = await fetch(action, {
        method: "POST", credentials: "include", cache: "no-store", redirect: "manual",
        headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8", Accept: "text/html" },
        body,
      });
    } catch { return { lost: true }; }
    if (response.type === "opaqueredirect") return { sent: true, redirected: true };
    const status = response.status;
    if ([301, 302, 303, 307, 308].includes(status)) return { sent: true, redirected: true, status };
    if (!response.ok) return { sent: true, status };
    const html = await boundedText(response);
    const documentValue = parseHtml(html);
    // A submission Moodle refuses comes back as the same form again, and that
    // saved nothing.
    const redisplayed = Boolean(documentValue) && Boolean(nativeForm(documentValue, action));
    return { sent: true, status, redisplayed };
  };

  /**
   * This course's own manual enrolment page, found through the link the course's
   * enrolment methods page renders for it. A course with no such link, or with
   * more than one, is refused: Morrow cannot state which method it would use.
   */
  const manualEnrolmentPage = async (context, courseId) => {
    const instances = urlFor(context, INSTANCES_PATH, { id: courseId });
    const page = await readPage(context, instances);
    if (page.error) return { error: "moodle_enrolment_methods_unavailable", status: page.status };
    const links = [];
    for (const link of page.document.querySelectorAll("a[href]")) {
      let target;
      try { target = new URL(link.getAttribute("href") || "", instances); } catch { continue; }
      if (target.origin !== context.origin || target.pathname !== `${context.basePath}${MANUAL_MANAGE_PATH}`) continue;
      const enrolId = id(target.searchParams.get("enrolid") || "");
      if (!enrolId || id(target.searchParams.get("id") || "") !== courseId) continue;
      if (!links.some((entry) => entry.enrolId === enrolId)) links.push({ enrolId, href: target.href });
    }
    if (links.length === 0) return { error: "moodle_enrolment_manual_method_unavailable", status: page.status };
    if (links.length > 1) return { error: "moodle_enrolment_manual_method_ambiguous", status: page.status };
    const manage = await readPage(context, new URL(links[0].href));
    if (manage.error) return { error: "moodle_enrolment_page_unavailable", status: manage.status };
    const form = nativeForm(manage.document, new URL(links[0].href));
    if (!form) return { error: "moodle_enrolment_form_unavailable", status: manage.status };
    const entries = entriesFor(form);
    const candidates = selectFor(form, "addselect[]");
    const add = submitControl(form, "add");
    const roles = selectFor(form, "roleid");
    if (!entries || !candidates || !add || !roles) return { error: "moodle_enrolment_form_invalid", status: manage.status };
    // The removal control of this page unenrols people. This operation never
    // sends it, and a page that carries it as anything but its own submit
    // button is refused rather than guessed at.
    if (entries.some(([name]) => name === "remove" || name === "removeselect[]")) {
      return { error: "moodle_enrolment_form_invalid", status: manage.status };
    }
    let action;
    try { action = new URL(form.getAttribute("action") || "", links[0].href).href; } catch { return { error: "moodle_enrolment_form_invalid", status: manage.status }; }
    const selectedRole = roles.options[roles.selectedIndex >= 0 ? roles.selectedIndex : 0];
    return {
      status: manage.status,
      enrolId: links[0].enrolId,
      action,
      entries,
      add,
      candidates: optionValues(candidates).filter((value) => ID.test(value)),
      role: { role_id: id(selectedRole?.value) || "", name: label(selectedRole?.textContent) },
    };
  };

  const participantResult = (scan, userId) => {
    const row = scan.rows.get(userId);
    if (!row) return null;
    return {
      user_id: userId,
      roles: [...row.record.roles],
      enrolments: row.anchor.enrolments.map((entry) => ({ method: entry.method, status: entry.status, start: entry.start, end: entry.end })),
    };
  };
  const proofFor = (definition, extra) => ({
    method: definition.route === AJAX_PATH ? ROLE_METHOD : "native_page_form",
    route: definition.route,
    required_capabilities: [...definition.capabilities],
    dispatch_count: 1,
    ...extra,
  });
  const verified = (definition, args, status, after, data) => ({
    ok: true,
    sent: true,
    ...(Number.isInteger(status) ? { status } : {}),
    data: {
      schema: SCHEMA,
      provider: PROVIDER,
      course_id: Number(args.courseId),
      action: definition.toolName,
      learner: { user_id: args.userId },
      ...data,
    },
    snapshot_digest: after.digest,
    verification: { schema: "morrow.browser-verification.v1", status: "verified" },
  });

  /**
   * The state every write is measured against: the reviewed list, the same list
   * read again immediately before the dispatch, and the record of the one
   * person the change names.
   */
  const boundState = async (context, args, expiresAt, expectation) => {
    const reviewed = await participantsScan(context, args.courseId, expiresAt);
    if (reviewed.error) return { error: reviewed.error, status: reviewed.status };
    if (reviewed.digest !== args.expectedDigest) return { error: "moodle_expected_digest_mismatch", status: reviewed.status };
    const present = reviewed.rows.has(args.userId);
    if (expectation === "rostered" && !present) return { error: "moodle_enrolment_participant_not_rostered", status: reviewed.status };
    if (expectation === "absent" && present) return { error: "moodle_enrolment_already_enrolled", status: reviewed.status };
    return { reviewed };
  };
  const refreshedState = async (context, args, expiresAt) => {
    const fresh = await participantsScan(context, args.courseId, expiresAt);
    if (fresh.error) return { error: fresh.error, status: fresh.status };
    if (fresh.digest !== args.expectedDigest) return { error: "moodle_enrolment_state_changed", status: fresh.status };
    return { fresh };
  };
  /** The one enrolment a suspension or an unenrolment acts on. */
  const soleEnrolment = (scan, userId) => {
    const row = scan.rows.get(userId);
    if (!row) return { error: "moodle_enrolment_participant_not_rostered" };
    if (row.anchor.enrolments.length !== 1) return { error: "moodle_enrolment_multiple_enrolments" };
    return { enrolment: row.anchor.enrolments[0] };
  };

  const runEnrol = async (context, definition, args, expiresAt) => {
    const bound = await boundState(context, args, expiresAt, "absent");
    if (bound.error) return failure(bound.error, bound.status);
    const page = await manualEnrolmentPage(context, args.courseId);
    if (page.error) return failure(page.error, page.status);
    if (!page.role.role_id || !page.role.name) return failure("moodle_enrolment_form_invalid", page.status);
    // Moodle's own candidate list for this exact enrolment method is what binds
    // the person. A list that carries no candidate at all, which is how Moodle
    // renders a site with more candidates than the page lists, cannot bind one.
    if (page.candidates.length === 0) return failure("moodle_enrolment_candidate_list_unavailable", page.status);
    if (page.candidates.filter((value) => value === args.userId).length !== 1) {
      return failure("moodle_enrolment_candidate_absent", page.status);
    }
    const refreshed = await refreshedState(context, args, expiresAt);
    if (refreshed.error) return failure(refreshed.error, refreshed.status);
    const before = await othersDigest(refreshed.fresh, args.userId);
    const posted = await postForm(context, page.action, page.entries, new Map([["addselect[]", [args.userId]]]), page.add);
    if (posted.error) return failure(posted.error, page.status);
    if (posted.lost) return unconfirmedWrite("moodle_enrolment_write_unconfirmed");
    const after = await participantsScan(context, args.courseId, expiresAt);
    if (after.error) return unconfirmedWrite(after.error, posted.status);
    const record = participantResult(after, args.userId);
    if (!record || record.enrolments.length === 0) return unconfirmedWrite("moodle_enrolment_readback_mismatch", posted.status);
    if (await othersDigest(after, args.userId) !== before) return unconfirmedWrite("moodle_enrolment_other_participants_changed", posted.status);
    return verified(definition, args, posted.status ?? after.status, after, {
      participant_before: null,
      participant_after: record,
      enrolment_method_role: page.role,
      proof: proofFor(definition, { enrolment_instance_bound: true }),
    });
  };

  const runSuspend = async (context, definition, args, expiresAt) => {
    const bound = await boundState(context, args, expiresAt, "rostered");
    if (bound.error) return failure(bound.error, bound.status);
    const sole = soleEnrolment(bound.reviewed, args.userId);
    if (sole.error) return failure(sole.error, bound.reviewed.status);
    if (!sole.enrolment.editId) return failure("moodle_enrolment_action_unavailable", bound.reviewed.status);
    const endpoint = urlFor(context, EDIT_ENROLMENT_PATH, { ue: sole.enrolment.editId });
    const page = await readPage(context, endpoint);
    if (page.error) return failure(page.error, page.status);
    const form = nativeForm(page.document, endpoint);
    const entries = form ? entriesFor(form) : null;
    const status = form ? selectFor(form, STATUS_FIELD) : null;
    const submit = form ? submitControl(form, "submitbutton") : null;
    if (!form || !entries || !status || !submit) return failure("moodle_enrolment_form_invalid", page.status);
    if (entries.filter(([name]) => name === "ue").some(([, value]) => value !== sole.enrolment.editId)) {
      return failure("moodle_enrolment_form_invalid", page.status);
    }
    const values = optionValues(status);
    if (!values.includes(STATUS_SUSPENDED) || !values.includes(STATUS_ACTIVE)) {
      return failure("moodle_enrolment_status_control_unavailable", page.status);
    }
    if (entries.some(([name, value]) => name === STATUS_FIELD && value === STATUS_SUSPENDED)) {
      return failure("moodle_enrolment_already_suspended", page.status);
    }
    let action;
    try { action = new URL(form.getAttribute("action") || "", endpoint).href; } catch { return failure("moodle_enrolment_form_invalid", page.status); }
    const refreshed = await refreshedState(context, args, expiresAt);
    if (refreshed.error) return failure(refreshed.error, refreshed.status);
    const before = await othersDigest(refreshed.fresh, args.userId);
    const posted = await postForm(context, action, entries, new Map([[STATUS_FIELD, [STATUS_SUSPENDED]]]), submit);
    if (posted.error) return failure(posted.error, page.status);
    if (posted.lost) return unconfirmedWrite("moodle_enrolment_write_unconfirmed");
    if (posted.redisplayed) return refusedWrite(posted.status);
    // The saved status is read from the same native control the change used, so
    // the answer does not depend on the words the site renders for a status.
    const saved = await readPage(context, endpoint);
    const savedForm = saved.document ? nativeForm(saved.document, endpoint) : null;
    const savedEntries = savedForm ? entriesFor(savedForm) : null;
    if (!savedEntries || !savedEntries.some(([name, value]) => name === STATUS_FIELD && value === STATUS_SUSPENDED)) {
      return unconfirmedWrite("moodle_enrolment_readback_mismatch", posted.status);
    }
    // Everything the change did not name must come back exactly as it was sent.
    const carried = (list) => list.filter(([name]) => name !== STATUS_FIELD && !TRANSIENT_FIELD.test(name)).map(([name, value]) => `${name}=${value}`).sort().join("\n");
    if (carried(savedEntries) !== carried(entries)) return unconfirmedWrite("moodle_enrolment_readback_mismatch", posted.status);
    const after = await participantsScan(context, args.courseId, expiresAt);
    if (after.error) return unconfirmedWrite(after.error, posted.status);
    const record = participantResult(after, args.userId);
    if (!record || record.enrolments.length !== 1) return unconfirmedWrite("moodle_enrolment_readback_mismatch", posted.status);
    if (await othersDigest(after, args.userId) !== before) return unconfirmedWrite("moodle_enrolment_other_participants_changed", posted.status);
    return verified(definition, args, posted.status ?? after.status, after, {
      participant_before: participantResult(refreshed.fresh, args.userId),
      participant_after: record,
      proof: proofFor(definition, { enrolment_status_saved: STATUS_SUSPENDED }),
    });
  };

  const runUnenrol = async (context, definition, args, expiresAt) => {
    if (args.acknowledged !== true) return failure("moodle_unenrol_acknowledgement_required");
    const bound = await boundState(context, args, expiresAt, "rostered");
    if (bound.error) return failure(bound.error, bound.status);
    const sole = soleEnrolment(bound.reviewed, args.userId);
    if (sole.error) return failure(sole.error, bound.reviewed.status);
    if (!sole.enrolment.unenrolId) return failure("moodle_enrolment_action_unavailable", bound.reviewed.status);
    const endpoint = urlFor(context, UNENROL_PATH, { ue: sole.enrolment.unenrolId });
    const page = await readPage(context, endpoint);
    if (page.error) return failure(page.error, page.status);
    // Moodle's own confirmation. Its continue button is the request this
    // operation sends, and it is the only form on that page that submits back
    // to the unenrolment route.
    const form = nativeForm(page.document, endpoint);
    const entries = form ? entriesFor(form) : null;
    if (!form || !entries) return failure("moodle_unenrol_confirmation_unavailable", page.status);
    const field = (name) => entries.filter(([entry]) => entry === name).map(([, value]) => value);
    if (field("ue").length !== 1 || field("ue")[0] !== sole.enrolment.unenrolId
      || field("confirm").length !== 1 || !["1", "true", "yes"].includes(field("confirm")[0].toLowerCase())) {
      return failure("moodle_unenrol_confirmation_unavailable", page.status);
    }
    let action;
    try { action = new URL(form.getAttribute("action") || "", endpoint).href; } catch { return failure("moodle_unenrol_confirmation_unavailable", page.status); }
    const refreshed = await refreshedState(context, args, expiresAt);
    if (refreshed.error) return failure(refreshed.error, refreshed.status);
    const record = participantResult(refreshed.fresh, args.userId);
    const before = await othersDigest(refreshed.fresh, args.userId);
    const posted = await postForm(context, action, entries, new Map(), null);
    if (posted.error) return failure(posted.error, page.status);
    if (posted.lost) return unconfirmedWrite("moodle_enrolment_write_unconfirmed");
    const after = await participantsScan(context, args.courseId, expiresAt);
    if (after.error) return unconfirmedWrite(after.error, posted.status);
    if (after.rows.has(args.userId)) return unconfirmedWrite("moodle_enrolment_readback_mismatch", posted.status);
    if (await othersDigest(after, args.userId) !== before) return unconfirmedWrite("moodle_enrolment_other_participants_changed", posted.status);
    return verified(definition, args, posted.status ?? after.status, after, {
      participant_before: record,
      participant_after: null,
      removed: [...UNENROL_REMOVALS],
      proof: proofFor(definition, { participant_absent_after: true }),
    });
  };

  const runRoleWrite = async (context, definition, args, expiresAt) => {
    const assigning = definition.kind === "assign_role";
    const bound = await boundState(context, args, expiresAt, "rostered");
    if (bound.error) return failure(bound.error, bound.status);
    const plan = (scan) => {
      const anchor = scan.rows.get(args.userId)?.anchor;
      const role = anchor?.role;
      if (!role || !Array.isArray(role.values) || !Array.isArray(role.options) || role.itemId !== `${args.courseId}:${args.userId}`) {
        return { error: "moodle_role_control_unavailable" };
      }
      const matches = role.options.filter((option) => option.name === args.roleName);
      if (matches.length !== 1) return { error: "moodle_role_name_unresolved" };
      const assignable = new Set(role.options.map((option) => option.role_id));
      // The control sends the complete role list, so a role Morrow cannot see
      // in that list is a role it cannot carry through the change.
      if (role.values.some((value) => !assignable.has(value))) return { error: "moodle_role_unassignable_role_present" };
      const target = matches[0];
      const held = role.values.includes(target.role_id);
      if (assigning && held) return { error: "moodle_role_already_assigned" };
      if (!assigning && !held) return { error: "moodle_role_not_assigned" };
      const next = assigning ? [...role.values, target.role_id] : role.values.filter((value) => value !== target.role_id);
      return { itemId: role.itemId, target, current: [...role.values], next };
    };
    const reviewedPlan = plan(bound.reviewed);
    if (reviewedPlan.error) return failure(reviewedPlan.error, bound.reviewed.status);
    const refreshed = await refreshedState(context, args, expiresAt);
    if (refreshed.error) return failure(refreshed.error, refreshed.status);
    const freshPlan = plan(refreshed.fresh);
    if (freshPlan.error) return failure(freshPlan.error, refreshed.fresh.status);
    if (freshPlan.itemId !== reviewedPlan.itemId || freshPlan.next.join(",") !== reviewedPlan.next.join(",")) {
      return failure("moodle_enrolment_state_changed", refreshed.fresh.status);
    }
    const before = await othersDigest(refreshed.fresh, args.userId);
    const sent = freshPlan.next.map((value) => Number(value));
    const response = await ajax(context, ROLE_METHOD, {
      component: ROLE_COMPONENT,
      itemtype: ROLE_ITEMTYPE,
      itemid: freshPlan.itemId,
      value: JSON.stringify(sent),
    }, expiresAt, true);
    if (response.error) {
      // A request that never left the page changed nothing. Every other ending
      // after the dispatch is uncertain.
      return writeAttempted
        ? unconfirmedWrite("moodle_enrolment_write_unconfirmed", response.status)
        : failure(response.error, response.status);
    }
    // The route's own answer is the first readback: it carries the role list
    // Moodle saved for this exact item.
    const saved = object(response.data) ? roleIds(response.data.value) : null;
    if (!saved || saved.slice().sort().join(",") !== freshPlan.next.slice().sort().join(",")) {
      return unconfirmedWrite(assigning ? "moodle_role_readback_mismatch" : "moodle_role_removal_protected", response.status);
    }
    const after = await participantsScan(context, args.courseId, expiresAt);
    if (after.error) return unconfirmedWrite(after.error, response.status);
    const afterPlan = after.rows.get(args.userId)?.anchor?.role;
    if (!afterPlan || !Array.isArray(afterPlan.values)
      || afterPlan.values.slice().sort().join(",") !== freshPlan.next.slice().sort().join(",")) {
      return unconfirmedWrite("moodle_role_readback_mismatch", response.status);
    }
    const record = participantResult(after, args.userId);
    const beforeRecord = participantResult(refreshed.fresh, args.userId);
    if (!record || !beforeRecord
      || record.enrolments.map((entry) => entry.method).join("\n") !== beforeRecord.enrolments.map((entry) => entry.method).join("\n")) {
      return unconfirmedWrite("moodle_role_enrolment_changed", response.status);
    }
    if (await othersDigest(after, args.userId) !== before) return unconfirmedWrite("moodle_enrolment_other_participants_changed", response.status);
    return verified(definition, args, response.status, after, {
      participant_before: beforeRecord,
      participant_after: record,
      role: freshPlan.target,
      proof: proofFor(definition, { role_ids_saved: saved.map((value) => Number(value)) }),
    });
  };

  const argumentsFor = (definition, args, courseId) => {
    if (!object(args)) return null;
    const allowed = new Set(["course_id", "user_id", "expected_digest"]);
    if (definition.kind === "assign_role" || definition.kind === "remove_role") allowed.add("role_name");
    if (definition.kind === "unenrol") allowed.add("acknowledge_removes_learner_record");
    if (Object.keys(args).some((key) => !allowed.has(key))) return null;
    if (id(args.course_id) !== courseId || !id(args.user_id) || !DIGEST.test(String(args.expected_digest || ""))) return null;
    const roleName = allowed.has("role_name") ? args.role_name : undefined;
    if (allowed.has("role_name") && (typeof roleName !== "string" || label(roleName) !== roleName)) return null;
    const acknowledged = allowed.has("acknowledge_removes_learner_record") ? args.acknowledge_removes_learner_record : undefined;
    if (allowed.has("acknowledge_removes_learner_record") && typeof acknowledged !== "boolean") return null;
    return {
      courseId,
      userId: id(args.user_id),
      expectedDigest: String(args.expected_digest),
      ...(roleName === undefined ? {} : { roleName }),
      ...(acknowledged === undefined ? {} : { acknowledged }),
    };
  };

  let writeAttempted = false;
  try {
    const input = (() => {
      try { return typeof rawInput === "string" ? JSON.parse(rawInput) : rawInput; } catch { return null; }
    })();
    const context = currentContext();
    if (!object(input) || input.mode !== "execute" || !context) return failure("moodle_session_unavailable");
    if (!Number.isSafeInteger(input.expiresAt) || Date.now() >= input.expiresAt) return failure("moodle_execution_expired");
    const operation = input.operation;
    const definition = object(operation) && typeof operation.key === "string" ? definitions[operation.key] : undefined;
    if (!definition || operation.provider !== PROVIDER || operation.toolName !== definition.toolName || operation.readOnly !== false) {
      return failure("moodle_operation_refused");
    }
    if (!bindingValid(context, input.binding)) return failure("moodle_binding_mismatch");
    const args = argumentsFor(definition, input.arguments, context.courseId);
    if (!args) return failure("moodle_enrolment_arguments_invalid");
    if (definition.kind === "enrol") return await runEnrol(context, definition, args, input.expiresAt);
    if (definition.kind === "suspend") return await runSuspend(context, definition, args, input.expiresAt);
    if (definition.kind === "unenrol") return await runUnenrol(context, definition, args, input.expiresAt);
    return await runRoleWrite(context, definition, args, input.expiresAt);
  } catch (error) {
    if (writeAttempted) return unconfirmedWrite("moodle_enrolment_write_unconfirmed");
    const message = String(error?.message || error);
    return failure(message.startsWith("moodle_") ? message : "moodle_enrolment_execution_failed");
  }
}

/**
 * Resolve one exact full name through Moodle's native manual-enrolment
 * candidate selector. The full name and every other identity field stay in
 * this page world. Only the numeric user ID and fixed proof fields leave it.
 *
 * This is a read. It sends two bounded GET requests, refuses redirects, and
 * never submits the form. Chrome serializes this function for a MAIN-world
 * injection, so every dependency remains inside the function body.
 */
export async function executeMoodleEnrolmentCandidateInPage(rawInput) {
  const PROVIDER = "moodle";
  const OPERATION = "moodle.private.enrolment_candidate.find.v1";
  const TOOL = "morrow_private_moodle_find_enrolment_candidate";
  const SCHEMA = "morrow.moodle-enrolment-candidate.private.v1";
  const INSTANCES_PATH = "/enrol/instances.php";
  const MANAGE_PATH = "/enrol/manual/manage.php";
  const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
  const MAX_CANDIDATES = 100;
  const MAX_QUERY = 200;
  const MAX_LABEL = 1_000;
  const ID = /^[1-9][0-9]{0,18}$/;

  const object = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
  const id = (value) => {
    const raw = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : typeof value === "string" ? value : "";
    return ID.test(raw) ? raw : "";
  };
  const exactQuery = (value) => typeof value === "string" && value.length >= 1 && value.length <= MAX_QUERY
    && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value)
    ? value
    : "";
  const label = (value) => {
    const collapsed = String(value ?? "").replace(/\s+/g, " ").trim();
    return collapsed.length >= 1 && collapsed.length <= MAX_LABEL && !/[\u0000-\u001f\u007f]/.test(collapsed)
      ? collapsed
      : "";
  };
  const failure = (error, status) => ({
    ok: false,
    sent: false,
    ...(Number.isInteger(status) ? { status } : {}),
    error,
  });
  const currentContext = () => {
    const cfg = globalThis.M?.cfg;
    if (!object(cfg) || typeof cfg.wwwroot !== "string") return null;
    const principalId = id(cfg.userId);
    if (!principalId) return null;
    let site;
    try { site = new URL(cfg.wwwroot); } catch { return null; }
    if (site.protocol !== "https:" || site.search || site.hash || site.username || site.password) return null;
    const basePath = site.pathname.replace(/\/$/, "");
    const currentPath = String(globalThis.location?.pathname || "");
    if (site.origin !== globalThis.location?.origin || !(currentPath === basePath || currentPath.startsWith(`${basePath}/`))) return null;
    const configuredCourse = id(cfg.courseId);
    const bodyCourses = [...new Set([...String(globalThis.document?.body?.className || "").matchAll(/(?:^|\s)course-([1-9][0-9]*)(?=\s|$)/g)].map((match) => match[1]))];
    if (bodyCourses.length > 1 || (configuredCourse && bodyCourses[0] && configuredCourse !== bodyCourses[0])) return null;
    const courseId = configuredCourse || bodyCourses[0] || "";
    return courseId ? { origin: site.origin, siteUrl: site.href, basePath, principalId, courseId } : null;
  };
  const sameContext = (left, right) => Boolean(left) && Boolean(right) && left.origin === right.origin
    && left.siteUrl === right.siteUrl && left.basePath === right.basePath && left.principalId === right.principalId
    && left.courseId === right.courseId;
  const bindingValid = (context, binding) => object(binding) && binding.origin === context.origin
    && binding.siteUrl === context.siteUrl && id(binding.principalId) === context.principalId
    && id(binding.courseId) === context.courseId;
  const urlFor = (context, path, query) => {
    const result = new URL(context.siteUrl);
    result.pathname = `${context.basePath}${path}`;
    result.search = new URLSearchParams(query).toString();
    result.hash = "";
    return result;
  };
  const exactUrl = (actual, expected) => {
    try { return new URL(actual).href === expected.href; } catch { return false; }
  };
  const pageCourse = (documentValue) => {
    const values = [...new Set([...String(documentValue?.body?.className || "").matchAll(/(?:^|\s)course-([1-9][0-9]*)(?=\s|$)/g)].map((match) => match[1]))];
    return values.length === 1 ? values[0] : "";
  };
  const boundedText = async (response) => {
    const declared = response?.headers?.get?.("content-length");
    if (declared !== null && (!/^(?:0|[1-9][0-9]*)$/.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) return null;
    const reader = response?.body?.getReader?.();
    if (!reader) return null;
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        if (!(next.value instanceof Uint8Array)) return null;
        size += next.value.byteLength;
        if (size > MAX_RESPONSE_BYTES) {
          await reader.cancel().catch(() => undefined);
          return null;
        }
        chunks.push(next.value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch { return null; }
  };
  const parseHtml = (html) => {
    if (typeof html !== "string" || typeof globalThis.DOMParser !== "function") return null;
    try { return new DOMParser().parseFromString(html, "text/html"); } catch { return null; }
  };

  let readRequestCount = 0;
  const readPage = async (context, endpoint, expiresAt) => {
    if (Date.now() >= expiresAt || !sameContext(context, currentContext())) return { error: "moodle_enrolment_candidate_context_changed" };
    let response;
    try {
      readRequestCount += 1;
      response = await fetch(endpoint, {
        method: "GET",
        credentials: "include",
        cache: "no-store",
        redirect: "error",
        headers: { Accept: "text/html" },
      });
    } catch { return { error: "moodle_enrolment_candidate_request_failed" }; }
    const contentType = String(response.headers?.get?.("content-type") || "").toLowerCase();
    if (!response.ok || !exactUrl(response.url, endpoint) || !contentType.startsWith("text/html")
      || !sameContext(context, currentContext())) {
      return { error: "moodle_enrolment_candidate_response_unavailable", status: response.status };
    }
    const html = await boundedText(response);
    const documentValue = parseHtml(html);
    if (!documentValue || !sameContext(context, currentContext()) || Date.now() >= expiresAt) {
      return { error: "moodle_enrolment_candidate_response_invalid", status: response.status };
    }
    return { document: documentValue, status: response.status };
  };
  const named = (root, name) => [...root.querySelectorAll("[name]")].filter((node) => node.getAttribute("name") === name);
  const soleControl = (root, name, tag) => {
    const controls = named(root, name).filter((node) => node.tagName === tag && !node.disabled);
    return controls.length === 1 ? controls[0] : null;
  };
  const soleSubmit = (root, name) => {
    const controls = named(root, name).filter((node) => (node.tagName === "INPUT" || node.tagName === "BUTTON")
      && String(node.type || "").toLowerCase() === "submit" && !node.disabled);
    return controls.length === 1 ? controls[0] : null;
  };
  const actionFor = (form, endpoint, context, enrolId, courseId) => {
    let action;
    try { action = new URL(form.getAttribute("action") || "", endpoint); } catch { return null; }
    const actionCourse = action.searchParams.get("id");
    if (action.origin !== context.origin || action.pathname !== `${context.basePath}${MANAGE_PATH}`
      || id(action.searchParams.get("enrolid")) !== enrolId || (actionCourse !== null && id(actionCourse) !== courseId)
      || action.hash || action.username || action.password) return null;
    return action;
  };
  const candidateNames = (value) => {
    const rendered = label(value);
    if (!rendered) return [];
    const values = [rendered];
    const details = rendered.lastIndexOf(" (");
    if (details > 0 && rendered.endsWith(")")) values.push(rendered.slice(0, details));
    return [...new Set(values)];
  };

  try {
    const input = (() => {
      try { return typeof rawInput === "string" ? JSON.parse(rawInput) : rawInput; } catch { return null; }
    })();
    const context = currentContext();
    if (!object(input) || !context) return failure("moodle_session_unavailable");
    if (!Number.isSafeInteger(input.expiresAt) || Date.now() >= input.expiresAt) return failure("moodle_execution_expired");
    const operation = input.operation;
    if (!object(operation) || operation.key !== OPERATION || operation.toolName !== TOOL
      || operation.provider !== PROVIDER || operation.readOnly !== true || operation.morrowPrivate !== true) {
      return failure("moodle_enrolment_candidate_operation_refused");
    }
    if (!bindingValid(context, input.binding)) return failure("moodle_binding_mismatch");
    if (!object(input.arguments) || Object.keys(input.arguments).length !== 2) {
      return failure("moodle_enrolment_candidate_arguments_invalid");
    }
    const courseId = id(input.arguments.course_id);
    const query = exactQuery(input.arguments.query);
    if (!courseId || courseId !== context.courseId || !query) return failure("moodle_enrolment_candidate_arguments_invalid");

    const instancesEndpoint = urlFor(context, INSTANCES_PATH, { id: courseId });
    const instances = await readPage(context, instancesEndpoint, input.expiresAt);
    if (instances.error) return failure(instances.error, instances.status);
    if (pageCourse(instances.document) !== courseId) return failure("moodle_enrolment_candidate_course_mismatch", instances.status);
    const methods = [];
    for (const link of instances.document.querySelectorAll("a[href]")) {
      let target;
      try { target = new URL(link.getAttribute("href") || "", instancesEndpoint); } catch { continue; }
      const enrolId = id(target.searchParams.get("enrolid"));
      const linkedCourse = target.searchParams.get("id");
      if (target.origin !== context.origin || target.pathname !== `${context.basePath}${MANAGE_PATH}` || !enrolId
        || (linkedCourse !== null && id(linkedCourse) !== courseId) || target.hash || target.username || target.password) continue;
      if (!methods.some((entry) => entry.enrolId === enrolId)) methods.push({ enrolId, target });
    }
    if (methods.length === 0) return failure("moodle_enrolment_candidate_manual_method_unavailable", instances.status);
    if (methods.length !== 1) return failure("moodle_enrolment_candidate_manual_method_ambiguous", instances.status);

    const manageEndpoint = new URL(methods[0].target.href);
    manageEndpoint.searchParams.set("addselect_searchtext", query);
    // Supplying this setting changes a Moodle user preference. The private
    // resolver never does that. It filters the complete native result locally.
    manageEndpoint.searchParams.delete("userselector_searchtype");
    const manage = await readPage(context, manageEndpoint, input.expiresAt);
    if (manage.error) return failure(manage.error, manage.status);
    if (pageCourse(manage.document) !== courseId) return failure("moodle_enrolment_candidate_course_mismatch", manage.status);
    const forms = [...manage.document.querySelectorAll("form")].filter((form) => {
      if (String(form.getAttribute("method") || "").toLowerCase() !== "post") return false;
      return Boolean(actionFor(form, manageEndpoint, context, methods[0].enrolId, courseId));
    });
    if (forms.length !== 1) return failure("moodle_enrolment_candidate_form_invalid", manage.status);
    const form = forms[0];
    const search = soleControl(form, "addselect_searchtext", "INPUT");
    const candidates = soleControl(form, "addselect[]", "SELECT");
    const role = soleControl(form, "roleid", "SELECT");
    const add = soleSubmit(form, "add");
    if (!search || !candidates || !role || !add || !candidates.multiple
      || !["text", "search"].includes(String(search.type || "text").toLowerCase())
      || search.value !== query || !actionFor(form, manageEndpoint, context, methods[0].enrolId, courseId)) {
      return failure("moodle_enrolment_candidate_form_invalid", manage.status);
    }
    const options = [...candidates.options];
    if (options.length > MAX_CANDIDATES) return failure("moodle_enrolment_candidate_excess", manage.status);
    const rows = [];
    for (const option of options) {
      const userId = id(option.value);
      const names = candidateNames(option.textContent);
      if (!userId || option.disabled || names.length === 0) return failure("moodle_enrolment_candidate_form_invalid", manage.status);
      if (rows.some((entry) => entry.userId === userId)) return failure("moodle_enrolment_candidate_ambiguous", manage.status);
      rows.push({ userId, names });
    }
    const matches = rows.filter((entry) => entry.names.includes(query));
    if (matches.length === 0) return failure("moodle_enrolment_candidate_absent", manage.status);
    if (matches.length !== 1) return failure("moodle_enrolment_candidate_ambiguous", manage.status);
    if (Date.now() >= input.expiresAt || !sameContext(context, currentContext())) {
      return failure("moodle_enrolment_candidate_context_changed", manage.status);
    }
    return {
      ok: true,
      sent: false,
      status: manage.status,
      complete: true,
      data: {
        schema: SCHEMA,
        provider: PROVIDER,
        course_id: Number(courseId),
        candidate: { user_id: matches[0].userId },
        match: { kind: "exact_native_query", candidate_count: 1 },
        proof: {
          method: "native_manual_enrolment_candidate_search",
          route: MANAGE_PATH,
          complete: true,
          dispatch_count: 0,
          read_request_count: readRequestCount,
          candidate_limit: MAX_CANDIDATES,
        },
      },
    };
  } catch (error) {
    const message = String(error?.message || error);
    return failure(message.startsWith("moodle_") ? message : "moodle_enrolment_candidate_execution_failed");
  }
}
