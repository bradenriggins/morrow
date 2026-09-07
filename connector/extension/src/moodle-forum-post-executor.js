/**
 * Moodle Forum discussion and post lifecycle: read one exact posting target,
 * start one discussion, reply to one post, lock or unlock one discussion, pin
 * or unpin one discussion, and set the signed-in person's own subscription to
 * one discussion.
 *
 * Every operation binds the exact Forum through the native
 * `course/modedit.php` Forum form before anything else, sends exactly one
 * native POST, and then reads Moodle's own saved state back. A new discussion
 * or reply is visible to every learner who can see the Forum as soon as Moodle
 * saves it, and Morrow has no route that removes it, so both refuse unless the
 * approving person confirmed that.
 *
 * Chrome serializes this function for a MAIN-world injection. Keep every
 * dependency inside the function body.
 */
export async function executeMoodleForumPostInPage(rawInput) {
  const PROVIDER = "moodle";
  const SCHEMA = "morrow.moodle-forum-post-target.v1";
  const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
  const MAX_FORM_ENTRIES = 600;
  const MAX_FORM_BYTES = 256 * 1024;
  const MAX_VALUE_BYTES = 64 * 1024;
  const MAX_POSTS = 500;
  const MAX_OWN_DISCUSSIONS = 500;
  const MAX_SUBJECT_LENGTH = 255;
  const MAX_MESSAGE_LENGTH = 40_000;
  const ID = /^[1-9][0-9]{0,18}$/;
  const DIGEST = /^[a-f0-9]{64}$/;
  const CONTROL = /[\u0000-\u001f\u007f]/;
  const CONTROL_OUTSIDE_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
  // A Moodle file reference only resolves inside a saved file area. Morrow
  // sends no file with a post, so a message that names one would save a link
  // that cannot resolve.
  const FILE_REFERENCE = /@@PLUGINFILE@@|pluginfile\.php|draftfile\.php/i;
  const TRANSIENT_FIELD = /(?:sesskey|statekey|csrf|token|secret|password|authorization|cookie)/i;
  const definitions = Object.freeze({
    "moodle.form.forum.post_target.read.v1": { toolName: "moodle_get_forum_post_target", readOnly: true, kind: "target" },
    "moodle.form.forum.discussion.create.write.v1": { toolName: "moodle_create_forum_discussion", readOnly: false, kind: "discussion" },
    "moodle.form.forum.post.reply.write.v1": { toolName: "moodle_reply_to_forum_post", readOnly: false, kind: "reply" },
    "moodle.form.forum.discussion.lock.write.v1": { toolName: "moodle_lock_forum_discussion", readOnly: false, kind: "lock" },
    "moodle.form.forum.discussion.pin.write.v1": { toolName: "moodle_pin_forum_discussion", readOnly: false, kind: "pin" },
    "moodle.form.forum.discussion.subscription.write.v1": { toolName: "moodle_set_forum_subscription", readOnly: false, kind: "subscription" },
  });
  // Each native route states its own required capability at the exact module
  // context. Sources: public/mod/forum/post.php,
  // public/mod/forum/classes/post_form.php, public/mod/forum/externallib.php
  // and public/mod/forum/db/services.php.
  const CAPABILITIES = Object.freeze({
    target: "mod/forum:viewdiscussion",
    discussion: "mod/forum:startdiscussion",
    reply: "mod/forum:replypost",
    lock: "moodle/course:manageactivities",
    pin: "mod/forum:pindiscussions",
    subscription: "mod/forum:viewdiscussion",
  });
  const STATE_METHODS = Object.freeze({
    lock: "mod_forum_set_lock_state",
    pin: "mod_forum_set_pin_state",
    subscription: "mod_forum_set_subscription_state",
  });
  const POST_FORM_PATH = "/mod/forum/post.php";
  const MODEDIT_PATH = "/course/modedit.php";
  const AJAX_PATH = "/lib/ajax/service.php";
  const DRAFT_FILES_PATH = "/repository/draftfiles_ajax.php";

  const object = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
  const parseInput = () => {
    if (typeof rawInput !== "string") return rawInput;
    try { return JSON.parse(rawInput); } catch { return null; }
  };
  const input = parseInput();
  const failure = (error, status) => ({ ok: false, sent: false, ...(Number.isInteger(status) ? { status } : {}), error });
  const incomplete = (error) => ({ ok: false, sent: false, complete: false, error });
  const unconfirmedWrite = (error, status) => ({
    ok: false,
    sent: true,
    ...(Number.isInteger(status) ? { status } : {}),
    outcomeUnknown: true,
    verification: { schema: "morrow.browser-verification.v1", status: "unconfirmed", reason: error },
    error,
  });
  const mismatchWrite = (reason, status) => ({
    ok: false,
    sent: true,
    ...(Number.isInteger(status) ? { status } : {}),
    verification: { schema: "morrow.browser-verification.v1", status: "mismatch", reason },
    error: "moodle_write_not_verified",
  });
  const id = (value) => {
    const text = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : typeof value === "string" ? value : "";
    return ID.test(text) ? text : "";
  };
  const validText = (value, maximum) => typeof value === "string" && value.length > 0 && value.length <= maximum && !CONTROL.test(value);
  const stable = (value) => {
    if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
    if (object(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
    return JSON.stringify(value === undefined ? null : value);
  };
  const digest = async (value) => {
    if (!globalThis.crypto?.subtle || typeof globalThis.TextEncoder !== "function") throw new Error("moodle_forum_post_digest_unavailable");
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
    && id(binding.principalId) === context.principalId && id(binding.courseId) === context.anchorCourseId;
  const expectedOperation = (operation) => {
    if (!object(operation) || typeof operation.key !== "string") return null;
    const definition = definitions[operation.key];
    return definition && operation.provider === PROVIDER && operation.toolName === definition.toolName
      && operation.readOnly === definition.readOnly ? definition : null;
  };
  const exactKeys = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
  const argumentsFor = (definition, args, courseId) => {
    const target = (extra) => {
      const keys = ["course_id", "module_id", ...extra];
      if (!exactKeys(args, keys) || id(args.course_id) !== courseId || !id(args.module_id)) return null;
      return { courseId, moduleId: id(args.module_id) };
    };
    if (definition.kind === "target") {
      const withDiscussion = exactKeys(args, ["course_id", "module_id", "discussion_id"]);
      const base = target(withDiscussion ? ["discussion_id"] : []);
      if (!base) return null;
      if (!withDiscussion) return { ...base, discussionId: "" };
      const discussionId = id(args.discussion_id);
      return discussionId ? { ...base, discussionId } : null;
    }
    if (definition.kind === "discussion" || definition.kind === "reply") {
      const reply = definition.kind === "reply";
      const base = target(reply
        ? ["discussion_id", "parent_post_id", "subject", "message_html", "learner_visibility_confirmed", "expected_digest"]
        : ["subject", "message_html", "learner_visibility_confirmed", "expected_digest"]);
      if (!base) return null;
      const discussionId = reply ? id(args.discussion_id) : "";
      const parentPostId = reply ? id(args.parent_post_id) : "";
      if (reply && (!discussionId || !parentPostId)) return null;
      // Moodle saves a post subject as plain text, so markup in the approved
      // subject would not survive the save and could not be compared exactly.
      if (!validText(args.subject, MAX_SUBJECT_LENGTH) || /[<>&]/.test(args.subject)) return null;
      if (typeof args.message_html !== "string" || !args.message_html.trim() || args.message_html.length > MAX_MESSAGE_LENGTH
        || CONTROL_OUTSIDE_TEXT.test(args.message_html)) return null;
      if (typeof args.learner_visibility_confirmed !== "boolean" || !DIGEST.test(String(args.expected_digest || ""))) return null;
      return {
        ...base,
        discussionId,
        parentPostId,
        subject: args.subject,
        messageHtml: args.message_html,
        learnerVisibilityConfirmed: args.learner_visibility_confirmed,
        expectedDigest: args.expected_digest,
      };
    }
    const stateField = definition.kind === "lock" ? "locked" : definition.kind === "pin" ? "pinned" : "subscribed";
    const base = target(["discussion_id", stateField, "expected_digest"]);
    if (!base) return null;
    const discussionId = id(args.discussion_id);
    if (!discussionId || typeof args[stateField] !== "boolean" || !DIGEST.test(String(args.expected_digest || ""))) return null;
    return { ...base, discussionId, stateField, targetState: args[stateField], expectedDigest: args.expected_digest };
  };
  const urlFor = (context, path, params) => {
    const url = new URL(context.siteUrl);
    url.pathname = `${context.basePath}${path}`;
    url.search = new URLSearchParams(params).toString();
    url.hash = "";
    return url;
  };
  const sameRoute = (actual, expected) => {
    let received;
    try { received = new URL(actual); } catch { return false; }
    return received.origin === expected.origin && received.pathname === expected.pathname
      && received.search === expected.search && !received.hash && !received.username && !received.password;
  };
  const boundedText = async (response, endpoint, context) => {
    const declared = response?.headers?.get?.("content-length");
    if (declared !== null && (!/^(?:0|[1-9][0-9]*)$/.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) return "limit";
    if (!response?.ok || !sameRoute(response.url, endpoint) || !sameContext(context, currentContext()) || !response.body
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
  const readPage = async (context, endpoint) => {
    let response;
    try {
      response = await fetch(endpoint, {
        method: "GET", credentials: "include", cache: "no-store", redirect: "error", headers: { Accept: "text/html" },
      });
    } catch { return { error: "moodle_forum_post_read_unavailable" }; }
    const html = await boundedText(response, endpoint, context);
    if (html === "limit") return { limited: true, status: response.status };
    if (typeof html !== "string" || typeof globalThis.DOMParser !== "function") {
      return { error: "moodle_forum_post_read_unavailable", status: response.status };
    }
    try { return { status: response.status, document: new DOMParser().parseFromString(html, "text/html") }; }
    catch { return { error: "moodle_forum_post_read_unavailable", status: response.status }; }
  };
  // Moodle's own AJAX entry point. It serves only the external functions that
  // public/mod/forum/db/services.php registers with 'ajax' => true.
  const ajax = async (context, method, methodArgs) => {
    const endpoint = urlFor(context, AJAX_PATH, { sesskey: context.sesskey, info: method });
    let response;
    try {
      response = await fetch(endpoint, {
        method: "POST", credentials: "include", cache: "no-store", redirect: "error",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify([{ index: 0, methodname: method, args: methodArgs }]),
      });
    } catch { return { error: "moodle_forum_post_service_unavailable" }; }
    const raw = await boundedText(response, endpoint, context);
    if (raw === "limit") return { limited: true, status: response.status };
    if (typeof raw !== "string") return { error: "moodle_forum_post_service_unavailable", status: response.status };
    let payload;
    try { payload = JSON.parse(raw); } catch { return { error: "moodle_forum_post_response_invalid", status: response.status }; }
    if (!Array.isArray(payload) || payload.length !== 1 || !object(payload[0]) || payload[0].index !== 0) {
      return { error: "moodle_forum_post_response_invalid", status: response.status };
    }
    if (payload[0].error || payload[0].exception) return { error: "moodle_forum_post_service_refused", status: response.status };
    if (!("data" in payload[0])) return { error: "moodle_forum_post_response_invalid", status: response.status };
    let data;
    try { data = typeof payload[0].data === "string" ? JSON.parse(payload[0].data) : payload[0].data; }
    catch { return { error: "moodle_forum_post_response_invalid", status: response.status }; }
    return object(data) ? { data, status: response.status } : { error: "moodle_forum_post_response_invalid", status: response.status };
  };
  // Moodle's own draft-area listing.
  // https://github.com/moodle/moodle/blob/v5.2.2/public/repository/draftfiles_ajax.php
  const draftListing = async (context, itemId) => {
    const endpoint = urlFor(context, DRAFT_FILES_PATH, { action: "list" });
    let response;
    try {
      response = await fetch(endpoint, {
        method: "POST", credentials: "include", cache: "no-store", redirect: "error",
        headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
        body: new URLSearchParams({ sesskey: context.sesskey, itemid: itemId, filepath: "/" }),
      });
    } catch { return null; }
    const raw = await boundedText(response, endpoint, context);
    if (typeof raw !== "string") return null;
    try {
      const payload = JSON.parse(raw);
      return object(payload) ? payload : null;
    } catch { return null; }
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
  const valuesOf = (entries, name) => entries.filter(([entryName]) => entryName === name).map(([, value]) => value);
  const one = (entries, name) => {
    const values = valuesOf(entries, name);
    return values.length === 1 ? values[0] : null;
  };
  /**
   * The exact Forum binding. `course/modedit.php` is the one native form that
   * states, in one place, the course, the course module, the module type, the
   * Forum instance the module points at, and whether learners can see it.
   */
  const bindForum = async (context, courseId, moduleId) => {
    const endpoint = urlFor(context, MODEDIT_PATH, { update: moduleId, return: "0" });
    const page = await readPage(context, endpoint);
    if (page.limited) return { limited: true, status: page.status };
    if (page.error) return { error: page.error, status: page.status };
    const forms = [...page.document.querySelectorAll("form")].filter((form) => {
      if (String(form.getAttribute("method") || "").toLowerCase() !== "post") return false;
      try {
        const action = new URL(form.getAttribute("action") || endpoint.href, endpoint);
        return action.origin === endpoint.origin && action.pathname === endpoint.pathname && !action.hash
          && !action.username && !action.password && (action.search === "" || action.search === endpoint.search);
      } catch { return false; }
    });
    if (forms.length !== 1) return { error: "moodle_forum_post_target_unavailable", status: page.status };
    const entries = entriesFor(forms[0]);
    if (!entries) return { error: "moodle_forum_post_target_unavailable", status: page.status };
    const forumId = id(one(entries, "instance"));
    const visible = one(entries, "visible");
    const name = one(entries, "name");
    if (one(entries, "course") !== courseId || one(entries, "coursemodule") !== moduleId || one(entries, "update") !== moduleId
      || one(entries, "modulename") !== "forum" || !forumId || (visible !== "0" && visible !== "1") || !validText(name, 1_333)) {
      return { error: "moodle_forum_post_target_unavailable", status: page.status };
    }
    return { forumId, forumName: name, visible: visible === "1", status: page.status };
  };
  const postRecord = (value, discussionId) => {
    if (!object(value)) return null;
    const postId = id(value.id);
    const hasParent = value.hasparent === true;
    const parent = hasParent ? id(value.parentid) : (value.parentid === null || value.parentid === 0 ? "" : null);
    if (!postId || parent === null || (hasParent && !parent) || id(value.discussionid) !== discussionId
      || typeof value.subject !== "string" || typeof value.message !== "string" || typeof value.isdeleted !== "boolean"
      || typeof value.isprivatereply !== "boolean" || !Array.isArray(value.attachments)) return null;
    return {
      post_id: postId,
      parent_post_id: parent,
      subject: value.subject,
      deleted: value.isdeleted,
      private_reply: value.isprivatereply,
      attachment_count: value.attachments.length,
      message: value.message,
    };
  };
  /**
   * The exact discussion, read through Moodle's own AJAX post list. That
   * response names the Forum and the course the discussion belongs to, which
   * is what binds a caller-supplied discussion ID to the approved Forum.
   */
  const discussionState = async (context, courseId, forumId, discussionId) => {
    const result = await ajax(context, "mod_forum_get_discussion_posts", {
      discussionid: Number(discussionId), sortby: "id", sortdirection: "ASC",
    });
    if (result.limited) return { limited: true, status: result.status };
    if (result.error) return { error: result.error, status: result.status };
    const data = result.data;
    if (id(data.forumid) !== forumId || id(data.courseid) !== courseId || !Array.isArray(data.posts) || !Array.isArray(data.warnings)) {
      return { error: "moodle_forum_post_discussion_unavailable", status: result.status };
    }
    if (data.posts.length > MAX_POSTS) return { limited: true, status: result.status };
    const posts = [];
    const seen = new Set();
    for (const entry of data.posts) {
      const post = postRecord(entry, discussionId);
      if (!post || seen.has(post.post_id)) return { error: "moodle_forum_post_response_invalid", status: result.status };
      seen.add(post.post_id);
      posts.push(post);
    }
    const roots = posts.filter((post) => post.parent_post_id === "");
    if (roots.length !== 1) return { error: "moodle_forum_post_response_invalid", status: result.status };
    return { posts, subject: roots[0].subject, status: result.status };
  };
  /**
   * Every discussion in this exact Forum that the signed-in person has posted
   * in. Moodle 5.2.2 registers no discussion-list read for the browser, so
   * this is the only route that can name a discussion Morrow has just started.
   */
  const ownDiscussions = async (context, moduleId) => {
    const result = await ajax(context, "mod_forum_get_discussion_posts_by_userid", {
      userid: Number(context.principalId), cmid: Number(moduleId), sortby: "id", sortdirection: "ASC",
    });
    if (result.limited) return { limited: true, status: result.status };
    if (result.error) return { error: result.error, status: result.status };
    const discussions = result.data.discussions;
    if (!Array.isArray(discussions) || discussions.length > MAX_OWN_DISCUSSIONS) {
      return { error: "moodle_forum_post_response_invalid", status: result.status };
    }
    const found = new Map();
    for (const entry of discussions) {
      const discussionId = object(entry) ? id(entry.id) : "";
      if (!discussionId || found.has(discussionId) || typeof entry.name !== "string") {
        return { error: "moodle_forum_post_response_invalid", status: result.status };
      }
      found.set(discussionId, entry.name);
    }
    return { discussions: found, status: result.status };
  };
  const identityDigest = (courseId, moduleId, forumId, visible, discussionId) => digest({
    course_id: courseId, module_id: moduleId, forum_id: forumId, visible, discussion_id: discussionId,
  });
  const targetsFor = (forumName, discussionSubject) => [
    { field: "module_id", label: "Forum", name: forumName },
    ...(discussionSubject ? [{ field: "discussion_id", label: "Discussion", name: discussionSubject }] : []),
  ];
  const publicPosts = (posts) => posts.map((post) => ({
    post_id: post.post_id,
    parent_post_id: post.parent_post_id,
    subject: post.subject,
    deleted: post.deleted,
    private_reply: post.private_reply,
    attachment_count: post.attachment_count,
  }));
  const targetProof = (discussionBound) => ({
    method: discussionBound ? "mod_forum_get_discussion_posts" : "course_modedit_form",
    exact_module_binding: "course_modedit_form",
    required_capability: CAPABILITIES.target,
    scope: "one_forum_module",
    learner_identity: "never_returned",
    post_body: "never_returned",
  });
  const targetData = (courseId, moduleId, bound, discussionId, discussion) => ({
    schema: SCHEMA,
    provider: PROVIDER,
    course_id: courseId,
    module_id: moduleId,
    forum_id: bound.forumId,
    forum_name: bound.forumName,
    visible: bound.visible,
    ...(discussionId ? {
      discussion_id: discussionId,
      discussion_subject: discussion.subject,
      post_count: discussion.posts.length,
      posts: publicPosts(discussion.posts),
    } : {}),
    proof: targetProof(Boolean(discussionId)),
  });
  const writeProof = (kind, learnerVisible) => ({
    method: kind === "discussion" || kind === "reply" ? "mod_forum_post_form" : STATE_METHODS[kind],
    native_route: kind === "discussion" || kind === "reply" ? POST_FORM_PATH : AJAX_PATH,
    exact_module_binding: "course_modedit_form",
    required_capability: CAPABILITIES[kind],
    dispatch_count: 1,
    readback: kind === "discussion" ? "mod_forum_get_discussion_posts_by_userid" : "mod_forum_get_discussion_posts",
    // Moodle 5.2.2 has no browser-callable read that returns a discussion's
    // locked, pinned, or subscribed state. For those three the saved state is
    // the one Moodle's own set-state method returned after it saved, and the
    // post-list read proves only the exact Forum binding and that no post
    // changed.
    saved_state_source: kind === "discussion" || kind === "reply" ? "native_readback" : "native_set_state_response",
    learner_visible: learnerVisible,
    learner_identity: "never_returned",
  });

  let writeAttempted = false;
  try {
    const context = currentContext();
    if (input?.mode !== "execute" || !context) return failure("moodle_session_unavailable");
    if (!Number.isFinite(input.expiresAt) || Date.now() >= input.expiresAt) return failure("moodle_execution_expired");
    const definition = expectedOperation(input.operation);
    if (!definition) return failure("moodle_operation_refused");
    if (!bindingValid(context, input.binding)) return failure("moodle_binding_mismatch");
    if (input.privateAttachment !== undefined || input.privateConversation !== undefined) {
      return failure("moodle_forum_post_attachment_refused");
    }
    const args = argumentsFor(definition, input.arguments, context.anchorCourseId);
    if (!args) return failure("moodle_forum_post_arguments_invalid");
    const kind = definition.kind;
    const approved = () => Date.now() < input.expiresAt && sameContext(context, currentContext());

    const bound = await bindForum(context, args.courseId, args.moduleId);
    if (bound.limited) return incomplete("moodle_forum_post_incomplete");
    if (bound.error) return failure(bound.error, bound.status);

    let before = null;
    if (args.discussionId) {
      before = await discussionState(context, args.courseId, bound.forumId, args.discussionId);
      if (before.limited) return incomplete("moodle_forum_post_incomplete");
      if (before.error) return failure(before.error, before.status);
    }
    const snapshotDigest = await identityDigest(args.courseId, args.moduleId, bound.forumId, bound.visible, args.discussionId);
    if (kind === "target") {
      return {
        ok: true,
        sent: true,
        status: before?.status ?? bound.status,
        data: targetData(args.courseId, args.moduleId, bound, args.discussionId, before),
        targets: targetsFor(bound.forumName, args.discussionId ? before.subject : ""),
        snapshot_digest: snapshotDigest,
      };
    }
    if (snapshotDigest !== args.expectedDigest) return failure("moodle_expected_digest_mismatch", bound.status);

    const learnerVisible = kind === "discussion" || kind === "reply";
    // A saved discussion or reply is visible to every learner who can see the
    // Forum, and Morrow has no route that removes it.
    if (learnerVisible && bound.visible && args.learnerVisibilityConfirmed !== true) {
      return failure("moodle_forum_learner_visibility_unconfirmed", bound.status);
    }
    if (learnerVisible && FILE_REFERENCE.test(args.messageHtml)) return failure("moodle_forum_post_message_refused", bound.status);
    if (kind === "reply") {
      const parents = before.posts.filter((post) => post.post_id === args.parentPostId);
      if (parents.length !== 1 || parents[0].deleted || parents[0].private_reply) {
        return failure("moodle_forum_post_parent_unavailable", before.status);
      }
    }
    if (!approved()) return failure("moodle_forum_post_context_changed", bound.status);

    if (kind === "lock" || kind === "pin" || kind === "subscription") {
      // public/mod/forum/externallib.php set_lock_state saves time() when
      // targetstate is 0 and clears the lock when it is not, so 0 locks the
      // discussion and 1 unlocks it.
      const methodArgs = kind === "lock"
        ? { forumid: Number(bound.forumId), discussionid: Number(args.discussionId), targetstate: args.targetState ? 0 : 1 }
        : kind === "pin"
          ? { discussionid: Number(args.discussionId), targetstate: args.targetState ? 1 : 0 }
          : { forumid: Number(bound.forumId), discussionid: Number(args.discussionId), targetstate: args.targetState };
      writeAttempted = true;
      const written = await ajax(context, STATE_METHODS[kind], methodArgs);
      if (written.limited) return unconfirmedWrite("moodle_forum_post_write_unconfirmed", written.status);
      if (written.error === "moodle_forum_post_service_refused") {
        return mismatchWrite("moodle_forum_post_state_refused", written.status);
      }
      if (written.error) return unconfirmedWrite("moodle_forum_post_write_unconfirmed", written.status);
      const saved = written.data;
      const savedState = kind === "lock" ? saved.locked
        : kind === "pin" ? saved.pinned
          : object(saved.userstate) ? saved.userstate.subscribed : null;
      // set_lock_state returns the discussion identity and lock state only.
      const savedForumId = kind === "lock" ? bound.forumId : id(saved.forumid);
      if (id(saved.id) !== args.discussionId || savedForumId !== bound.forumId || typeof savedState !== "boolean") {
        return unconfirmedWrite("moodle_forum_post_state_unreadable", written.status);
      }
      const after = await discussionState(context, args.courseId, bound.forumId, args.discussionId);
      if (after.limited || after.error) return unconfirmedWrite("moodle_forum_post_readback_unconfirmed", written.status);
      if (savedState !== args.targetState) return mismatchWrite("moodle_forum_post_state_not_applied", written.status);
      if (stable(publicPosts(before.posts)) !== stable(publicPosts(after.posts))) {
        return mismatchWrite("moodle_forum_post_readback_mismatch", written.status);
      }
      return {
        ok: true,
        sent: true,
        status: written.status,
        data: {
          ...targetData(args.courseId, args.moduleId, bound, args.discussionId, after),
          [args.stateField]: savedState,
          proof: writeProof(kind, false),
        },
        targets: targetsFor(bound.forumName, after.subject),
        snapshot_digest: await identityDigest(args.courseId, args.moduleId, bound.forumId, bound.visible, args.discussionId),
        verification: { schema: "morrow.browser-verification.v1", status: "verified" },
      };
    }

    const ownBefore = kind === "discussion" ? await ownDiscussions(context, args.moduleId) : null;
    if (ownBefore?.limited) return incomplete("moodle_forum_post_incomplete");
    if (ownBefore?.error) return failure(ownBefore.error, ownBefore.status);

    // The native post form, reloaded immediately before dispatch. Every field
    // Morrow sends comes from this form; only the reviewed subject and message
    // are replaced.
    const formEndpoint = kind === "discussion"
      ? urlFor(context, POST_FORM_PATH, { forum: bound.forumId })
      : urlFor(context, POST_FORM_PATH, { reply: args.parentPostId });
    const formPage = await readPage(context, formEndpoint);
    if (formPage.limited) return incomplete("moodle_forum_post_incomplete");
    if (formPage.error) return failure(formPage.error, formPage.status);
    const postAction = urlFor(context, POST_FORM_PATH, {});
    const forms = [...formPage.document.querySelectorAll("form")].filter((form) => {
      if (String(form.getAttribute("method") || "").toLowerCase() !== "post") return false;
      try {
        const action = new URL(form.getAttribute("action") || "", formEndpoint);
        return action.origin === postAction.origin && action.pathname === postAction.pathname
          && !action.search && !action.hash && !action.username && !action.password;
      } catch { return false; }
    });
    if (forms.length !== 1) return failure("moodle_forum_post_form_invalid", formPage.status);
    const form = forms[0];
    const entries = entriesFor(form);
    if (!entries) return failure("moodle_forum_post_form_invalid", formPage.status);
    if (one(entries, "sesskey") !== context.sesskey) return failure("moodle_form_session_mismatch", formPage.status);
    const expectedFields = kind === "discussion"
      ? { course: args.courseId, forum: bound.forumId, discussion: "0", parent: "0", reply: "0", edit: "0" }
      : { course: args.courseId, forum: bound.forumId, discussion: args.discussionId, parent: args.parentPostId, reply: args.parentPostId, edit: "0" };
    if (Object.entries(expectedFields).some(([name, value]) => one(entries, name) !== value)) {
      return failure("moodle_forum_post_form_invalid", formPage.status);
    }
    if (one(entries, "subject") === null || one(entries, "message[text]") === null) {
      return failure("moodle_forum_post_form_invalid", formPage.status);
    }
    // Morrow sends HTML, so it refuses a native editor set to save any other
    // format. FORMAT_HTML is 1 in public/lib/weblib.php.
    if (one(entries, "message[format]") !== "1") return failure("moodle_forum_post_message_format_unsupported", formPage.status);
    if (entries.some(([name, value]) => !TRANSIENT_FIELD.test(name) && value === context.sesskey)) {
      return failure("moodle_forum_post_form_invalid", formPage.status);
    }
    const submits = [...form.querySelectorAll('input[type="submit"][name], button[type="submit"][name]')]
      .filter((element) => !element.disabled && element.name === "submitbutton"
        && typeof element.value === "string" && element.value.length > 0 && element.value.length <= 500);
    if (submits.length !== 1) return failure("moodle_forum_post_form_invalid", formPage.status);

    // Every draft file area this form carries has to be empty and proven
    // empty, because Morrow sends no file with a post and will not save one it
    // did not review.
    const areaNames = new Set();
    for (const control of form.querySelectorAll('[data-fieldtype="filemanager"] input[type="hidden"][name]')) {
      const name = String(control.getAttribute("name") || "");
      if (name) areaNames.add(name);
    }
    for (const [name] of entries) if (/\[itemid\]$/.test(name)) areaNames.add(name);
    for (const name of [...areaNames].sort()) {
      const value = one(entries, name);
      const itemId = value && ID.test(value) ? value : "";
      const listing = itemId ? await draftListing(context, itemId) : null;
      if (!listing || !Number.isSafeInteger(listing.filecount) || listing.filecount < 0 || !Array.isArray(listing.list)) {
        return failure("moodle_forum_post_attachment_area_unverified", formPage.status);
      }
      if (listing.filecount !== 0 || listing.list.length !== 0) {
        return failure("moodle_forum_post_attachment_area_refused", formPage.status);
      }
    }

    if (!approved()) return failure("moodle_forum_post_context_changed", formPage.status);
    const body = new URLSearchParams();
    for (const [name, value] of entries) {
      if (name === "subject") { body.append(name, args.subject); continue; }
      if (name === "message[text]") { body.append(name, args.messageHtml); continue; }
      body.append(name, value);
    }
    body.append(submits[0].name, submits[0].value);
    let response;
    try {
      writeAttempted = true;
      response = await fetch(postAction, {
        method: "POST", credentials: "include", cache: "no-store", redirect: "manual",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "text/html" }, body,
      });
    } catch { return unconfirmedWrite("moodle_forum_post_write_unconfirmed"); }
    if (!sameContext(context, currentContext())) return unconfirmedWrite("moodle_forum_post_write_unconfirmed", response.status);
    // Chromium reports a manual same-origin POST redirect as opaqueredirect and
    // does not follow it. A fixed native endpoint and the readback below are
    // the confirmation; Morrow never opens the discussion route Moodle names.
    let sentStatus;
    if (response.type === "opaqueredirect") {
      sentStatus = undefined;
    } else if ([301, 302, 303, 307, 308].includes(response.status)) {
      let redirect;
      try { redirect = new URL(response.headers.get("location") || "", postAction); } catch { redirect = null; }
      if (!redirect || redirect.origin !== context.origin || !redirect.pathname.startsWith(`${context.basePath}/`)) {
        return unconfirmedWrite("moodle_forum_post_write_unconfirmed", response.status);
      }
      sentStatus = response.status;
    } else {
      return unconfirmedWrite("moodle_forum_post_write_unconfirmed", response.status);
    }

    if (kind === "reply") {
      const after = await discussionState(context, args.courseId, bound.forumId, args.discussionId);
      if (after.limited || after.error) return unconfirmedWrite("moodle_forum_post_readback_unconfirmed", sentStatus);
      const priorIds = new Set(before.posts.map((post) => post.post_id));
      const added = after.posts.filter((post) => !priorIds.has(post.post_id));
      const retained = after.posts.filter((post) => priorIds.has(post.post_id));
      if (added.length !== 1 || retained.length !== before.posts.length
        || stable(publicPosts(before.posts)) !== stable(publicPosts(retained))) {
        return mismatchWrite("moodle_forum_post_readback_mismatch", sentStatus);
      }
      const saved = added[0];
      if (saved.parent_post_id !== args.parentPostId || saved.subject !== args.subject || saved.message !== args.messageHtml
        || saved.deleted || saved.private_reply || saved.attachment_count !== 0) {
        return mismatchWrite("moodle_forum_post_readback_mismatch", sentStatus);
      }
      return {
        ok: true,
        sent: true,
        status: Number.isInteger(sentStatus) ? sentStatus : after.status,
        data: {
          ...targetData(args.courseId, args.moduleId, bound, args.discussionId, after),
          created_post_id: saved.post_id,
          proof: writeProof("reply", true),
        },
        targets: targetsFor(bound.forumName, after.subject),
        snapshot_digest: await identityDigest(args.courseId, args.moduleId, bound.forumId, bound.visible, args.discussionId),
        verification: { schema: "morrow.browser-verification.v1", status: "verified" },
      };
    }

    const ownAfter = await ownDiscussions(context, args.moduleId);
    if (ownAfter.limited || ownAfter.error) return unconfirmedWrite("moodle_forum_post_readback_unconfirmed", sentStatus);
    const added = [...ownAfter.discussions.keys()].filter((entry) => !ownBefore.discussions.has(entry));
    if (added.length !== 1) return unconfirmedWrite("moodle_forum_post_readback_unconfirmed", sentStatus);
    const createdId = added[0];
    if (ownAfter.discussions.get(createdId) !== args.subject) return mismatchWrite("moodle_forum_post_readback_mismatch", sentStatus);
    const created = await discussionState(context, args.courseId, bound.forumId, createdId);
    if (created.limited || created.error) return unconfirmedWrite("moodle_forum_post_readback_unconfirmed", sentStatus);
    const saved = created.posts.length === 1 ? created.posts[0] : null;
    if (!saved || saved.parent_post_id !== "" || saved.subject !== args.subject || saved.message !== args.messageHtml
      || saved.deleted || saved.private_reply || saved.attachment_count !== 0) {
      return mismatchWrite("moodle_forum_post_readback_mismatch", sentStatus);
    }
    return {
      ok: true,
      sent: true,
      status: Number.isInteger(sentStatus) ? sentStatus : created.status,
      data: {
        ...targetData(args.courseId, args.moduleId, bound, createdId, created),
        created_post_id: saved.post_id,
        proof: writeProof("discussion", true),
      },
      targets: targetsFor(bound.forumName, created.subject),
      snapshot_digest: await identityDigest(args.courseId, args.moduleId, bound.forumId, bound.visible, createdId),
      verification: { schema: "morrow.browser-verification.v1", status: "verified" },
    };
  } catch (error) {
    if (writeAttempted) return unconfirmedWrite("moodle_forum_post_write_unconfirmed");
    const message = String(error?.message || error);
    return failure(message.startsWith("moodle_") ? message : "moodle_forum_post_execution_failed");
  }
}
