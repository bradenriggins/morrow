import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInThisContext } from "node:vm";

const ORIGIN = "https://school.instructure.com";
const CONTENT_SOURCE = readFileSync(new URL("../../connector/extension/src/canvas-content.js", import.meta.url), "utf8");

function jsonResponse(value, headers = {}) {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json", ...headers } });
}

/**
 * Runs the real content script the way Chrome runs it, and sends it one
 * morrow_canvas_list_courses message. See scripts/test/canvas-list-resume.test.mjs
 * for the same technique against morrow_canvas_execute.
 */
async function sendListCourses(next, canvas) {
  const keys = ["location", "document", "fetch", "chrome", "__morrowCanvasConnectorInstalled"];
  const descriptors = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const requests = [];
  const listeners = [];
  const values = {
    location: { origin: ORIGIN, protocol: "https:", pathname: "/courses/42" },
    document: { cookie: "_csrf_token=csrf-value; _legacy_normandy_session=session" },
    fetch: async (input) => {
      const url = new URL(String(input?.href ?? input), ORIGIN);
      if (url.pathname === "/api/v1/users/self/profile") return jsonResponse({ id: "7", name: "Teacher" });
      requests.push({ pathname: url.pathname, search: url.search });
      return canvas(url);
    },
    chrome: { runtime: { onMessage: { addListener: (listener) => listeners.push(listener) } } },
    __morrowCanvasConnectorInstalled: undefined,
  };
  try {
    for (const [key, value] of Object.entries(values)) {
      Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    }
    delete globalThis.__morrowCanvasConnectorInstalled;
    runInThisContext(CONTENT_SOURCE, { filename: "canvas-content.js" });
    assert.equal(listeners.length, 1, "the content script registered no message listener");
    const result = await new Promise((resolve, reject) => {
      const handled = listeners[0]({ type: "morrow_canvas_list_courses", ...(next !== undefined ? { next } : {}) }, null, resolve);
      if (handled !== true) reject(new Error("the content script did not accept the list-courses message"));
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

test("Canvas course discovery asks for term and favorites, and maps the optional fields", async () => {
  const { result, requests } = await sendListCourses(undefined, () => jsonResponse([
    {
      id: 1,
      name: " Biology 101 ",
      course_code: " BIO-101 ",
      term: { name: " Fall 2026 " },
      enrollments: [{ type: "TeacherEnrollment" }],
      is_favorite: true,
      workflow_state: "available",
    },
    { id: 2, name: "Chemistry", workflow_state: "unpublished" },
  ]));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.courses, [
    { id: "1", name: "Biology 101", code: "BIO-101", term: "Fall 2026", role: "TeacherEnrollment", favorite: true, published: true },
    { id: "2", name: "Chemistry", published: false },
  ]);
  assert.equal(requests.length, 1);
  assert.match(requests[0].pathname, /^\/api\/v1\/courses$/);
  assert.match(requests[0].search, /include(?:%5B%5D|\[\])=term/);
  assert.match(requests[0].search, /include(?:%5B%5D|\[\])=favorites/);
});

test("a course with no optional Canvas fields returns only id and name", async () => {
  const { result } = await sendListCourses(undefined, () => jsonResponse([{ id: 5, name: "Art History" }]));
  assert.equal(result.ok, true);
  assert.deepEqual(result.courses, [{ id: "5", name: "Art History" }]);
});

test("an optional course field is trimmed and cut to 120 characters; name keeps its own 300-character cap", async () => {
  const longCode = "C".repeat(200);
  const longName = "N".repeat(400);
  const { result } = await sendListCourses(undefined, () => jsonResponse([{ id: 3, name: longName, course_code: longCode }]));
  assert.equal(result.ok, true);
  assert.equal(result.courses[0].code, "C".repeat(120));
  assert.equal(result.courses[0].name, "N".repeat(300));
});
