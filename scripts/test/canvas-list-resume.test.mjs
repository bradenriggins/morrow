import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInThisContext } from "node:vm";
import { canvasOperationAdmission } from "../../connector/extension/generated/canvas-operation-admission.js";

const ORIGIN = "https://school.instructure.com";
const LIST_PATH = "/api/v1/courses/42/pages";
const CONTENT_SOURCE = readFileSync(new URL("../../connector/extension/src/canvas-content.js", import.meta.url), "utf8");
const CATALOG = JSON.parse(readFileSync(new URL("../../artifacts/canvas-api/canvas-api-catalog.json", import.meta.url), "utf8"));

function catalogOperation(toolName) {
  const operation = CATALOG.operations.find((entry) => entry.toolName === toolName);
  assert.ok(operation, `missing Canvas operation ${toolName}`);
  // Exactly what connector/extension/src/service-worker.js sends to the page.
  return { ...operation, morrowCourseTarget: canvasOperationAdmission(operation).courseTarget };
}

function jsonResponse(value, headers = {}) {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json", ...headers } });
}

/**
 * Runs the real content script the way Chrome runs it: the file is evaluated as
 * a classic script against these page globals, so the pagination the test sees
 * is the pagination Canvas would drive.
 */
async function sendListRead(args, canvas, toolName = "canvas_list_pages_courses") {
  const keys = ["location", "document", "fetch", "chrome", "__morrowCanvasConnectorInstalled"];
  const descriptors = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const operation = catalogOperation(toolName);
  const requests = [];
  const listeners = [];
  const values = {
    location: { origin: ORIGIN, protocol: "https:", pathname: "/courses/42/pages" },
    document: { cookie: "_csrf_token=csrf-value; _legacy_normandy_session=session" },
    fetch: async (input, options = {}) => {
      const url = new URL(String(input?.href ?? input), ORIGIN);
      if (url.pathname === "/api/v1/users/self/profile") return jsonResponse({ id: "7", name: "Teacher" });
      if (url.pathname === "/api/v1/courses/42") return jsonResponse({ id: "42", name: "Biology" });
      requests.push({ pathname: url.pathname, search: url.search, method: options.method || "GET" });
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
      const handled = listeners[0]({
        type: "morrow_canvas_execute",
        operation,
        arguments: args,
        principalId: "7",
        expiresAt: Date.now() + 60_000,
        courseId: "42",
      }, null, resolve);
      if (handled !== true) reject(new Error("the content script did not accept the execute message"));
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

/** Three pages of one Canvas list, with the Link header Canvas sends for numeric pagination. */
function pagedCanvas({ host = "school.instructure.com", path = LIST_PATH, lastPage = 3 } = {}) {
  return (url) => {
    const page = Number(url.searchParams.get("page") || 1);
    const links = [];
    if (page < lastPage) {
      links.push(`<https://${host}${path}?per_page=1&page=${page + 1}>; rel="next"`);
      links.push(`<https://${host}${path}?per_page=1&page=${lastPage}>; rel="last"`);
    }
    return jsonResponse([{ page_id: String(page * 11), url: `page-${page}`, title: `Page ${page}` }], links.length ? { link: links.join(",") } : {});
  };
}

test("a capped list read returns one opaque resume token and the exact unread page count", async () => {
  const { result, requests } = await sendListRead({ course_id: "42", morrow_max_pages: 1, morrow_list_resume: {} }, pagedCanvas());
  assert.equal(result.ok, true);
  assert.equal(result.truncated, true);
  assert.equal(result.pageCount, 1);
  assert.equal(result.morrow_pages_read, 1);
  assert.equal(result.morrow_unread_pages, 2);
  assert.match(result.morrow_next_page, /^[A-Za-z0-9_-]{8,}$/);
  assert.equal(result.morrow_next_page.includes("instructure"), false, "the token must not carry a readable URL");
  assert.deepEqual(requests.map((request) => request.pathname), [LIST_PATH]);
});

test("a read with no resume control returns no token at all", async () => {
  const { result } = await sendListRead({ course_id: "42", morrow_max_pages: 1 }, pagedCanvas());
  assert.equal(result.truncated, true);
  assert.equal(Object.hasOwn(result, "morrow_next_page"), false);
  assert.equal(Object.hasOwn(result, "morrow_unread_pages"), false);
  assert.equal(Object.hasOwn(result, "morrow_pages_read"), false);
});

test("a resumed read continues the same list and reports completeness only at the last page", async () => {
  const canvas = pagedCanvas();
  const first = await sendListRead({ course_id: "42", morrow_max_pages: 1, morrow_list_resume: {} }, canvas);
  const second = await sendListRead({ course_id: "42", morrow_max_pages: 1, morrow_list_resume: { next_page: first.result.morrow_next_page } }, canvas);
  assert.equal(second.result.truncated, true);
  assert.equal(second.result.morrow_pages_read, 2);
  assert.equal(second.result.morrow_unread_pages, 1);
  assert.deepEqual(second.requests.map((request) => request.search), ["?per_page=1&page=2"]);
  assert.deepEqual(second.result.data, [{ page_id: "22", url: "page-2", title: "Page 2" }]);

  const third = await sendListRead({ course_id: "42", morrow_max_pages: 1, morrow_list_resume: { next_page: second.result.morrow_next_page } }, canvas);
  assert.equal(third.result.truncated, false);
  assert.equal(third.result.morrow_pages_read, 3);
  assert.equal(Object.hasOwn(third.result, "morrow_next_page"), false);
  assert.deepEqual(third.result.data, [{ page_id: "33", url: "page-3", title: "Page 3" }]);
});

test("a foreign-origin next link is refused instead of read", async () => {
  const { result, requests } = await sendListRead(
    { course_id: "42", morrow_max_pages: 5, morrow_list_resume: {} },
    pagedCanvas({ host: "attacker.example.com" }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.sent, false);
  assert.equal(result.error, "canvas_pagination_origin_refused");
  assert.deepEqual(requests.map((request) => request.pathname), [LIST_PATH]);
});

test("a next link that changes the request path is refused instead of read", async () => {
  const { result, requests } = await sendListRead(
    { course_id: "42", morrow_max_pages: 5, morrow_list_resume: {} },
    pagedCanvas({ path: "/api/v1/courses/42/users" }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.error, "canvas_pagination_origin_refused");
  assert.deepEqual(requests.map((request) => request.pathname), [LIST_PATH]);
});

test("a next link cannot remove, change, or widen the first page query", async () => {
  const links = [
    `${ORIGIN}${LIST_PATH}?page=2&per_page=10`,
    `${ORIGIN}${LIST_PATH}?search_term=other&page=2&per_page=10`,
    `${ORIGIN}${LIST_PATH}?search_term=needle&include=body&page=2&per_page=10`,
    `${ORIGIN}${LIST_PATH}?search_term=needle&page=2&page=3&per_page=10`,
    `${ORIGIN}${LIST_PATH}?search_term=needle&page=2&per_page=101`,
  ];
  for (const href of links) {
    const { result, requests } = await sendListRead(
      { course_id: "42", search_term: "needle", morrow_max_pages: 5, morrow_list_resume: {} },
      () => jsonResponse([{ page_id: "11", url: "page-1", title: "Page 1" }], { link: `<${href}>; rel="next"` }),
    );
    assert.equal(result.ok, false, href);
    assert.equal(result.error, "canvas_pagination_parameters_refused", href);
    assert.deepEqual(requests.map((request) => request.pathname), [LIST_PATH], href);
  }
});

test("a next link may add one bounded page size while preserving the first page query", async () => {
  const seen = [];
  const { result } = await sendListRead(
    { course_id: "42", search_term: "needle", morrow_max_pages: 5, morrow_list_resume: {} },
    (url) => {
      seen.push(url.search);
      if (!url.searchParams.has("page")) {
        return jsonResponse([{ page_id: "11", url: "page-1", title: "Page 1" }], {
          link: `<${ORIGIN}${LIST_PATH}?search_term=needle&page=2&per_page=10>; rel="next"`,
        });
      }
      return jsonResponse([{ page_id: "22", url: "page-2", title: "Page 2" }]);
    },
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.truncated, false);
  assert.deepEqual(seen, ["?search_term=needle", "?search_term=needle&page=2&per_page=10"]);
});

test("a malformed or ambiguous Link header cannot be mistaken for a complete list", async () => {
  const values = [
    `<${ORIGIN}${LIST_PATH}?page=2>; rel="next"; type="application/json"`,
    `<${ORIGIN}${LIST_PATH}?page=2>; rel="next",<${ORIGIN}${LIST_PATH}?page=3>; rel="next"`,
    "not-a-link-header",
  ];
  for (const link of values) {
    const { result, requests } = await sendListRead(
      { course_id: "42", morrow_max_pages: 5, morrow_list_resume: {} },
      () => jsonResponse([{ page_id: "11", url: "page-1", title: "Page 1" }], { link }),
    );
    assert.equal(result.ok, false, link);
    assert.equal(result.error, "canvas_pagination_header_refused", link);
    assert.deepEqual(requests.map((request) => request.pathname), [LIST_PATH], link);
  }
});

test("a resume token for another origin, another path, or a wider read is refused", async () => {
  const encode = (value) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  const refused = [
    encode({ v: 1, p: 1, u: "https://attacker.example.com/api/v1/courses/42/pages?page=2" }),
    encode({ v: 1, p: 1, u: `${ORIGIN}/api/v1/courses/42/users?page=2` }),
    encode({ v: 1, p: 1, u: `${ORIGIN}${LIST_PATH}?page=2&include=body` }),
    encode({ v: 1, p: 0, u: `${ORIGIN}${LIST_PATH}?page=2` }),
    encode({ v: 2, p: 1, u: `${ORIGIN}${LIST_PATH}?page=2` }),
    "not base64url!",
  ];
  for (const token of refused) {
    const { result, requests } = await sendListRead(
      { course_id: "42", morrow_max_pages: 1, morrow_list_resume: { next_page: token } },
      pagedCanvas(),
    );
    assert.equal(result.ok, false, `token accepted: ${token}`);
    assert.equal(result.sent, false);
    assert.equal(result.error, "canvas_pagination_resume_refused");
    assert.deepEqual(requests, [], "a refused resume must send no Canvas list request");
  }
});

test("a resume token that only adds Canvas pagination parameters is accepted", async () => {
  const token = Buffer.from(JSON.stringify({ v: 1, p: 1, u: `${ORIGIN}${LIST_PATH}?page=2&per_page=1` }), "utf8").toString("base64url");
  const { result, requests } = await sendListRead(
    { course_id: "42", morrow_max_pages: 1, morrow_list_resume: { next_page: token } },
    pagedCanvas(),
  );
  assert.equal(result.ok, true);
  assert.deepEqual(requests.map((request) => request.search), ["?page=2&per_page=1"]);
});

test("a list with no last link reports its unread pages as not stated", async () => {
  const bookmarkCanvas = () => jsonResponse(
    [{ page_id: "11", url: "page-1", title: "Page 1" }],
    { link: `<${ORIGIN}${LIST_PATH}?page=bookmark%3Aabc&per_page=1>; rel="next"` },
  );
  const { result } = await sendListRead({ course_id: "42", morrow_max_pages: 1, morrow_list_resume: {} }, bookmarkCanvas);
  assert.equal(result.truncated, true);
  assert.equal(result.morrow_unread_pages, null);
  assert.match(result.morrow_next_page, /^[A-Za-z0-9_-]{8,}$/);
});

test("a resume control on a write is refused before anything is sent", async () => {
  const { result, requests } = await sendListRead(
    { course_id: "42", url_or_id: "lesson", wiki_page_title: "Lesson", morrow_list_resume: {} },
    pagedCanvas(),
    "canvas_update_create_page_courses",
  );
  assert.equal(result.ok, false);
  assert.equal(result.sent, false);
  assert.equal(result.error, "canvas_pagination_resume_refused");
  assert.deepEqual(requests, []);
});
