import assert from "node:assert/strict";
import test from "node:test";

import { executeCanvasConversationInPage } from "../../connector/extension/src/canvas-conversations.js";
import { executeCanvasCourseFileTextInPage } from "../../connector/extension/src/canvas-file-content.js";
import { executeCanvasCourseSummaryInPage } from "../../connector/extension/src/canvas-course-summary-read.js";
import { executeMoodleBigBlueButtonInPage } from "../../connector/extension/src/moodle-bbb-executor.js";
import { executeMoodleLtiInPage } from "../../connector/extension/src/moodle-lti-executor.js";
import { executeMoodleQbankInPage } from "../../connector/extension/src/moodle-qbank-executor.js";
import { executeMoodleCourseGroupsInPage } from "../../connector/extension/src/moodle-groups-read.js";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const original = {
  document: globalThis.document,
  fetch: globalThis.fetch,
  location: globalThis.location,
  M: globalThis.M,
};

const canvasInput = (expiresAt) => ({
  binding: {
    origin: "https://moodle.example.test",
    courseId: "101",
    principalId: "7",
    sessionGeneration: 1,
  },
  payload: {
    schema: "morrow.canvas-conversation.private.v1",
    action: "create",
    courseId: "101",
    recipients: ["201"],
    body: "Bounded response test",
  },
  expiresAt,
});

const moodleBinding = {
  origin: "https://moodle.example.test",
  siteUrl: "https://moodle.example.test/",
  principalId: "3",
  courseId: "2",
};

const runners = [
  {
    name: "Canvas conversations",
    run: (expiresAt) => executeCanvasConversationInPage(canvasInput(expiresAt)),
    tooLarge: "canvas_conversation_response_too_large",
    ordinaryFailure: "canvas_conversation_profile_unavailable",
  },
  {
    name: "Moodle BigBlueButton",
    run: (expiresAt) => executeMoodleBigBlueButtonInPage({
      mode: "execute",
      expiresAt,
      binding: moodleBinding,
      operation: {
        key: "moodle.form.course.modedit.bigbluebuttonbn.read.v1",
        toolName: "moodle_get_bigbluebuttonbn",
        provider: "moodle",
        readOnly: true,
      },
      arguments: { course_id: "2", module_id: "3" },
    }),
    tooLarge: "moodle_bigbluebuttonbn_response_too_large",
    ordinaryFailure: "moodle_bigbluebuttonbn_course_state_unavailable",
  },
  {
    name: "Moodle LTI",
    run: (expiresAt) => executeMoodleLtiInPage({
      mode: "execute",
      expiresAt,
      binding: moodleBinding,
      operation: {
        key: "moodle.form.course.modedit.lti.read.v1",
        toolName: "moodle_get_lti",
        provider: "moodle",
        readOnly: true,
      },
      arguments: { course_id: "2", module_id: "3" },
    }),
    tooLarge: "moodle_lti_response_too_large",
    ordinaryFailure: "moodle_lti_course_state_unavailable",
  },
  {
    name: "Moodle Qbank",
    run: (expiresAt) => executeMoodleQbankInPage({
      mode: "execute",
      expiresAt,
      binding: moodleBinding,
      operation: {
        key: "moodle.form.course.modedit.qbank.read.v1",
        toolName: "moodle_get_qbank_activity",
        provider: "moodle",
        readOnly: true,
      },
      arguments: { course_id: "2", module_id: "3" },
    }),
    tooLarge: "moodle_qbank_response_too_large",
    ordinaryFailure: "moodle_qbank_course_state_unavailable",
  },
];

function installContext() {
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    writable: true,
    value: new URL("https://moodle.example.test/courses/101"),
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    writable: true,
    value: {
      body: { className: "path-course course-1" },
      cookie: "_csrf_token=canvas-test-token",
    },
  });
  globalThis.M = {
    cfg: {
      wwwroot: "https://moodle.example.test",
      sesskey: "bounded-response-session",
      userId: 3,
      courseId: 1,
    },
  };
}

function responseStream(chunks = [], { declared, close = true, stalledCancel = false } = {}) {
  let cancelled = 0;
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      if (close) controller.close();
    },
    cancel() {
      cancelled += 1;
      return stalledCancel ? new Promise(() => {}) : undefined;
    },
  });
  const response = new Response(body, {
    status: 200,
    ...(declared === undefined ? {} : { headers: { "Content-Length": String(declared) } }),
  });
  return { response, cancelled: () => cancelled };
}

