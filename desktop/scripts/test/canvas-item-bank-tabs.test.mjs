import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInThisContext } from "node:vm";

const ORIGIN = "https://school.instructure.com";
const CONTENT_SOURCE = readFileSync(new URL("../../connector/extension/src/canvas-content.js", import.meta.url), "utf8");

function response(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

async function readTabs(canvasTabs) {
  const keys = ["location", "document", "fetch", "chrome", "__morrowCanvasConnectorInstalled"];
  const descriptors = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const listeners = [];
  const requests = [];
  const values = {
    location: { origin: ORIGIN, protocol: "https:", pathname: "/courses/42" },
    document: { cookie: "_csrf_token=csrf-value; _legacy_normandy_session=session" },
    fetch: async (input, options = {}) => {
      const url = new URL(String(input?.href ?? input), ORIGIN);
      requests.push({ pathname: url.pathname, credentials: options.credentials, cache: options.cache, redirect: options.redirect });
      if (url.pathname === "/api/v1/users/self/profile") return response({ id: "7", name: "Teacher" });
      if (url.pathname === "/api/v1/courses/42") return response({ id: "42", name: "Biology" });
      if (url.pathname === "/api/v1/courses/42/tabs") return response(canvasTabs);
      return response({}, 404);
    },
    chrome: { runtime: { onMessage: { addListener: (listener) => listeners.push(listener) } } },
    __morrowCanvasConnectorInstalled: undefined,
  };
  try {
    for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    delete globalThis.__morrowCanvasConnectorInstalled;
    runInThisContext(CONTENT_SOURCE, { filename: "canvas-content.js" });
    const result = await new Promise((resolve, reject) => {
      const handled = listeners[0]({ type: "morrow_canvas_item_bank_tabs", courseId: "42" }, null, resolve);
      if (handled !== true) reject(new Error("the content script did not accept the Item Banks Tabs message"));
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

test("the Item Banks setup path reads and returns only the current course Tabs placement fields", async () => {
  const tabs = [{
    id: "context_external_tool_71234",
    type: "external",
    label: "Item Banks",
    html_url: `${ORIGIN}/courses/42/external_tools/71234`,
    visibility: "admins",
    hidden: false,
  }];

  const { result, requests } = await readTabs(tabs);

  assert.equal(result.ok, true);
  assert.deepEqual(result.profile, { id: "7", name: "Teacher", origin: ORIGIN, courseId: "42" });
  assert.deepEqual(result.course, { id: "42", name: "Biology" });
  assert.deepEqual(result.tabs, [{
    id: "context_external_tool_71234",
    type: "external",
    label: "Item Banks",
    html_url: `${ORIGIN}/courses/42/external_tools/71234`,
  }]);
  assert.deepEqual(requests.map(({ pathname }) => pathname).sort(), [
    "/api/v1/courses/42",
    "/api/v1/courses/42/tabs",
    "/api/v1/users/self/profile",
  ]);
  assert.equal(requests.find(({ pathname }) => pathname.endsWith("/tabs")).credentials, "include");
  assert.equal(requests.find(({ pathname }) => pathname.endsWith("/tabs")).cache, "no-store");
  assert.equal(requests.find(({ pathname }) => pathname.endsWith("/tabs")).redirect, "error");
});
