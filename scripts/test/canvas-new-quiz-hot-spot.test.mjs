import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInThisContext } from "node:vm";
import {
  executeCanvasNewQuizHotSpotInPage,
  unsignedHotSpotImageUrl,
} from "../../connector/extension/src/canvas-new-quiz-hot-spot.js";
import { canvasWriteOutcomeUncertain } from "../../connector/extension/src/canvas-write-outcome.js";

const ORIGIN = "https://school.instructure.com";
const COURSE_ID = "2";
const QUIZ_ID = "77";
const PRINCIPAL_ID = "7";
const SIGNED_UPLOAD_URL = "https://instructure-uploads.example.net/media/cell.png?X-Amz-Signature=deadbeefsecret&X-Amz-Expires=600";
const UNSIGNED_UPLOAD_URL = "https://instructure-uploads.example.net/media/cell.png";
const QUIZ_PATH = `/api/quiz/v1/courses/${COURSE_ID}/quizzes/${QUIZ_ID}`;

const SAVED = [
  { id: "11", position: 1, entry_type: "Item" },
  { id: "12", position: 2, entry_type: "Item" },
];

const TEMPLATE = {
  entry_type: "Item",
  points_possible: 3,
  entry: {
    title: "Label the mitochondrion",
    item_body: "<p>Select the mitochondrion.</p>",
    interaction_type_slug: "hot-spot",
    interaction_data: {},
    scoring_algorithm: "HotSpot",
    scoring_data: { value: { type: "oval", coordinates: [{ x: 0.2, y: 0.2 }, { x: 0.4, y: 0.4 }] } },
  },
};

/** The exact serialization connector/extension/src/canvas-content.js digests. */
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  return JSON.stringify(value === undefined ? null : value);
}

function digest(value) {
  return createHash("sha256").update(stable(value)).digest("hex");
}