test("browser executors bound response bytes and cancel oversized or stalled streams", async () => {
  installContext();
  try {
    for (const runner of runners) {
      for (const size of [MAX_RESPONSE_BYTES - 1, MAX_RESPONSE_BYTES]) {
        const stream = responseStream([new Uint8Array(size)]);
        globalThis.fetch = async () => stream.response;
        const result = await runner.run(Date.now() + 5_000);
        assert.equal(result.error, runner.ordinaryFailure, `${runner.name} refused a response at ${size} bytes as oversized`);
        assert.equal(stream.cancelled(), 0, `${runner.name} cancelled a response within its byte limit`);
      }

      const declared = responseStream([], { declared: MAX_RESPONSE_BYTES + 1, close: false });
      globalThis.fetch = async () => declared.response;
      assert.equal((await runner.run(Date.now() + 5_000)).error, runner.tooLarge, `${runner.name} ignored an oversized Content-Length`);
      assert.equal(declared.cancelled(), 1, `${runner.name} did not cancel a declared oversized response`);

      const streamed = responseStream([new Uint8Array(MAX_RESPONSE_BYTES), new Uint8Array(1)], { close: false });
      globalThis.fetch = async () => streamed.response;
      assert.equal((await runner.run(Date.now() + 5_000)).error, runner.tooLarge, `${runner.name} did not stop at the first streamed byte above its limit`);
      assert.equal(streamed.cancelled(), 1, `${runner.name} did not cancel an oversized stream`);

      const stalled = responseStream([], { close: false, stalledCancel: true });
      globalThis.fetch = async () => stalled.response;
      assert.equal((await runner.run(Date.now() + 25)).error, runner.name === "Canvas conversations"
        ? "canvas_conversation_request_expired"
        : "moodle_execution_expired", `${runner.name} did not stop a stalled response at its deadline`);
      assert.equal(stalled.cancelled(), 1, `${runner.name} did not cancel a stalled response`);
    }
  } finally {
    Object.defineProperty(globalThis, "location", { configurable: true, writable: true, value: original.location });
    Object.defineProperty(globalThis, "document", { configurable: true, writable: true, value: original.document });
    globalThis.fetch = original.fetch;
    globalThis.M = original.M;
  }
});

test("a newly audited Canvas metadata path refuses and cancels an oversized stream", async () => {
  installContext();
  const asCanvasResponse = (response) => ({
    ok: response.ok,
    status: response.status,
    headers: response.headers,
    body: response.body,
    url: "https://moodle.example.test/api/v1/users/self/profile",
  });
  try {
    const declared = responseStream([], { declared: MAX_RESPONSE_BYTES + 1, close: false });
    globalThis.fetch = async () => asCanvasResponse(declared.response);
    const declaredResult = await executeCanvasCourseFileTextInPage({
      binding: { origin: "https://moodle.example.test", courseId: "101", principalId: "7" },
      fileId: "3",
    });
    assert.equal(declaredResult.error, "canvas_file_metadata_response_too_large");
    assert.equal(declared.cancelled(), 1);

    const streamed = responseStream([new Uint8Array(MAX_RESPONSE_BYTES), new Uint8Array(1)], { close: false });
    globalThis.fetch = async () => asCanvasResponse(streamed.response);
    const streamedResult = await executeCanvasCourseFileTextInPage({
      binding: { origin: "https://moodle.example.test", courseId: "101", principalId: "7" },
      fileId: "3",
    });
    assert.equal(streamedResult.error, "canvas_file_metadata_response_too_large");
    assert.equal(streamed.cancelled(), 1);
  } finally {
    Object.defineProperty(globalThis, "location", { configurable: true, writable: true, value: original.location });
    Object.defineProperty(globalThis, "document", { configurable: true, writable: true, value: original.document });
    globalThis.fetch = original.fetch;
    globalThis.M = original.M;
  }
});

test("a provider response with malformed UTF-8 is refused before its JSON can drive another request", async () => {
  installContext();
  let requests = 0;
  const invalidJson = responseStream([
    Buffer.concat([Buffer.from('{"id":"7","name":"'), Buffer.from([0xff]), Buffer.from('"}')]),
  ]);
  try {
    globalThis.fetch = async () => {
      requests += 1;
      return invalidJson.response;
    };
    const result = await executeCanvasConversationInPage(canvasInput(Date.now() + 5_000));
    assert.equal(result.error, "canvas_conversation_preflight_failed");
    assert.equal(result.sent, false);
    assert.equal(requests, 1, "malformed profile bytes must stop before the course or recipient reads");
  } finally {
    Object.defineProperty(globalThis, "location", { configurable: true, writable: true, value: original.location });
    Object.defineProperty(globalThis, "document", { configurable: true, writable: true, value: original.document });
    globalThis.fetch = original.fetch;
    globalThis.M = original.M;
  }
});

