import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { ITEM_BANK_FRAME_HOST_PATTERN, itemBankApiOriginForFrame, itemBankFrameIds } from "../../connector/extension/src/item-bank-frames.js";
import { executeItemBankInPage } from "../../connector/extension/src/item-bank-executor.js";

const catalog = JSON.parse(readFileSync(new URL("../../artifacts/canvas-api/canvas-api-catalog.json", import.meta.url), "utf8"));
const listBanks = catalog.operations.find((operation) => operation.service === "item_bank" && operation.nickname === "list_banks");
assert.ok(listBanks, "missing Item Bank operation list_banks");

const frame = (frameId, url) => ({ frameId, parentFrameId: frameId === 0 ? -1 : 0, url, documentId: `document-${frameId}` });
const canvasTopFrame = frame(0, "https://school.instructure.com/courses/42/quizzes");

test("no frames yields no injection target", () => {
  assert.deepEqual(itemBankFrameIds([]), []);
  // getAllFrames resolves to null when the tab is gone, and the service worker
  // turns a rejection into an empty list.
  assert.deepEqual(itemBankFrameIds(null), []);
  assert.deepEqual(itemBankFrameIds(undefined), []);
  assert.deepEqual(itemBankFrameIds("frames"), []);
});

test("a Canvas page with no Item Banks frame yields no injection target", () => {
  const frames = [
    canvasTopFrame,
    frame(2, "https://school.instructure.com/courses/42/external_tools/9"),
    frame(3, "https://vendor.example/player/embed?course=42"),
  ];
  assert.deepEqual(itemBankFrameIds(frames), []);
});

test("a hostile frame on an unrelated origin is never a target", () => {
  const frames = [
    canvasTopFrame,
    frame(2, "https://evil.example/lti/launch?host=school.quiz-lti.instructure.com"),
    frame(3, "https://school.quiz-lti.instructure.com@evil.example/lti/launch"),
    frame(4, "https://school.quiz-lti.instructure.com.evil.example/lti/launch"),
    frame(5, "https://evil.example/lti/launch#https://school.quiz-lti.instructure.com"),
    frame(6, "https://evil.example/school.quiz-lti.instructure.com"),
  ];
  assert.deepEqual(itemBankFrameIds(frames), []);
});

test("a lookalike Item Banks host is never a target", () => {
  const hostnames = [
    "quiz-lti.instructure.com",
    "school.beta.quiz-lti.instructure.com",
    "school.quiz-ltix.instructure.com",
    "school.notquiz-lti.instructure.com",
    "school.quiz-web.instructure.com",
    "school.quiz-lti.instructure.co",
    "school.quiz-lti.instructure.com.br",
  ];
  for (const hostname of hostnames) {
    assert.deepEqual(itemBankFrameIds([frame(2, `https://${hostname}/lti/launch`)]), [], hostname);
  }
});

test("one Item Banks frame is the only target", () => {
  assert.deepEqual(itemBankFrameIds([canvasTopFrame, frame(7, "https://school.quiz-lti.instructure.com/lti/launch")]), [7]);
  assert.deepEqual(itemBankFrameIds([canvasTopFrame, frame(7, "https://school.quiz-api.instructure.com/banks")]), [7]);
  assert.deepEqual(itemBankFrameIds([canvasTopFrame, frame(7, "https://school.quiz-lti-iad-prod.instructure.com/lti/launch")]), [7]);
  assert.deepEqual(itemBankFrameIds([canvasTopFrame, frame(7, "https://SCHOOL.QUIZ-LTI.INSTRUCTURE.COM/lti/launch")]), [7]);
});

test("the frame host maps to only its exact same-tenant quiz-api origin", () => {
  assert.equal(itemBankApiOriginForFrame("https://school.quiz-lti-iad-prod.instructure.com/lti/launch"), "https://school.quiz-api-iad-prod.instructure.com");
  assert.equal(itemBankApiOriginForFrame("https://school.quiz-api-iad-prod.instructure.com/api/banks"), "https://school.quiz-api-iad-prod.instructure.com");
  assert.equal(itemBankApiOriginForFrame("https://school.instructure.com/courses/42"), "");
  assert.equal(itemBankApiOriginForFrame("http://school.quiz-lti-iad-prod.instructure.com/lti/launch"), "");
});

test("a hostile frame alongside the Item Banks frame is dropped", () => {
  const frames = [
    canvasTopFrame,
    frame(3, "https://evil.example/lti/launch"),
    frame(7, "https://school.quiz-lti.instructure.com/lti/launch"),
    frame(9, "https://vendor.example/player/embed"),
  ];
  assert.deepEqual(itemBankFrameIds(frames), [7]);
});

