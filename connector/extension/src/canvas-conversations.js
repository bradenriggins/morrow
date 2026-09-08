/**
 * Canvas Inbox execution boundary.
 *
 * Provenance: adapted from the behavior contract in Morrow Legacy
 * `7275bfbc1c24dd6baff58f9435f1ce5a50fbb5d4`, specifically
 * `extension/providers/canvas/tools/handlers/conversations.js` and
 * `extension/domains/conversations/messaging.js`. This module deliberately
 * excludes the legacy account, chat, and state layers.
 */

export const CANVAS_CONVERSATION_PRIVATE_SCHEMA = "morrow.canvas-conversation.private.v1";
export const PRIVATE_CANVAS_CONVERSATION_TOOL = "canvas_send_private_conversation";
export const PRIVATE_CANVAS_CONVERSATION_OPERATION = "canvas.private.conversation.send.v1";

const DECIMAL_ID = /^[1-9][0-9]{0,18}$/;
const RECIPIENT_CONTEXT = /^(course|section|group)_([1-9][0-9]{0,18})(?:_(students|teachers|tas|observers|designers))?$/;

function exactId(value) {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === "string" && DECIMAL_ID.test(value)) return value;
  return null;
}

function exactText(value, allowEmpty = false) {
  if (typeof value !== "string") return null;
  return allowEmpty || value.trim() ? value : null;
}

function exactBoolean(value) {
  return value === undefined || typeof value === "boolean";
}

function recipient(value) {
  const raw = exactId(value);
  if (raw) return raw;
  if (typeof value !== "string") return null;
  const match = RECIPIENT_CONTEXT.exec(value);
  return match ? `${match[1]}_${match[2]}${match[3] ? `_${match[3]}` : ""}` : null;
}

function exactObject(value, fields) {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).every((key) => fields.includes(key));
}

/**
 * Normalizes the sealed browser-only payload. It accepts resolved Canvas user
 * ids and Canvas's course, section, and group recipient forms, but never a
 * learner token or public tool argument.
 */
export function normalizeCanvasConversationPrivatePayload(value) {
  if (!exactObject(value, ["schema", "action", "courseId", "recipients", "subject", "body", "groupConversation", "forceNew", "conversationId"])
    || value.schema !== CANVAS_CONVERSATION_PRIVATE_SCHEMA) return null;
  const courseId = exactId(value.courseId);
  const action = value.action;
  const body = exactText(value.body);
  if (!courseId || !body || (action !== "create" && action !== "reply")) return null;
  if (!exactBoolean(value.groupConversation) || !exactBoolean(value.forceNew)) return null;
  if (value.subject !== undefined && exactText(value.subject, true) === null) return null;
  if (value.recipients !== undefined && !Array.isArray(value.recipients)) return null;
  const recipients = value.recipients === undefined ? [] : value.recipients.map(recipient);
  if (recipients.some((entry) => !entry)) return null;

  if (action === "create") {
    if (!recipients.length || value.conversationId !== undefined) return null;
    return Object.freeze({
      schema: CANVAS_CONVERSATION_PRIVATE_SCHEMA,
      action,
      courseId,
      recipients: Object.freeze([...recipients]),
      body,
      ...(value.subject === undefined ? {} : { subject: value.subject }),
      ...(value.groupConversation === undefined ? {} : { groupConversation: value.groupConversation }),
      ...(value.forceNew === undefined ? {} : { forceNew: value.forceNew }),
    });
  }

  const conversationId = exactId(value.conversationId);
  if (!conversationId || value.subject !== undefined || value.groupConversation !== undefined || value.forceNew !== undefined) return null;
  return Object.freeze({
    schema: CANVAS_CONVERSATION_PRIVATE_SCHEMA,
    action,
    courseId,
    conversationId,
    recipients: Object.freeze([...recipients]),
    body,
  });
}

export function validCanvasConversationPrivatePayload(value) {
  return normalizeCanvasConversationPrivatePayload(value) !== null;
}