function response(url, body, { status = 200, headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    headers: new Headers(headers),
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

/**
 * Runs the injected executor the way Chrome runs it: as a plain function over
 * the page globals, with one recorded fetch.
 */
async function runInPage(input, routes) {
  const keys = ["location", "document", "fetch"];
  const saved = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const requests = [];
  const values = {
    location: { origin: ORIGIN },
    document: { cookie: "_csrf_token=csrf-value; other=1" },
    fetch: async (target, options = {}) => {
      const url = new URL(String(target?.href ?? target), ORIGIN);
      const method = options.method || "GET";
      requests.push({ pathname: url.pathname, search: url.search, method, body: options.body });
      return routes(url, method, options);
    },
  };
  try {
    for (const [key, value] of Object.entries(values)) {
      Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    }
    return { result: await executeCanvasNewQuizHotSpotInPage(input), requests };
  } finally {
    for (const key of keys) {
      const descriptor = saved.get(key);
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
}

function routes({ items = SAVED, created = { id: "13" }, saved: savedItem, createStatus = 200, uploadUrlBody = { url: SIGNED_UPLOAD_URL } } = {}) {
  const readback = savedItem === undefined
    ? {
        id: "13", entry_type: "Item",
        entry: { interaction_type_slug: "hot-spot", interaction_data: { image_url: UNSIGNED_UPLOAD_URL } },
      }
    : savedItem;
  const after = [...items, { id: "13", position: items.length + 1, entry_type: "Item" }];
  let listReads = 0;
  return (url, method) => {
    const href = url.pathname;
    if (href === "/api/v1/users/self/profile") return response(url.href, { id: PRINCIPAL_ID });
    if (href === `/api/v1/courses/${COURSE_ID}`) return response(url.href, { id: COURSE_ID });
    if (href === QUIZ_PATH) return response(url.href, { id: QUIZ_ID });
    if (href === `${QUIZ_PATH}/items` && method === "GET") {
      listReads += 1;
      return response(url.href, listReads === 1 ? items : after);
    }
    if (href === `${QUIZ_PATH}/items/media_upload_url`) return response(url.href, uploadUrlBody);
    if (href === `${QUIZ_PATH}/items` && method === "POST") {
      return response(url.href, created, { status: createStatus });
    }
    if (href === `${QUIZ_PATH}/items/13`) return response(url.href, readback);
    // Canvas answers a course, quiz or item this person cannot reach the same way.
    return response(url.href, { errors: [{ message: "not found" }] }, { status: 404 });
  };
}

function baseInput(overrides = {}) {
  return {
    binding: { origin: ORIGIN, courseId: COURSE_ID, principalId: PRINCIPAL_ID },
    assignmentId: QUIZ_ID,
    beforeItemsSha256: digest(SAVED),
    ...overrides,
  };
}

function completeInput(overrides = {}) {
  return baseInput({
    mode: "complete",
    upload_url: SIGNED_UPLOAD_URL,
    item: TEMPLATE,
    payloadSha256: digest(TEMPLATE),
    expiresAt: Date.now() + 60_000,
    ...overrides,
  });
}

test("the unsigned image URL drops the signature and refuses anything but https", () => {
  assert.equal(unsignedHotSpotImageUrl(SIGNED_UPLOAD_URL), UNSIGNED_UPLOAD_URL);
  assert.equal(unsignedHotSpotImageUrl(`${SIGNED_UPLOAD_URL}#fragment`), UNSIGNED_UPLOAD_URL);
  for (const value of [
    "http://uploads.example.net/media/cell.png?sig=1",
    "https://user:secret@uploads.example.net/media/cell.png?sig=1",
    "ftp://uploads.example.net/cell.png",
    "not a url",
    "",
    undefined,
    null,
    42,
  ]) {
    assert.throws(() => unsignedHotSpotImageUrl(value), /canvas_hot_spot_upload_url_refused/, String(value));
  }
});

test("initialize proves the binding and the saved list, then returns one signed upload URL", async () => {
  const { result, requests } = await runInPage(baseInput({ mode: "initialize" }), routes());
  assert.equal(result.ok, true);
  assert.equal(result.sent, false);
  assert.equal(result.data.upload_url, SIGNED_UPLOAD_URL);
  assert.equal(result.data.item_count, SAVED.length);
  assert.deepEqual(requests.filter((entry) => entry.method !== "GET"), []);
});

test("initialize refuses a saved question list that changed after review", async () => {
  const { result, requests } = await runInPage(
    baseInput({ mode: "initialize", beforeItemsSha256: digest([...SAVED, { id: "14", position: 3, entry_type: "Item" }]) }),
    routes(),
  );
  assert.equal(result.ok, false);
  assert.equal(result.sent, false);
  assert.equal(result.outcomeUnknown, false);
  assert.equal(result.error, "canvas_hot_spot_item_list_stale");
  // The upload URL is never even requested for a stale list.
  assert.equal(requests.some((entry) => entry.pathname.endsWith("/media_upload_url")), false);
});

test("complete creates the question once with the unsigned URL and verifies both readbacks", async () => {
  const { result, requests } = await runInPage(completeInput(), routes());
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.sent, true);
  assert.equal(result.outcomeUnknown, false);
  assert.equal(result.verification.status, "verified");
  assert.equal(result.data.item_id, "13");
  assert.equal(result.data.image_url, UNSIGNED_UPLOAD_URL);

  const posts = requests.filter((entry) => entry.method === "POST");
  assert.equal(posts.length, 1, "exactly one create is sent");
  const sent = JSON.parse(posts[0].body);
  assert.equal(sent.item.entry.interaction_data.image_url, UNSIGNED_UPLOAD_URL);
  // The signature never reaches Canvas in the create, and never reaches the result.
  assert.equal(posts[0].body.includes("X-Amz-Signature"), false);
  assert.equal(JSON.stringify(result).includes("X-Amz-Signature"), false);
  assert.equal(JSON.stringify(result).includes("?"), false);
  // The created item is reread, and so is the complete saved list.
  assert.equal(requests.filter((entry) => entry.pathname === `${QUIZ_PATH}/items/13`).length, 1);
  assert.equal(requests.filter((entry) => entry.pathname === `${QUIZ_PATH}/items` && entry.method === "GET").length, 2);
});

test("complete refuses a question payload that is not the reviewed one", async () => {
  const changed = { ...TEMPLATE, points_possible: 9 };
  const { result, requests } = await runInPage(
    completeInput({ item: changed, payloadSha256: digest(TEMPLATE) }),
    routes(),
  );
  assert.equal(result.ok, false);
  assert.equal(result.sent, false);
  assert.equal(result.outcomeUnknown, false);
  assert.equal(result.error, "canvas_hot_spot_payload_changed");
  assert.deepEqual(requests.filter((entry) => entry.method === "POST"), []);
});

test("complete refuses a question that already carries an image URL", async () => {
  const carried = {
    ...TEMPLATE,
    entry: { ...TEMPLATE.entry, interaction_data: { image_url: "https://elsewhere.example/other.png" } },
  };
  const { result, requests } = await runInPage(completeInput({ item: carried, payloadSha256: digest(carried) }), routes());
  assert.equal(result.ok, false);
  assert.equal(result.sent, false);
  assert.equal(result.error, "canvas_hot_spot_payload_invalid");
  assert.deepEqual(requests.filter((entry) => entry.method === "POST"), []);
});

test("complete refuses a saved question list that changed between the upload and the create", async () => {
  const { result, requests } = await runInPage(
    completeInput({ beforeItemsSha256: digest([{ id: "11", position: 1, entry_type: "Item" }]) }),
    routes(),
  );
  assert.equal(result.ok, false);
  assert.equal(result.sent, false);
  assert.equal(result.error, "canvas_hot_spot_item_list_stale");
  assert.deepEqual(requests.filter((entry) => entry.method === "POST"), []);
});

test("complete refuses a lost or unusable upload response", async () => {
  for (const upload_url of [undefined, "", "http://uploads.example.net/cell.png", "https://user:pw@uploads.example.net/cell.png"]) {
    const { result, requests } = await runInPage(completeInput({ upload_url }), routes());
    assert.equal(result.ok, false, String(upload_url));
    assert.equal(result.sent, false, String(upload_url));
    assert.equal(result.error, "canvas_hot_spot_upload_url_refused", String(upload_url));
    assert.deepEqual(requests.filter((entry) => entry.method === "POST"), []);
  }
  // Canvas answered the media upload request without a URL at all.
  const { result } = await runInPage(baseInput({ mode: "initialize" }), routes({ uploadUrlBody: {} }));
  assert.equal(result.ok, false);
  assert.equal(result.sent, false);
  assert.equal(result.error, "canvas_hot_spot_upload_url_missing");
});

test("a refused create is reported as sent with a known outcome, and an uncertain one is not", async () => {
  for (const status of [400, 403, 404, 409, 422]) {
    const { result, requests } = await runInPage(completeInput(), routes({ createStatus: status }));
    assert.equal(result.ok, false, `HTTP ${status}`);
    assert.equal(result.sent, true, `HTTP ${status}`);
    assert.equal(result.status, status, `HTTP ${status}`);
    assert.equal(result.outcomeUnknown, false, `HTTP ${status}`);
    assert.equal(result.outcomeUnknown, canvasWriteOutcomeUncertain(status), `HTTP ${status}`);
    assert.equal(requests.filter((entry) => entry.method === "POST").length, 1, `HTTP ${status}`);
  }
  for (const status of [408, 429, 500, 502, 504]) {
    const { result, requests } = await runInPage(completeInput(), routes({ createStatus: status }));
    assert.equal(result.ok, false, `HTTP ${status}`);
    assert.equal(result.sent, true, `HTTP ${status}`);
    assert.equal(result.outcomeUnknown, true, `HTTP ${status}`);
    assert.equal(result.outcomeUnknown, canvasWriteOutcomeUncertain(status), `HTTP ${status}`);
    assert.equal(requests.filter((entry) => entry.method === "POST").length, 1, `HTTP ${status}`);
  }
});

test("a create Canvas did not save the way it was asked for is a mismatch, never a verified change", async () => {
  const mismatched = {
    id: "13", entry_type: "Item",
    entry: { interaction_type_slug: "hot-spot", interaction_data: { image_url: "https://elsewhere.example/other.png" } },
  };
  const { result } = await runInPage(completeInput(), routes({ saved: mismatched }));
  assert.equal(result.ok, false);
  assert.equal(result.sent, true);
  assert.equal(result.outcomeUnknown, true);
  assert.equal(result.verification.status, "mismatch");
  assert.equal(result.error, "canvas_hot_spot_item_readback_mismatch");
});

test("a wrong course, quiz or signed-in person is refused before anything is sent", async () => {
  const cases = [
    [{ binding: { origin: ORIGIN, courseId: "999", principalId: PRINCIPAL_ID } }, /canvas_hot_spot_http_|canvas_hot_spot_course_changed/],
    [{ assignmentId: "888" }, /canvas_hot_spot_http_|canvas_hot_spot_quiz_changed/],
    [{ binding: { origin: ORIGIN, courseId: COURSE_ID, principalId: "8" } }, /canvas_principal_changed/],
    [{ binding: { origin: "https://other.instructure.com", courseId: COURSE_ID, principalId: PRINCIPAL_ID } }, /canvas_hot_spot_binding_invalid/],
  ];
  for (const [overrides, expected] of cases) {
    const { result, requests } = await runInPage(completeInput(overrides), routes());
    assert.equal(result.ok, false, JSON.stringify(overrides));
    assert.equal(result.sent, false, JSON.stringify(overrides));
    assert.match(result.error, expected, JSON.stringify(overrides));
    assert.deepEqual(requests.filter((entry) => entry.method === "POST"), [], JSON.stringify(overrides));
  }
});

test("a Hot Spot refused for course file access keeps the words that name the next step", async () => {
  const { problemCopy, problemText } = await import("../../connector/extension/src/bridge-problem-copy.js");
  const copy = problemCopy("canvas_file_storage_access_required");
  assert.equal(copy.known, true, "the permission refusal has no words of its own");
  // The toggle covers reading course files and sending a reviewed image, so the
  // words a person reads must not name only the read.
  assert.match(copy.detail, /reviewed image/);
  assert.match(copy.action, /Plan and Edit settings/);
  const text = problemText("canvas_file_storage_access_required");
  assert.match(text, /course file access/);

  // The worker routes a Hot Spot failure through those words when it has them,
  // and falls back to naming the step only when it does not.
  const worker = readFileSync(new URL("../../connector/extension/src/service-worker.js", import.meta.url), "utf8");
  assert.match(worker, /function hotSpotFailureMessage\(error\) \{\s*return problemCopy\(error\)\.known \? problemText\(error\)/);
  assert.match(worker, /privateCanvasNewQuizHotSpotOperation\(operation\)\s*\?\s*hotSpotFailureMessage\(result\?\.error\)/);
  // The gate itself runs before any byte leaves this worker.
  const gate = worker.indexOf('if (!await courseFileStorageAccessEnabled()) return { ok: false, sent: false, error: "canvas_file_storage_access_required" };',
    worker.indexOf("async function executeCanvasNewQuizHotSpotCreate"));
  const upload = worker.indexOf("method: \"PUT\"", worker.indexOf("async function executeCanvasNewQuizHotSpotCreate"));
  assert.ok(gate > 0 && upload > gate, "the permission gate must run before the reviewed bytes are sent");
});

const WORKER_SOURCE = readFileSync(new URL("../../connector/extension/src/service-worker.js", import.meta.url), "utf8");

/** One top-level worker function, sliced from its signature to its own closing brace. */
function workerFunction(signature) {
  const start = WORKER_SOURCE.indexOf(signature);
  assert.ok(start >= 0, `service-worker.js no longer holds ${signature}`);
  const end = WORKER_SOURCE.indexOf("\n}\n", start);
  assert.ok(end > start, `service-worker.js has no closing brace after ${signature}`);
  return WORKER_SOURCE.slice(start, end + "\n}\n".length);
}

/**
 * Runs the worker's own upload-observer region: the slice of service-worker.js
 * from the confirmation-URL check through the Hot Spot executor, evaluated
 * against a fixture Chrome and a fixture fetch. The page executor is a stub
 * because executeScript is a fixture; the in-page half is proved by the runs
 * above. The permission gate is stubbed open; the run above proves it executes
 * before the PUT.
 */
const hotSpotWorkerRegion = (() => {
  const script = [
    "globalThis.__morrowHotSpotWorkerRegion = (() => {",
    "const canvasUploadObservers = new Map();",
    "const COURSE_FILE_READ_TIMEOUT_MS = 30_000;",
    "async function courseFileStorageAccessEnabled() { return true; }",
    "function executeCanvasNewQuizHotSpotInPage() {}",
    workerFunction("async function sha256Bytes(bytes) {"),
    workerFunction("function decimalId(value) {"),
    WORKER_SOURCE.slice(
      WORKER_SOURCE.indexOf("function privateCanvasConfirmationUrl(value, canvasOrigin) {"),
      WORKER_SOURCE.indexOf("async function executeCanvasCourseFileTransfer("),
    ),
    "return { executeCanvasNewQuizHotSpotCreate, canvasUploadObservers };",
    "})();",
  ].join("\n");
  assert.ok(script.includes("async function executeCanvasNewQuizHotSpotCreate"), "the Hot Spot upload region moved in service-worker.js");
  runInThisContext(script, { filename: "service-worker-hot-spot-region.js" });
  const region = globalThis.__morrowHotSpotWorkerRegion;
  delete globalThis.__morrowHotSpotWorkerRegion;
  return region;
})();

/** A reviewed PNG: the leading bytes the stage scope admitted, small but real. */
const HOT_SPOT_PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

function createdFixture() {
  return {
    ok: true, sent: true, outcomeUnknown: false, status: 200,
    verification: { status: "verified" },
    data: {
      course_id: COURSE_ID, assignment_id: QUIZ_ID, item_id: "13",
      item_count: SAVED.length + 1, image_url: UNSIGNED_UPLOAD_URL,
    },
  };
}

/**
 * One worker run of the Hot Spot create. `duringFetch` fires while the PUT is
 * in flight, which is the only moment the observer endings below can happen:
 * the watch is registered and the create has not been reached.
 */
async function runHotSpotWorker({ expiresAt, duringFetch }) {
  const keys = ["chrome", "fetch", "canvasWriteOutcomeUncertain"];
  const saved = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const scriptModes = [];
  const putRequests = [];
  const beforeRequestListeners = [];
  const headersListeners = [];
  const listenerEvent = (sink) => ({
    addListener: (listener) => sink.push(listener),
    removeListener: (listener) => {
      const index = sink.indexOf(listener);
      if (index >= 0) sink.splice(index, 1);
    },
  });
  const triggers = {
    ambiguousUploadRequest() {
      const beforeRequest = beforeRequestListeners[0];
      assert.ok(beforeRequest, "the observer registered no onBeforeRequest listener");
      beforeRequest({ url: SIGNED_UPLOAD_URL, method: "PUT", requestId: "101" });
      beforeRequest({ url: SIGNED_UPLOAD_URL, method: "PUT", requestId: "102" });
    },
    closeUploadObserver() {
      const observer = hotSpotWorkerRegion.canvasUploadObservers.get(SIGNED_UPLOAD_URL);
      assert.ok(observer, "no upload observer is registered for the signed URL");
      observer.close();
    },
  };
  const values = {
    chrome: {
      scripting: {
        executeScript: async (injection) => {
          const input = injection.args[0];
          scriptModes.push(input.mode);
          const result = input.mode === "initialize"
            ? { ok: true, sent: false, data: { course_id: COURSE_ID, assignment_id: QUIZ_ID, upload_url: SIGNED_UPLOAD_URL } }
            : createdFixture();
          return [{ result }];
        },
      },
      webRequest: {
        onBeforeRequest: listenerEvent(beforeRequestListeners),
        onHeadersReceived: listenerEvent(headersListeners),
      },
    },
    fetch: async (target, options = {}) => {
      putRequests.push({ url: String(target?.href ?? target), method: options.method || "GET" });
      if (duringFetch) duringFetch(triggers);
      // The worker's own read is a plain success in every run below.
      return { status: 200 };
    },
    canvasWriteOutcomeUncertain,
  };
  hotSpotWorkerRegion.canvasUploadObservers.clear();
  try {
    for (const [key, value] of Object.entries(values)) {
      Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    }
    const result = await hotSpotWorkerRegion.executeCanvasNewQuizHotSpotCreate(
      { tabId: 11, origin: ORIGIN, courseId: COURSE_ID, principalId: PRINCIPAL_ID },
      { assignment_id: QUIZ_ID, before_items_sha256: digest(SAVED), item: TEMPLATE, payload_sha256: digest(TEMPLATE) },
      expiresAt,
      {
        content_type: "image/png",
        bytes_base64: Buffer.from(HOT_SPOT_PNG).toString("base64"),
        manifest: {
          filename: "cell.png",
          size_bytes: HOT_SPOT_PNG.byteLength,
          sha256: createHash("sha256").update(HOT_SPOT_PNG).digest("hex"),
        },
      },
    );
    return { result, scriptModes, putRequests };
  } finally {
    for (const key of keys) {
      const descriptor = saved.get(key);
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
}

/** The refusal every unconfirmed watch owes, whatever the worker's own fetch read. */
function assertUnconfirmedUploadRefusal(result, scriptModes, putRequests, error) {
  assert.equal(putRequests.length, 1, "the reviewed bytes are sent once");
  assert.equal(putRequests[0].method, "PUT");
  assert.equal(putRequests[0].url, SIGNED_UPLOAD_URL);
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.sent, true, "the PUT left the worker before the watch ended");
  assert.equal(result.error, error);
  assert.equal(result.status, 200, "the worker's own read is reported but never trusted");
  assert.equal(result.outcomeUnknown, true, "the bytes may have reached the host");
  assert.equal(result.outcomeUnknown, canvasWriteOutcomeUncertain(result.status));
  assert.deepEqual(scriptModes, ["initialize"], "an unconfirmed upload never lets the create run");
}

test("a second request to the signed URL refuses the create even when the worker's own fetch read a success", async () => {
  const { result, scriptModes, putRequests } = await runHotSpotWorker({
    expiresAt: Date.now() + 60_000,
    duringFetch: (triggers) => triggers.ambiguousUploadRequest(),
  });
  assertUnconfirmedUploadRefusal(result, scriptModes, putRequests, "canvas_file_upload_request_ambiguous");
});

test("a closed upload watch refuses the create even when the worker's own fetch read a success", async () => {
  const { result, scriptModes, putRequests } = await runHotSpotWorker({
    expiresAt: Date.now() + 60_000,
    duringFetch: (triggers) => triggers.closeUploadObserver(),
  });
  assertUnconfirmedUploadRefusal(result, scriptModes, putRequests, "canvas_file_upload_observer_closed");
});

test("an upload watch that timed out refuses the create even when the worker's own fetch read a success", async () => {
  // A short deadline is the worker's own timeout path: the abort ends the watch
  // with canvas_file_transfer_timeout while the PUT has already read a 2xx.
  const { result, scriptModes, putRequests } = await runHotSpotWorker({ expiresAt: Date.now() + 250 });
  assertUnconfirmedUploadRefusal(result, scriptModes, putRequests, "canvas_file_transfer_timeout");
});
