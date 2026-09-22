import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInThisContext } from "node:vm";

import { executeCanvasCourseSummaryInPage } from "../../connector/extension/src/canvas-course-summary-read.js";

const CANVAS_ORIGIN = "https://school.instructure.com";
const CANVAS_CONTENT_SOURCE = readFileSync(new URL("../../connector/extension/src/canvas-content.js", import.meta.url), "utf8");
const courseReadOperation = {
  key: "GET /v1/courses/{course_id}/pages#list_pages_courses",
  toolName: "canvas_list_pages_courses",
  provider: "canvas",
  service: "canvas",
  method: "GET",
  readOnly: true,
  path: "/v1/courses/{course_id}/pages",
  parameters: [{ inputName: "course_id", wireName: "course_id", location: "path", required: true, schema: { type: "string" } }],
  morrowCourseTarget: { kind: "course_path", argument: "course_id" },
};

function canvasJson(value) {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}

async function executeCanvasRead(fetchImplementation, {
  operation = courseReadOperation,
  arguments: args = { course_id: "42" },
  expiresAt = Date.now() + 1_000,
} = {}) {
  const keys = ["location", "document", "fetch", "chrome", "__morrowCanvasConnectorInstalled"];
  const descriptors = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const listeners = [];
  const requests = [];
  try {
    Object.defineProperties(globalThis, {
      location: { configurable: true, writable: true, value: { origin: CANVAS_ORIGIN, protocol: "https:", pathname: "/courses/42/pages" } },
      document: { configurable: true, writable: true, value: { cookie: "_csrf_token=csrf-value; _legacy_normandy_session=session" } },
      fetch: { configurable: true, writable: true, value: async (input, options = {}) => {
        const url = new URL(String(input?.href ?? input), CANVAS_ORIGIN);
        requests.push({ url, options, at: Date.now() });
        return fetchImplementation(url, options);
      } },
      chrome: { configurable: true, writable: true, value: { runtime: { onMessage: { addListener: (listener) => listeners.push(listener) } } } },
    });
    delete globalThis.__morrowCanvasConnectorInstalled;
    runInThisContext(CANVAS_CONTENT_SOURCE, { filename: "canvas-content.js" });
    assert.equal(listeners.length, 1);
    const result = await new Promise((resolve, reject) => {
      const handled = listeners[0]({
        type: "morrow_canvas_execute",
        operation,
        arguments: args,
        principalId: "7",
        courseId: "42",
        expiresAt,
      }, null, resolve);
      if (handled !== true) reject(new Error("Canvas content script refused the test command"));
    });
    return { result, requests };
  } finally {
    for (const key of keys) {
      const descriptor = descriptors.get(key);
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
}

test("a stalled Canvas read fetch settles at the operation deadline", async () => {
  const priorFetch = globalThis.fetch;
  const priorLocation = globalThis.location;
  const signals = [];
  globalThis.location = { origin: "https://canvas.example.test" };
  globalThis.fetch = (_url, options = {}) => {
    signals.push(options.signal);
    return new Promise((_, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true }));
  };

  let timeout;
  const startedAt = Date.now();
  try {
    const execution = executeCanvasCourseSummaryInPage(JSON.stringify({
      operation: {
        key: "canvas.api.v1.course.assignment.submissions.aggregate.read.v1",
        toolName: "canvas_get_assignment_submission_summary",
        provider: "canvas",
        readOnly: true,
      },
      arguments: { course_id: "42", assignment_id: "81" },
      binding: {
        origin: "https://canvas.example.test",
        siteUrl: "https://canvas.example.test/courses/42",
        principalId: "7",
        courseId: "42",
      },
      expiresAt: Date.now() + 40,
    }));
    const result = await Promise.race([
      execution,
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("read fetch remained pending")), 1_000); }),
    ]);

    assert.equal(result.ok, false);
    assert.equal(result.sent, false);
    assert.equal(signals.length, 1);
    assert.equal(signals[0] instanceof AbortSignal, true);
    assert.equal(signals[0].aborted, true);
    assert.ok(Date.now() - startedAt < 500);
  } finally {
    clearTimeout(timeout);
    globalThis.fetch = priorFetch;
    if (priorLocation === undefined) delete globalThis.location;
    else globalThis.location = priorLocation;
  }
});