test("two Item Banks frames stay visible so the caller can refuse an ambiguous tab", () => {
  const frames = [
    canvasTopFrame,
    frame(7, "https://school.quiz-lti.instructure.com/lti/launch"),
    frame(11, "https://school.quiz-api.instructure.com/banks"),
  ];
  assert.deepEqual(itemBankFrameIds(frames), [7, 11]);
});

test("an Item Banks host over http is refused", () => {
  const frames = [
    frame(2, "http://school.quiz-lti.instructure.com/lti/launch"),
    frame(3, "http://school.quiz-api.instructure.com/banks"),
  ];
  assert.deepEqual(itemBankFrameIds(frames), []);
});

test("a frame with no navigable https URL is refused", () => {
  const frames = [
    frame(2, "about:blank"),
    frame(3, "data:text/html,<p>launch</p>"),
    frame(4, "blob:https://school.quiz-lti.instructure.com/9f1c"),
    frame(5, "chrome-extension://abeloclekioohahgedmjcdbpllfjfhko/popup/popup.html"),
  ];
  assert.deepEqual(itemBankFrameIds(frames), []);
});

test("malformed frame entries are ignored without dropping a valid frame", () => {
  const frames = [
    null,
    "frame",
    { frameId: 2, url: "not a url" },
    { frameId: 3 },
    { frameId: 4, url: null },
    { frameId: 5, url: "" },
    { url: "https://school.quiz-lti.instructure.com/lti/launch" },
    { frameId: "7", url: "https://school.quiz-lti.instructure.com/lti/launch" },
    { frameId: -1, url: "https://school.quiz-lti.instructure.com/lti/launch" },
    { frameId: 1.5, url: "https://school.quiz-lti.instructure.com/lti/launch" },
    frame(7, "https://school.quiz-lti.instructure.com/lti/launch"),
  ];
  assert.deepEqual(itemBankFrameIds(frames), [7]);
});

test("the exported host pattern is the one rule the permission origins also use", () => {
  assert.ok(ITEM_BANK_FRAME_HOST_PATTERN.test("school.quiz-lti.instructure.com"));
  assert.ok(ITEM_BANK_FRAME_HOST_PATTERN.test("school.quiz-api-iad-prod.instructure.com"));
  assert.equal(ITEM_BANK_FRAME_HOST_PATTERN.test("school.instructure.com"), false);
  assert.equal(ITEM_BANK_FRAME_HOST_PATTERN.test("evil.example"), false);
  assert.equal(ITEM_BANK_FRAME_HOST_PATTERN.global, false, "a global pattern would carry lastIndex between frames");
});

function storage(values) {
  return { getItem: (key) => Object.prototype.hasOwnProperty.call(values, key) ? values[key] : null };
}

async function probeInFrame(hostname) {
  const keys = ["location", "document", "sessionStorage", "localStorage", "ENV"];
  const descriptors = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const values = {
    location: { hostname },
    document: { referrer: "https://school.instructure.com/courses/42/external_tools/54065" },
    sessionStorage: storage({ current_user: JSON.stringify({ id: "7" }) }),
    localStorage: storage({}),
    ENV: {},
  };
  try {
    for (const [key, value] of Object.entries(values)) {
      Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    }
    // Exactly the probe payload connector/extension/src/service-worker.js sends:
    // the binding and the operation shape, and no arguments.
    return await executeItemBankInPage({
      operation: listBanks,
      principalId: "7",
      canvasOrigin: "https://school.instructure.com",
      courseId: "42",
      contextOnly: true,
    });
  } finally {
    for (const key of keys) {
      const descriptor = descriptors.get(key);
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
}

test("the in-frame host rule agrees with the injection targets, and the probe needs no arguments", async () => {
  for (const hostname of ["school.quiz-lti.instructure.com", "school.quiz-api.instructure.com"]) {
    assert.deepEqual(itemBankFrameIds([frame(7, `https://${hostname}/lti/launch`)]), [7], hostname);
    assert.deepEqual(await probeInFrame(hostname), { matched: true, ok: true, sent: false }, hostname);
  }
  for (const hostname of ["school.instructure.com", "evil.example", "school.quiz-lti.instructure.com.evil.example"]) {
    assert.deepEqual(itemBankFrameIds([frame(7, `https://${hostname}/lti/launch`)]), [], hostname);
    assert.deepEqual(await probeInFrame(hostname), { matched: false }, hostname);
  }
});
