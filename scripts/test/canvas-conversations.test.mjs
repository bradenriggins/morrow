#!/usr/bin/env node
import assert from "node:assert/strict";

import {
  CANVAS_CONVERSATION_PRIVATE_SCHEMA,
  PRIVATE_CANVAS_CONVERSATION_OPERATION,
  PRIVATE_CANVAS_CONVERSATION_TOOL,
  canvasConversationOperationMatches,
  executeCanvasConversationInPage,
  normalizeCanvasConversationPrivatePayload,
  validCanvasConversationPrivatePayload,
} from "../../connector/extension/src/canvas-conversations.js";

const binding = Object.freeze({
  origin: "https://canvas.example.test",
  courseId: "101",
  principalId: "7",
  sessionGeneration: 3,
});

const original = { location: globalThis.location, document: globalThis.document, fetch: globalThis.fetch };

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

function install(fetchImplementation) {
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    writable: true,
    value: new URL("https://canvas.example.test/courses/101"),
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    writable: true,
    value: { cookie: "_csrf_token=canvas-test-token" },
  });
  globalThis.fetch = fetchImplementation;
}

function request(payload) {
  return { binding, payload, expiresAt: Date.now() + 30_000 };
}

function courseAndProfile(url) {
  if (url.pathname === "/api/v1/users/self/profile") return json({ id: "7" });
  if (url.pathname === "/api/v1/courses/101") return json({ id: "101", name: "Biology" });
  return null;
}