/** Strictly binds this private payload to Morrow's one non-public Inbox adapter. */
export function canvasConversationOperationMatches(operation, payloadValue) {
  const payload = normalizeCanvasConversationPrivatePayload(payloadValue);
  if (!operation || !payload) return false;
  return operation.toolName === PRIVATE_CANVAS_CONVERSATION_TOOL
    && operation.key === PRIVATE_CANVAS_CONVERSATION_OPERATION
    && operation.method === "POST" && operation.path === "/morrow/private/courses/{course_id}/conversations"
    && operation.service === "canvas_private_conversation" && operation.readOnly === false;
}

function errorCode(error, fallback) {
  const text = String(error?.message || "");
  return /^[a-z0-9_]{1,120}$/i.test(text) ? text : fallback;
}

function failure(error, sent, status) {
  return {
    ok: false,
    sent,
    ...(Number.isInteger(status) ? { status } : {}),
    ...(sent ? { outcomeUnknown: true } : {}),
    error: errorCode(error, sent ? "canvas_conversation_readback_incomplete" : "canvas_conversation_preflight_failed"),
  };
}

/**
 * Runs in Canvas's main world through chrome.scripting.executeScript. Keep all
 * helpers nested: injected functions do not retain imported module bindings.
 */
export async function executeCanvasConversationInPage(input) {
  const privateSchema = "morrow.canvas-conversation.private.v1";
  const decimalId = /^[1-9][0-9]{0,18}$/;
  const recipientContext = /^(course|section|group)_([1-9][0-9]{0,18})(?:_(students|teachers|tas|observers|designers))?$/;

  const fail = (code) => { throw new Error(code); };
  const id = (value) => {
    if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
    return typeof value === "string" && decimalId.test(value) ? value : null;
  };
  const text = (value, allowEmpty = false) => typeof value === "string" && (allowEmpty || value.trim()) ? value : null;
  const ownObject = (value, fields) => !!value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).every((key) => fields.includes(key));
  const normalizedRecipient = (value) => {
    const numeric = id(value);
    if (numeric) return numeric;
    if (typeof value !== "string") return null;
    const match = recipientContext.exec(value);
    return match ? `${match[1]}_${match[2]}${match[3] ? `_${match[3]}` : ""}` : null;
  };
  const payload = (value) => {
    if (!ownObject(value, ["schema", "action", "courseId", "recipients", "subject", "body", "groupConversation", "forceNew", "conversationId"])
      || value.schema !== privateSchema) return null;
    const courseId = id(value.courseId);
    const body = text(value.body);
    if (!courseId || !body || (value.action !== "create" && value.action !== "reply")
      || (value.groupConversation !== undefined && typeof value.groupConversation !== "boolean")
      || (value.forceNew !== undefined && typeof value.forceNew !== "boolean")
      || (value.subject !== undefined && text(value.subject, true) === null)
      || (value.recipients !== undefined && !Array.isArray(value.recipients))) return null;
    const recipients = (value.recipients || []).map(normalizedRecipient);
    if (recipients.some((entry) => !entry)) return null;
    if (value.action === "create") {
      if (!recipients.length || value.conversationId !== undefined) return null;
      return { action: value.action, courseId, recipients, body, ...(value.subject === undefined ? {} : { subject: value.subject }), ...(value.groupConversation === undefined ? {} : { groupConversation: value.groupConversation }), ...(value.forceNew === undefined ? {} : { forceNew: value.forceNew }) };
    }
    const conversationId = id(value.conversationId);
    if (!conversationId || value.subject !== undefined || value.groupConversation !== undefined || value.forceNew !== undefined) return null;
    return { action: value.action, courseId, conversationId, recipients, body };
  };
  const request = ownObject(input, ["binding", "payload", "expiresAt"]) ? input : null;
  const binding = request?.binding;
  const instruction = payload(request?.payload);
  if (!ownObject(binding, ["origin", "courseId", "principalId", "sessionGeneration"])
    || typeof binding.origin !== "string" || !id(binding.courseId) || !id(binding.principalId)
    || !Number.isSafeInteger(binding.sessionGeneration) || binding.sessionGeneration < 1
    || !instruction || instruction.courseId !== binding.courseId) {
    return { ok: false, sent: false, error: "canvas_conversation_private_payload_invalid" };
  }

  const currentCourseId = () => {
    const match = location.pathname.match(/(?:^|\/)courses\/([1-9][0-9]*)(?:\/|$)/);
    return match ? match[1] : null;
  };
  const readJson = async (response, code) => {
    const raw = await response.text();
    try { return raw ? JSON.parse(raw) : null; } catch { fail(code); }
  };
  const get = async (path, code) => {
    let response;
    try {
      response = await fetch(new URL(path, location.origin), {
        credentials: "include", cache: "no-store", redirect: "error", headers: { Accept: "application/json+canvas-string-ids" },
      });
    } catch { fail(code); }
    if (!response.ok) fail(code);
    return await readJson(response, code);
  };
  const profile = async () => {
    const value = await get("/api/v1/users/self/profile", "canvas_conversation_profile_unavailable");
    const principalId = id(value?.id);
    if (!principalId || principalId !== binding.principalId) fail("canvas_conversation_principal_changed");
    return principalId;
  };
  const currentCourse = async () => {
    const visibleCourseId = currentCourseId();
    if (!visibleCourseId || visibleCourseId !== binding.courseId) fail("canvas_conversation_course_changed");
    const course = await get(`/api/v1/courses/${binding.courseId}`, "canvas_conversation_course_unavailable");
    if (id(course?.id) !== binding.courseId) fail("canvas_conversation_course_changed");
  };
  const validateBinding = async () => {
    if (location.origin !== binding.origin) fail("canvas_conversation_origin_changed");
    await profile();
    await currentCourse();
  };
  const courseIdFromResource = (value) => id(value?.course_id) || id(value?.course?.id);
  const validateRecipients = async () => {
    for (const entry of instruction.recipients) {
      const userId = id(entry);
      if (userId) {
        const user = await get(`/api/v1/courses/${binding.courseId}/users/${userId}`, "canvas_conversation_recipient_unavailable");
        if (id(user?.id) !== userId) fail("canvas_conversation_recipient_unavailable");
        continue;
      }
      const match = recipientContext.exec(entry);
      if (!match) fail("canvas_conversation_recipient_invalid");
      const [, type, resourceId] = match;
      if (type === "course") {
        if (resourceId !== binding.courseId) fail("canvas_conversation_recipient_wrong_course");
        continue;
      }
      const resource = await get(`/api/v1/${type}s/${resourceId}`, "canvas_conversation_recipient_unavailable");
      if (courseIdFromResource(resource) !== binding.courseId) fail("canvas_conversation_recipient_wrong_course");
    }
  };
  const conversationPath = (conversationId) => `/api/v1/conversations/${conversationId}?auto_mark_as_read=false`;
  const normalizedBody = (value) => String(value ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  const sameBody = (left, right) => {
    const expected = normalizedBody(right);
    return !!expected && normalizedBody(left) === expected;
  };
  const contextMatches = (conversation, conversationId) => id(conversation?.id) === conversationId
    && conversation?.context_code === `course_${binding.courseId}`;
  const csrf = () => {
    const cookie = typeof document?.cookie === "string"
      ? document.cookie.split(";").map((entry) => entry.trim()).find((entry) => entry.startsWith("_csrf_token="))
      : null;
    if (!cookie) fail("canvas_conversation_csrf_missing");
    try { return decodeURIComponent(cookie.slice("_csrf_token=".length)); } catch { fail("canvas_conversation_csrf_invalid"); }
  };
  const post = async (path, body, csrfToken) => {
    const headers = new Headers({
      Accept: "application/json+canvas-string-ids",
      "Content-Type": "application/json;charset=UTF-8",
      "X-CSRF-Token": csrfToken,
      "X-Requested-With": "XMLHttpRequest",
    });
    return await fetch(new URL(path, location.origin), { method: "POST", credentials: "include", cache: "no-store", redirect: "error", headers, body: JSON.stringify(body) });
  };
  const responseMessageId = (conversation) => {
    const direct = id(conversation?.last_message?.id);
    if (direct) return direct;
    const messages = Array.isArray(conversation?.messages) ? conversation.messages : [];
    return id(messages.at(-1)?.id);
  };
  const verify = async (conversationId, messageId, beforeMessageIds = null) => {
    const conversation = await get(conversationPath(conversationId), "canvas_conversation_readback_incomplete");
    if (!contextMatches(conversation, conversationId)) fail("canvas_conversation_readback_scope_mismatch");
    if (instruction.action === "create" && instruction.subject !== undefined && String(conversation?.subject ?? "") !== instruction.subject) {
      fail("canvas_conversation_readback_subject_mismatch");
    }
    const messages = Array.isArray(conversation?.messages) ? conversation.messages : [];
    const found = messages.find((message) => {
      const observedMessageId = id(message?.id);
      return observedMessageId === messageId && (!beforeMessageIds || !beforeMessageIds.has(observedMessageId))
        && id(message?.author_id) === binding.principalId && sameBody(message?.body, instruction.body);
    });
    if (!found) fail("canvas_conversation_readback_message_mismatch");
    return { conversation_id: conversationId, message_id: messageId };
  };

  let sent = false;
  let responseStatus;
  try {
    await validateBinding();
    await validateRecipients();

    let beforeMessageIds = null;
    if (instruction.action === "reply") {
      const before = await get(conversationPath(instruction.conversationId), "canvas_conversation_thread_unavailable");
      if (!contextMatches(before, instruction.conversationId)) fail("canvas_conversation_thread_wrong_course");
      beforeMessageIds = new Set((Array.isArray(before.messages) ? before.messages : []).map((message) => id(message?.id)).filter(Boolean));
    }

    await validateBinding();
    if (!Number.isSafeInteger(request.expiresAt) || Date.now() >= request.expiresAt) fail("canvas_conversation_request_expired");
    const body = instruction.action === "create"
      ? {
        recipients: instruction.recipients,
        body: instruction.body,
        context_code: `course_${binding.courseId}`,
        ...(instruction.subject === undefined ? {} : { subject: instruction.subject }),
        ...(instruction.groupConversation === undefined
          ? (instruction.recipients.length > 1 ? { group_conversation: true } : {})
          : { group_conversation: instruction.groupConversation }),
        ...(instruction.forceNew === undefined ? {} : { force_new: instruction.forceNew }),
      }
      : { body: instruction.body, ...(instruction.recipients.length ? { recipients: instruction.recipients } : {}) };
    const path = instruction.action === "create" ? "/api/v1/conversations" : `/api/v1/conversations/${instruction.conversationId}/add_message`;
    const csrfToken = csrf();
    sent = true;
    let response;
    try { response = await post(path, body, csrfToken); } catch { return { ok: false, sent: true, outcomeUnknown: true, error: "canvas_conversation_write_response_unknown" }; }
    responseStatus = response.status;
    if (!response.ok) return { ok: false, sent: true, status: response.status, error: "canvas_conversation_write_rejected" };
    const responseData = await readJson(response, "canvas_conversation_write_response_invalid");
    const conversations = instruction.action === "create"
      ? (Array.isArray(responseData) ? responseData : []).map((entry) => entry?.conversation ?? entry)
      : [responseData];
    const created = conversations.map((conversation) => ({
      conversationId: id(conversation?.id) || (instruction.action === "reply" ? instruction.conversationId : null),
      messageId: responseMessageId(conversation),
    }));
    if (!created.length || created.some((entry) => !entry.conversationId || !entry.messageId)
      || new Set(created.map((entry) => entry.conversationId)).size !== created.length) {
      fail("canvas_conversation_write_response_invalid");
    }

    await validateBinding();
    const verified = [];
    for (const entry of created) verified.push(await verify(entry.conversationId, entry.messageId, beforeMessageIds));
    await validateBinding();
    return {
      ok: true,
      sent: true,
      status: responseStatus,
      data: { action: instruction.action, conversations: verified },
      verification: {
        schema: "morrow.browser-verification.v1",
        status: "verified",
        strategy: "canvas-conversation-message-readback",
        conversations: verified,
      },
    };
  } catch (error) {
    return failure(error, sent, responseStatus);
  }
}