test("Canvas starts no later request when a profile or course preflight crosses the deadline", async () => {
  for (const delayedPath of ["/api/v1/users/self/profile", "/api/v1/courses/42"]) {
    const expiresAt = Date.now() + 30;
    const { result, requests } = await executeCanvasRead(async (url) => {
      if (url.pathname === delayedPath) await new Promise((resolve) => setTimeout(resolve, 55));
      if (url.pathname === "/api/v1/users/self/profile") return canvasJson({ id: "7", name: "Teacher" });
      if (url.pathname === "/api/v1/courses/42") return canvasJson({ id: "42", name: "Biology" });
      return canvasJson([]);
    }, { expiresAt });
    assert.equal(result.ok, false, delayedPath);
    assert.deepEqual(requests.map(({ url }) => url.pathname), delayedPath.endsWith("profile")
      ? ["/api/v1/users/self/profile"]
      : ["/api/v1/users/self/profile", "/api/v1/courses/42"], delayedPath);
  }
});

test("Canvas cancels a 429 body and bounds Retry-After to the original deadline", async () => {
  let targetCalls = 0;
  let cancellations = 0;
  const expiresAt = Date.now() + 50;
  const startedAt = Date.now();
  const { result } = await executeCanvasRead((url) => {
    if (url.pathname === "/api/v1/users/self/profile") return canvasJson({ id: "7", name: "Teacher" });
    if (url.pathname === "/api/v1/courses/42") return canvasJson({ id: "42", name: "Biology" });
    targetCalls += 1;
    return {
      ok: false,
      status: 429,
      headers: new Headers({ "Retry-After": "30", "content-type": "application/json" }),
      body: { cancel: () => { cancellations += 1; return new Promise(() => {}); } },
    };
  }, { expiresAt });
  assert.equal(result.ok, false);
  assert.equal(targetCalls, 1);
  assert.equal(cancellations, 1);
  assert.ok(Date.now() - startedAt < 500);
});

test("Canvas cancels non-OK profile and course bodies without waiting for cancellation", async () => {
  for (const failedPath of ["/api/v1/users/self/profile", "/api/v1/courses/42"]) {
    let cancellations = 0;
    const startedAt = Date.now();
    const { result } = await executeCanvasRead((url) => {
      if (url.pathname === failedPath) {
        return {
          ok: false,
          status: 500,
          headers: new Headers(),
          body: { cancel: () => { cancellations += 1; return new Promise(() => {}); } },
        };
      }
      if (url.pathname === "/api/v1/users/self/profile") return canvasJson({ id: "7", name: "Teacher" });
      return canvasJson({ id: "42", name: "Biology" });
    });
    assert.equal(result.ok, false, failedPath);
    assert.equal(cancellations, 1, failedPath);
    assert.ok(Date.now() - startedAt < 500, failedPath);
  }
});

test("unscoped Canvas account, session, and self reads are refused before any provider preflight", async () => {
  const cases = [
    {
      path: "/v1/accounts/{account_id}/users",
      args: { account_id: "99" },
      parameters: [{ inputName: "account_id", wireName: "account_id", location: "path", required: true, schema: { type: "string" } }],
      target: { kind: "none" },
    },
    { path: "/v1/users/self/profile", args: {}, parameters: [], target: { kind: "none" } },
    { path: "/v1/users/self/bookmarks", args: {}, parameters: [], target: { kind: "self_path", resource: "bookmark" } },
  ];
  for (const entry of cases) {
    const operation = {
      ...courseReadOperation,
      key: `GET ${entry.path}#unscoped_test`,
      toolName: "canvas_unscoped_test",
      path: entry.path,
      parameters: entry.parameters,
      morrowCourseTarget: entry.target,
    };
    const { result, requests } = await executeCanvasRead(() => { throw new Error("must not fetch"); }, {
      operation,
      arguments: entry.args,
    });
    assert.deepEqual(result, { ok: false, sent: false, error: "canvas_course_scope_required" }, entry.path);
    assert.deepEqual(requests, [], entry.path);
  }
});
