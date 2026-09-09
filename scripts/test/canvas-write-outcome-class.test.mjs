import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInThisContext } from "node:vm";
import { bridgeWriteFailureCode, canvasWriteOutcomeUncertain } from "../../connector/extension/src/canvas-write-outcome.js";
import { canvasOperationAdmission } from "../../connector/extension/generated/canvas-operation-admission.js";
import { executeItemBankInPage } from "../../connector/extension/src/item-bank-executor.js";

// Canvas refuses these before it saves anything, so the change definitely did
// not happen and the course item stays free for another attempt.
const REFUSED = [400, 403, 404, 409, 422];
// These arrive after the request reached the application, so the change may
// already be saved. Morrow never sends one of them again.
const UNCERTAIN = [408, 429, 500, 502, 504];

const ORIGIN = "https://school.instructure.com";
const CONTENT_SOURCE = readFileSync(new URL("../../connector/extension/src/canvas-content.js", import.meta.url), "utf8");
const CATALOG = JSON.parse(readFileSync(new URL("../../artifacts/canvas-api/canvas-api-catalog.json", import.meta.url), "utf8"));

function catalogOperation(toolName) {
  const operation = CATALOG.operations.find((entry) => entry.toolName === toolName);
  assert.ok(operation, `missing Canvas operation ${toolName}`);
  // Exactly what connector/extension/src/service-worker.js sends to the page.
  return { ...operation, morrowCourseTarget: canvasOperationAdmission(operation).courseTarget };
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

/**
 * Runs the real content script the way Chrome runs it: the file is evaluated as
 * a classic script against these page globals, and the request goes through its
 * own message listener.
 */
async function executeCanvasInPage(toolName, { status, throwOnRequest = false }) {
  const keys = ["location", "document", "fetch", "chrome", "__morrowCanvasConnectorInstalled"];
  const descriptors = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const operation = catalogOperation(toolName);
  const requests = [];
  const listeners = [];
  const values = {
    location: { origin: ORIGIN, pathname: "/courses/42/assignments" },
    document: { cookie: "_csrf_token=csrf-value; _legacy_normandy_session=session" },
    fetch: async (input, options = {}) => {
      const url = new URL(String(input?.href ?? input), ORIGIN);
      if (url.pathname === "/api/v1/users/self/profile") return jsonResponse({ id: "7", name: "Teacher" });
      if (url.pathname === "/api/v1/courses/42") return jsonResponse({ id: "42", name: "Biology" });
      requests.push({ pathname: url.pathname, method: options.method || "GET" });
      if (throwOnRequest) throw new TypeError("Failed to fetch");
      return jsonResponse({ errors: [{ message: "Canvas did not accept this change." }] }, status);
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
        arguments: { course_id: "42", name: "Weekly labs" },
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

function itemBankStorage(values) {
  return { getItem: (key) => Object.prototype.hasOwnProperty.call(values, key) ? values[key] : null };
}

async function executeItemBankRequest(nickname, argumentsValue, { status, throwOnRequest = false, dispatches = { count: 0 } }) {
  const keys = ["location", "document", "sessionStorage", "localStorage", "fetch", "ENV"];
  const descriptors = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const operation = CATALOG.operations.find((entry) => entry.service === "item_bank" && entry.nickname === nickname);
  assert.ok(operation, `missing Item Bank operation ${nickname}`);
  const token = `Signature ${"item-bank-credential-".repeat(4)}`;
  const capturedAt = Date.now();
  const values = {
    location: { hostname: "school.quiz-lti.instructure.com" },
    document: { referrer: `${ORIGIN}/courses/42/external_tools/54065` },
    sessionStorage: itemBankStorage({ current_user: JSON.stringify({ id: "7" }) }),
    localStorage: itemBankStorage({}),
    ENV: {},
    fetch: async (_input, options = {}) => {
      const method = options.method || "GET";
      if (nickname === "create_bank" && method === "GET") return jsonResponse([]);
      if (method !== "GET") dispatches.count += 1;
      if (throwOnRequest) throw new TypeError("Failed to fetch");
      return jsonResponse({ errors: [{ message: "The Item Banks API did not accept this change." }] }, status);
    },
  };
  try {
    for (const [key, value] of Object.entries(values)) {
      Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    }
    return await executeItemBankInPage({
      operation,
      arguments: argumentsValue,
      principalId: "7",
      canvasOrigin: ORIGIN,
      courseId: "42",
      credential: {
        apiOrigin: "https://school.quiz-api.instructure.com",
        token,
        authType: "Signature",
        contextUuid: "course-context-uuid",
        canvasLocalContextId: "42",
        launchUrl: `${ORIGIN}/courses/42/external_tools/54065`,
        launchNonce: "b28f3aae-8888-4c5b-9a17-458f2e1fe309",
        launchedAt: capturedAt - 1_000,
        capturedAt,
      },
    });
  } finally {
    for (const key of keys) {
      const descriptor = descriptors.get(key);
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
}

test("the one rule separates a refused Canvas write from an uncertain one", () => {
  for (const status of REFUSED) assert.equal(canvasWriteOutcomeUncertain(status), false, `HTTP ${status}`);
  for (const status of UNCERTAIN) assert.equal(canvasWriteOutcomeUncertain(status), true, `HTTP ${status}`);
  // No HTTP answer at all: fetch threw, the tab closed, or the body could not
  // be read. A status outside 4xx never proves a refusal either.
  for (const status of [undefined, null, 0, NaN, "422", 302, 399, 600]) {
    assert.equal(canvasWriteOutcomeUncertain(status), true, String(status));
  }
});

test("a refused Canvas write reaches Morrow as not sent, and an uncertain one does not", () => {
  const canvasWrite = (status, unknown = canvasWriteOutcomeUncertain(status)) => bridgeWriteFailureCode({
    unknown, sent: true, provider: "canvas", kind: "invoke_write", status,
  });
  for (const status of REFUSED) assert.equal(canvasWrite(status), "canvas_request_not_sent", `HTTP ${status}`);
  for (const status of UNCERTAIN) assert.equal(canvasWrite(status), "write_outcome_unknown", `HTTP ${status}`);
  // A page executor that reports its own uncertainty is believed, because that
  // claim only ever holds a change back.
  assert.equal(canvasWrite(422, true), "write_outcome_unknown");
  // A write that never left Chrome, and a write with no HTTP answer at all.
  assert.equal(bridgeWriteFailureCode({ unknown: false, sent: false, provider: "canvas", kind: "invoke_write" }), "canvas_request_not_sent");
  assert.equal(bridgeWriteFailureCode({ unknown: true, sent: true, provider: "canvas", kind: "invoke_write" }), "write_outcome_unknown");
  // Reads keep the shared failed code: they have no provider effect to settle.
  assert.equal(bridgeWriteFailureCode({ unknown: false, sent: true, provider: "canvas", kind: "invoke_read", status: 404 }), "canvas_request_failed");
  // A Moodle form post can answer with a validation page after it saved the
  // change, so no Moodle status is read as a refusal here.
  for (const status of [...REFUSED, ...UNCERTAIN]) {
    assert.equal(
      bridgeWriteFailureCode({ unknown: false, sent: true, provider: "moodle", kind: "invoke_write", status }),
      "canvas_request_failed",
      `HTTP ${status}`,
    );
  }
});

test("the content script reports a refused Canvas write as sent with a known outcome", async () => {
  for (const status of REFUSED) {
    const { result, requests } = await executeCanvasInPage("canvas_create_assignment_group", { status });
    assert.deepEqual(requests, [{ pathname: "/api/v1/courses/42/assignment_groups", method: "POST" }], `HTTP ${status}`);
    assert.equal(result.ok, false, `HTTP ${status}`);
    assert.equal(result.sent, true, `HTTP ${status}`);
    assert.equal(result.status, status);
    assert.equal(result.outcomeUnknown, false, `HTTP ${status}`);
    assert.equal(result.outcomeUnknown, canvasWriteOutcomeUncertain(status), `HTTP ${status}`);
  }
});

test("the content script reports an uncertain Canvas write outcome as unknown", async () => {
  for (const status of UNCERTAIN) {
    const { result } = await executeCanvasInPage("canvas_create_assignment_group", { status });
    assert.equal(result.ok, false, `HTTP ${status}`);
    assert.equal(result.sent, true, `HTTP ${status}`);
    assert.equal(result.status, status);
    assert.equal(result.outcomeUnknown, true, `HTTP ${status}`);
    assert.equal(result.outcomeUnknown, canvasWriteOutcomeUncertain(status), `HTTP ${status}`);
  }
});

test("a Canvas write with no response at all stays uncertain", async () => {
  const { result } = await executeCanvasInPage("canvas_create_assignment_group", { status: 500, throwOnRequest: true });
  assert.deepEqual(result, { ok: false, sent: true, outcomeUnknown: true, error: "canvas_write_response_unknown" });
});

test("a failed Canvas read carries no write outcome", async () => {
  for (const status of [...REFUSED, ...UNCERTAIN]) {
    const { result } = await executeCanvasInPage("canvas_list_assignment_groups", { status });
    assert.equal(result.ok, false, `HTTP ${status}`);
    assert.equal(result.sent, true, `HTTP ${status}`);
    assert.equal(result.status, status);
    assert.equal(Object.hasOwn(result, "outcomeUnknown"), false, `HTTP ${status}`);
  }
  const thrown = await executeCanvasInPage("canvas_list_assignment_groups", { status: 500, throwOnRequest: true });
  assert.deepEqual(thrown.result, { ok: false, sent: true, outcomeUnknown: false, error: "canvas_read_failed" });
});

test("the Item Banks executor classifies one bank creation and keeps failed reads repeatable", async () => {
  const emptyBanksSha256 = createHash("sha256").update("[]").digest("hex");
  const create = { course_id: "42", title: "Question bank", expected_snapshot: { banks_sha256: emptyBanksSha256 } };
  // A 4xx other than 408 and 429 is the only answer that proves Canvas refused
  // the change. One request either way, never a second.
  for (const status of REFUSED) {
    const dispatches = { count: 0 };
    const result = await executeItemBankRequest("create_bank", create, { status, dispatches });
    assert.equal(result.sent, true, `HTTP ${status}`);
    assert.equal(result.ok, false, `HTTP ${status}`);
    assert.equal(result.status, status, `HTTP ${status}`);
    assert.equal(result.outcomeUnknown, false, `HTTP ${status}`);
    assert.equal(dispatches.count, 1, `HTTP ${status}`);
  }
  for (const status of UNCERTAIN) {
    const dispatches = { count: 0 };
    const result = await executeItemBankRequest("create_bank", create, { status, dispatches });
    assert.equal(result.sent, true, `HTTP ${status}`);
    assert.equal(result.ok, false, `HTTP ${status}`);
    assert.equal(result.outcomeUnknown, true, `HTTP ${status}`);
    assert.notEqual(result.verification?.status, "verified", `HTTP ${status}`);
    assert.equal(dispatches.count, 1, `HTTP ${status}`);
  }
  // A lost answer may still have created the bank, so it is uncertain and it is
  // never sent again.
  const dispatches = { count: 0 };
  const thrown = await executeItemBankRequest("create_bank", create, { status: 500, throwOnRequest: true, dispatches });
  assert.equal(thrown.sent, true);
  assert.equal(thrown.outcomeUnknown, true);
  assert.equal(dispatches.count, 1);
  for (const status of [...REFUSED, ...UNCERTAIN]) {
    const read = await executeItemBankRequest("list_banks", { course_id: "42", morrow_max_pages: 1 }, { status });
    assert.equal(read.ok, false, `HTTP ${status}`);
    assert.equal(read.sent, true, `HTTP ${status}`);
    assert.equal(read.outcomeUnknown, false, `HTTP ${status}`);
  }
});