try {
  {
    const normalized = normalizeCanvasConversationPrivatePayload({
      schema: CANVAS_CONVERSATION_PRIVATE_SCHEMA,
      action: "create",
      courseId: "101",
      recipients: [201, "group_12_students", "section_9_tas", "course_101_teachers"],
      body: "Course update",
    });
    assert.deepEqual(normalized?.recipients, ["201", "group_12_students", "section_9_tas", "course_101_teachers"]);
    assert.equal(validCanvasConversationPrivatePayload({
      schema: CANVAS_CONVERSATION_PRIVATE_SCHEMA,
      action: "create",
      courseId: "101",
      recipients: ["Student_A1"],
      body: "Must be resolved before the bridge.",
    }), false, "legacy Student_* tokens must never enter the browser-only payload");
    assert.equal(canvasConversationOperationMatches({
      toolName: PRIVATE_CANVAS_CONVERSATION_TOOL,
      key: PRIVATE_CANVAS_CONVERSATION_OPERATION,
      method: "POST",
      path: "/morrow/private/courses/{course_id}/conversations",
      service: "canvas_private_conversation",
      readOnly: false,
    }, normalized), true, "only Morrow's exact private Inbox adapter can carry the private payload");
    assert.equal(canvasConversationOperationMatches({
      toolName: "canvas_create_conversation",
      key: "POST /v1/conversations#create_conversation",
      method: "POST",
      path: "/v1/conversations",
      readOnly: true,
    }, normalized), false, "the public Canvas create route cannot carry the private payload");
  }

  {
    const calls = [];
    install(async (urlValue, options = {}) => {
      const url = new URL(String(urlValue));
      calls.push({ url, options });
      const standard = courseAndProfile(url);
      if (standard) return standard;
      if (url.pathname === "/api/v1/courses/101/users/201") return json({ id: "201" });
      if (url.pathname === "/api/v1/groups/12") return json({ id: "12", course_id: "101" });
      if (url.pathname === "/api/v1/sections/9") return json({ id: "9", course_id: "101" });
      if (url.pathname === "/api/v1/conversations" && options.method === "POST") {
        assert.equal(options.headers.get("X-CSRF-Token"), "canvas-test-token");
        assert.deepEqual(JSON.parse(options.body), {
          recipients: ["201", "group_12_students", "section_9_tas", "course_101_teachers"],
          body: "Course update",
          context_code: "course_101",
          subject: "Week 3",
          group_conversation: true,
        }, "multiple recipients retain legacy group-conversation behavior unless explicitly set");
        return json([{ id: "901", last_message: { id: "990" } }]);
      }
      if (url.pathname === "/api/v1/conversations/901" && url.searchParams.get("auto_mark_as_read") === "false") {
        return json({
          id: "901",
          context_code: "course_101",
          subject: "Week 3",
          messages: [{ id: "990", author_id: "7", body: "Course update" }],
        });
      }
      throw new Error(`unexpected request ${options.method || "GET"} ${url}`);
    });
    const result = await executeCanvasConversationInPage(request({
      schema: CANVAS_CONVERSATION_PRIVATE_SCHEMA,
      action: "create",
      courseId: "101",
      recipients: ["201", "group_12_students", "section_9_tas", "course_101_teachers"],
      subject: "Week 3",
      body: "Course update",
    }));
    assert.equal(result.ok, true);
    assert.equal(result.verification?.status, "verified");
    assert.deepEqual(result.data?.conversations, [{ conversation_id: "901", message_id: "990" }]);
    assert.equal(JSON.stringify(result).includes("201"), false, "provider recipient ids must not return from the browser executor");
    assert.equal(calls.filter((call) => call.options.method === "POST").length, 1);
  }

  {
    let posts = 0;
    install(async (urlValue, options = {}) => {
      const url = new URL(String(urlValue));
      const standard = courseAndProfile(url);
      if (standard) return standard;
      if (url.pathname === "/api/v1/sections/88") return json({ id: "88", course_id: "202" });
      if (options.method === "POST") posts += 1;
      throw new Error(`unexpected request ${options.method || "GET"} ${url}`);
    });
    const result = await executeCanvasConversationInPage(request({
      schema: CANVAS_CONVERSATION_PRIVATE_SCHEMA,
      action: "create",
      courseId: "101",
      recipients: ["section_88_students"],
      body: "Do not send outside the current course.",
    }));
    assert.equal(result.ok, false);
    assert.equal(result.sent, false);
    assert.equal(result.error, "canvas_conversation_recipient_wrong_course");
    assert.equal(posts, 0, "a foreign section recipient must fail before the Inbox POST");
  }

  {
    let conversationReads = 0;
    let posts = 0;
    install(async (urlValue, options = {}) => {
      const url = new URL(String(urlValue));
      const standard = courseAndProfile(url);
      if (standard) return standard;
      if (url.pathname === "/api/v1/conversations/77" && url.searchParams.get("auto_mark_as_read") === "false") {
        conversationReads += 1;
        return json({
          id: "77",
          context_code: "course_101",
          messages: conversationReads === 1
            ? [{ id: "70", author_id: "7", body: "Follow up" }]
            : [{ id: "70", author_id: "7", body: "Follow up" }, { id: "71", author_id: "7", body: "Follow up" }],
        });
      }
      if (url.pathname === "/api/v1/conversations/77/add_message" && options.method === "POST") {
        posts += 1;
        assert.deepEqual(JSON.parse(options.body), { body: "Follow up" });
        return json({ id: "77", messages: [{ id: "71" }] });
      }
      throw new Error(`unexpected request ${options.method || "GET"} ${url}`);
    });
    const result = await executeCanvasConversationInPage(request({
      schema: CANVAS_CONVERSATION_PRIVATE_SCHEMA,
      action: "reply",
      courseId: "101",
      conversationId: "77",
      body: "Follow up",
    }));
    assert.equal(result.ok, true);
    assert.equal(posts, 1);
    assert.equal(conversationReads, 2, "reply must read before and after the one POST");
  }

  {
    let posts = 0;
    install(async (urlValue, options = {}) => {
      const url = new URL(String(urlValue));
      const standard = courseAndProfile(url);
      if (standard) return standard;
      if (url.pathname === "/api/v1/groups/88") return json({ id: "88", course_id: "202" });
      if (options.method === "POST") posts += 1;
      throw new Error(`unexpected request ${options.method || "GET"} ${url}`);
    });
    const result = await executeCanvasConversationInPage(request({
      schema: CANVAS_CONVERSATION_PRIVATE_SCHEMA,
      action: "reply",
      courseId: "101",
      conversationId: "77",
      recipients: ["group_88_students"],
      body: "Do not add an out-of-course recipient.",
    }));
    assert.equal(result.ok, false);
    assert.equal(result.sent, false);
    assert.equal(result.error, "canvas_conversation_recipient_wrong_course");
    assert.equal(posts, 0, "reply recipients must be current-course scoped before the thread or POST");
  }

  {
    let conversationReads = 0;
    let posts = 0;
    install(async (urlValue, options = {}) => {
      const url = new URL(String(urlValue));
      const standard = courseAndProfile(url);
      if (standard) return standard;
      if (url.pathname === "/api/v1/conversations/77" && url.searchParams.get("auto_mark_as_read") === "false") {
        conversationReads += 1;
        return json({
          id: "77",
          context_code: "course_101",
          messages: [{ id: "70", author_id: "7", body: "Follow up" }],
        });
      }
      if (url.pathname === "/api/v1/conversations/77/add_message" && options.method === "POST") {
        posts += 1;
        return json({ id: "77", messages: [{ id: "71" }] });
      }
      throw new Error(`unexpected request ${options.method || "GET"} ${url}`);
    });
    const result = await executeCanvasConversationInPage(request({
      schema: CANVAS_CONVERSATION_PRIVATE_SCHEMA,
      action: "reply",
      courseId: "101",
      conversationId: "77",
      body: "Follow up",
    }));
    assert.equal(result.ok, false);
    assert.equal(result.sent, true);
    assert.equal(result.outcomeUnknown, true, "a successful POST without a new matching message remains uncertain");
    assert.equal(result.error, "canvas_conversation_readback_message_mismatch");
    assert.equal(posts, 1, "readback mismatch must not trigger a second POST");
  }

  console.log("canvas conversation execution assertions passed");
} finally {
  Object.defineProperty(globalThis, "location", { configurable: true, writable: true, value: original.location });
  Object.defineProperty(globalThis, "document", { configurable: true, writable: true, value: original.document });
  globalThis.fetch = original.fetch;
}
