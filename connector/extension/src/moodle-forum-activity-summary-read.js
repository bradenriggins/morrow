/**
 * Reads a bounded aggregate-only activity summary for one exact Moodle Forum.
 *
 * Moodle's discussion response includes posts, identities, groups, attachment
 * metadata, and unread state. This function examines only discussion identity
 * and numreplies in the page world, then emits counts only.
 */
export async function executeMoodleForumActivitySummaryInPage(rawInput) {
  const PROVIDER = "moodle";
  const OPERATION = "moodle.form.forum.activity_summary.read.v1";
  const TOOL = "moodle_get_forum_activity_summary";
  const SCHEMA = "morrow.moodle-forum-activity-summary.v1";
  const METHOD = "mod_forum_get_forum_discussions";
  const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
  const PAGE_SIZE = 50;
  const MAX_DISCUSSIONS = 500;
  const MAX_PAGE_REQUESTS = (MAX_DISCUSSIONS / PAGE_SIZE) + 1;
  const MAX_REPLIES_PER_DISCUSSION = 10_000;
  const MAX_REPLIES = MAX_DISCUSSIONS * MAX_REPLIES_PER_DISCUSSION;
  const ID = /^[1-9][0-9]{0,18}$/;
  const object = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
  const id = (value) => {
    const text = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : typeof value === "string" ? value : "";
    return ID.test(text) ? text : "";
  };
  const text = (value, maximum = 1_024) => typeof value === "string" && value.length > 0 && value.length <= maximum
    && !/[\u0000-\u001f\u007f]/.test(value);
  const count = (value, maximum) => Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : null;
  const fail = (error, status) => ({ ok: false, sent: false, ...(Number.isInteger(status) ? { status } : {}), error });
  const incomplete = () => ({ ok: false, sent: false, complete: false, error: "moodle_forum_activity_summary_incomplete" });
  const input = (() => { try { return typeof rawInput === "string" ? JSON.parse(rawInput) : rawInput; } catch { return null; } })();
  const cfg = globalThis.M?.cfg;
  if (!object(input) || !object(cfg) || typeof cfg.wwwroot !== "string" || !text(cfg.sesskey)) {
    return fail("moodle_forum_activity_summary_context_invalid");
  }
  let site;
  try { site = new URL(cfg.wwwroot); } catch { return fail("moodle_forum_activity_summary_context_invalid"); }
  const basePath = site.pathname.replace(/\/$/, "");
  const bodyCourse = String(globalThis.document?.body?.className || "").match(/(?:^|\s)course-([1-9][0-9]*)(?:\s|$)/)?.[1] || "";
  const courseId = id(cfg.courseId) || bodyCourse;
  const principalId = id(cfg.userId);
  const currentPath = String(globalThis.location?.pathname || "");
  if (site.protocol !== "https:" || site.search || site.hash || site.username || site.password
    || site.origin !== globalThis.location?.origin || !(currentPath === basePath || currentPath.startsWith(`${basePath}/`))
    || !courseId || !principalId) return fail("moodle_forum_activity_summary_context_invalid");
  const operation = input.operation;
  const args = input.arguments;
  const binding = input.binding;
  if (!object(operation) || operation.key !== OPERATION || operation.toolName !== TOOL || operation.provider !== PROVIDER || operation.readOnly !== true
    || !object(args) || Object.keys(args).length !== 2 || id(args.course_id) !== courseId || !id(args.module_id)
    || !object(binding) || binding.origin !== site.origin || binding.siteUrl !== site.href
    || id(binding.principalId) !== principalId || id(binding.courseId) !== courseId
    || !Number.isSafeInteger(input.expiresAt) || input.expiresAt <= Date.now()) return fail("moodle_forum_activity_summary_arguments_invalid");
  const moduleId = id(args.module_id);
  const sameContext = () => globalThis.M?.cfg?.sesskey === cfg.sesskey && id(globalThis.M?.cfg?.userId) === principalId
    && (id(globalThis.M?.cfg?.courseId) || bodyCourse) === courseId;
  const url = (path, query = {}) => {
    const result = new URL(site.href);
    result.pathname = `${basePath}${path}`;
    result.search = new URLSearchParams(query).toString();
    result.hash = "";
    return result;
  };
  const sameRoute = (actual, expected) => {
    try {
      const received = new URL(actual);
      return received.origin === expected.origin && received.pathname === expected.pathname && received.search === expected.search
        && !received.hash && !received.username && !received.password;
    } catch { return false; }
  };
  const boundedText = async (response, endpoint) => {
    const declared = response?.headers?.get?.("content-length");
    if (declared !== null && (!/^(?:0|[1-9][0-9]*)$/.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) return "limit";
    if (!response?.ok || !sameRoute(response.url, endpoint) || !sameContext() || !response.body
      || typeof response.body.getReader !== "function" || typeof globalThis.TextDecoder !== "function") return null;
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
          return "limit";
        }
        result += decoder.decode(next.value, { stream: true });
      }
      return result + decoder.decode();
    } catch {
      try { await reader.cancel(); } catch {}
      return null;
    }
  };
  const hidden = (form, name) => {
    const controls = [...form.querySelectorAll(`input[type="hidden"][name="${name}"]`)];
    return controls.length === 1 ? controls[0].value : "";
  };
  const forumInstance = async () => {
    const endpoint = url("/course/modedit.php", { update: moduleId, return: "0" });
    let response;
    try {
      response = await fetch(endpoint, {
        method: "GET", credentials: "include", cache: "no-store", redirect: "error", headers: { Accept: "text/html" },
      });
    } catch { return null; }
    const html = await boundedText(response, endpoint);
    if (html === "limit") return "limit";
    if (typeof html !== "string" || typeof globalThis.DOMParser !== "function") return null;
    let documentValue;
    try { documentValue = new DOMParser().parseFromString(html, "text/html"); } catch { return null; }
    const forms = [...documentValue.querySelectorAll("form")].filter((form) => {
      if (String(form.getAttribute("method") || "").toLowerCase() !== "post") return false;
      try {
        const action = new URL(form.getAttribute("action") || endpoint.href, endpoint);
        const exactAction = action.origin === endpoint.origin && action.pathname === endpoint.pathname && !action.hash
          && !action.username && !action.password && (action.search === "" || action.search === endpoint.search);
        return exactAction && hidden(form, "course") === courseId && hidden(form, "coursemodule") === moduleId
          && hidden(form, "update") === moduleId && hidden(form, "modulename") === "forum" && Boolean(id(hidden(form, "instance")));
      } catch { return false; }
    });
    return forms.length === 1 ? id(hidden(forms[0], "instance")) || null : null;
  };
  const ajax = async (method, methodArgs) => {
    if (Date.now() >= input.expiresAt || !sameContext()) return { error: "moodle_forum_activity_summary_context_changed" };
    const endpoint = url("/lib/ajax/service.php", { sesskey: cfg.sesskey, info: method });
    let response;
    try {
      response = await fetch(endpoint, {
        method: "POST", credentials: "include", cache: "no-store", redirect: "error",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify([{ index: 0, methodname: method, args: methodArgs }]),
      });
    } catch { return { error: "moodle_forum_activity_summary_request_failed" }; }
    const raw = await boundedText(response, endpoint);
    if (raw === "limit") return { incomplete: true };
    if (typeof raw !== "string") return { error: "moodle_forum_activity_summary_response_unavailable" };
    try {
      const payload = JSON.parse(raw);
      if (!Array.isArray(payload) || payload.length !== 1 || !object(payload[0]) || payload[0].index !== 0
        || payload[0].error || payload[0].exception || !("data" in payload[0])) return { error: "moodle_forum_activity_summary_response_invalid" };
      const data = typeof payload[0].data === "string" ? JSON.parse(payload[0].data) : payload[0].data;
      return object(data) ? { data } : { error: "moodle_forum_activity_summary_response_invalid" };
    } catch { return { error: "moodle_forum_activity_summary_response_invalid" }; }
  };
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
  const forumId = await forumInstance();
  if (forumId === "limit") return incomplete();
  if (!forumId) return fail("moodle_forum_activity_summary_target_unavailable");
  const discussions = new Set();
  const unavailable = new Set();
  let replyCount = 0;
  let pageRequestCount = 0;
  for (let page = 0; page < MAX_PAGE_REQUESTS; page += 1) {
    const result = await ajax(METHOD, {
      forumid: Number(forumId), sortorder: 4, page, perpage: PAGE_SIZE, groupid: 0,
    });
    if (result.incomplete) return incomplete();
    if (!result.data || !Array.isArray(result.data.discussions) || !Array.isArray(result.data.warnings)) {
      return fail(result.error || "moodle_forum_activity_summary_unavailable");
    }
    // Moodle reports unreadable posts in a warnings array separate from discussions, so only the
    // discussion rows end pagination. The response shape is unverified against a live Moodle site.
    const pageDiscussionCount = result.data.discussions.length;
    if (pageDiscussionCount > PAGE_SIZE || result.data.warnings.length > PAGE_SIZE) return fail("moodle_forum_activity_summary_response_invalid");
    pageRequestCount += 1;
    for (const warning of result.data.warnings) {
      const warningId = id(warning?.itemid);
      if (!object(warning) || warning.item !== "post" || warning.warningcode !== "1" || !warningId || unavailable.has(warningId)) {
        return fail("moodle_forum_activity_summary_response_invalid");
      }
      unavailable.add(warningId);
    }
    for (const discussion of result.data.discussions) {
      const discussionId = id(discussion?.discussion);
      const replies = count(discussion?.numreplies, MAX_REPLIES_PER_DISCUSSION);
      if (!discussionId || discussions.has(discussionId) || replies === null || replyCount + replies > MAX_REPLIES) {
        return fail("moodle_forum_activity_summary_response_invalid");
      }
      discussions.add(discussionId);
      replyCount += replies;
      if (discussions.size > MAX_DISCUSSIONS) return incomplete();
    }
    if (pageDiscussionCount < PAGE_SIZE) {
      if (!sameContext() || Date.now() > input.expiresAt) return fail("moodle_forum_activity_summary_context_changed");
      const data = {
        schema: SCHEMA,
        provider: PROVIDER,
        course_id: Number(courseId),
        module_id: Number(moduleId),
        forum_id: Number(forumId),
        discussion_count: discussions.size,
        reply_count: replyCount,
        proof: {
          method: METHOD,
          complete: true,
          exact_module_binding: "course_modedit_form",
          required_capability: "mod/forum:viewdiscussion",
          scope: "current_principal_permitted_discussions",
          group_scope: "native_default_permitted_groups",
          sort_order: "created_asc",
          page_size: PAGE_SIZE,
          page_request_limit: MAX_PAGE_REQUESTS,
          page_request_count: pageRequestCount,
          discussion_limit: MAX_DISCUSSIONS,
          reply_limit: MAX_REPLIES,
        },
      };
      const snapshotDigest = await digest(data);
      if (!snapshotDigest) return fail("moodle_forum_activity_summary_digest_unavailable");
      return { ok: true, sent: false, complete: true, data, snapshot_digest: snapshotDigest };
    }
  }
  return incomplete();
}