test("an oversized provider stream cannot hold an executor open through stalled cancellation", async () => {
  installContext();
  let reads = 0;
  let cancellations = 0;
  const body = {
    getReader() {
      return {
        async read() {
          reads += 1;
          return reads === 1
            ? { done: false, value: new Uint8Array(2_000_000) }
            : { done: false, value: new Uint8Array(1) };
        },
        cancel() {
          cancellations += 1;
          return new Promise(() => {});
        },
      };
    },
  };
  try {
    globalThis.fetch = async (target) => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      body,
      url: String(target),
    });
    const execution = executeMoodleCourseGroupsInPage({
      operation: {
        key: "moodle.page.group.membership_map.read.v1",
        toolName: "moodle_get_course_groups",
        provider: "moodle",
        readOnly: true,
      },
      arguments: { course_id: 1 },
      binding: {
        origin: "https://moodle.example.test",
        siteUrl: "https://moodle.example.test/",
        principalId: "3",
        courseId: "1",
      },
      expiresAt: Date.now() + 5_000,
    });
    const timeout = Symbol("timeout");
    const result = await Promise.race([
      execution,
      new Promise((resolve) => setTimeout(() => resolve(timeout), 100)),
    ]);
    assert.notEqual(result, timeout, "body cancellation delayed terminal settlement");
    assert.deepEqual(result, { ok: false, sent: false, complete: false, error: "moodle_course_groups_incomplete" });
    assert.equal(cancellations, 1);
  } finally {
    Object.defineProperty(globalThis, "location", { configurable: true, writable: true, value: original.location });
    Object.defineProperty(globalThis, "document", { configurable: true, writable: true, value: original.document });
    globalThis.fetch = original.fetch;
    globalThis.M = original.M;
  }
});

test("a declared oversized provider response is cancelled before the executor returns", async () => {
  installContext();
  let cancellations = 0;
  try {
    globalThis.fetch = async (target) => ({
      ok: true,
      status: 200,
      headers: new Headers({ "Content-Length": "2097153" }),
      body: {
        cancel() {
          cancellations += 1;
          return Promise.resolve();
        },
      },
      url: String(target),
    });
    const result = await executeCanvasCourseSummaryInPage({
      operation: {
        key: "canvas.api.v1.course.assignment.submissions.aggregate.read.v1",
        toolName: "canvas_get_assignment_submission_summary",
        provider: "canvas",
        readOnly: true,
      },
      arguments: { assignment_id: 2, course_id: 1 },
      binding: {
        origin: "https://moodle.example.test",
        principalId: "3",
        courseId: "1",
      },
      expiresAt: Date.now() + 5_000,
    });
    assert.deepEqual(result, { ok: false, sent: false, complete: false, error: "canvas_assignment_submission_summary_incomplete" });
    assert.equal(cancellations, 1, "the refused response body remained live");
  } finally {
    Object.defineProperty(globalThis, "location", { configurable: true, writable: true, value: original.location });
    Object.defineProperty(globalThis, "document", { configurable: true, writable: true, value: original.document });
    globalThis.fetch = original.fetch;
    globalThis.M = original.M;
  }
});

test("a rejected provider response is cancelled before the executor returns", async () => {
  installContext();
  let cancellations = 0;
  try {
    globalThis.fetch = async (target) => ({
      ok: false,
      status: 503,
      headers: new Headers(),
      body: {
        cancel() {
          cancellations += 1;
          return Promise.resolve();
        },
      },
      url: String(target),
    });
    const result = await executeCanvasCourseSummaryInPage({
      operation: {
        key: "canvas.api.v1.course.assignment.submissions.aggregate.read.v1",
        toolName: "canvas_get_assignment_submission_summary",
        provider: "canvas",
        readOnly: true,
      },
      arguments: { assignment_id: 2, course_id: 1 },
      binding: {
        origin: "https://moodle.example.test",
        principalId: "3",
        courseId: "1",
      },
      expiresAt: Date.now() + 5_000,
    });
    assert.deepEqual(result, { ok: false, sent: false, error: "canvas_assignment_submission_summary_context_changed" });
    assert.equal(cancellations, 1, "the rejected response body remained live");
  } finally {
    Object.defineProperty(globalThis, "location", { configurable: true, writable: true, value: original.location });
    Object.defineProperty(globalThis, "document", { configurable: true, writable: true, value: original.document });
    globalThis.fetch = original.fetch;
    globalThis.M = original.M;
  }
});
