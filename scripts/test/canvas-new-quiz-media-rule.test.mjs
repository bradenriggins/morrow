import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInThisContext } from "node:vm";
import { canvasOperationAdmission } from "../../connector/extension/generated/canvas-operation-admission.js";
import { itemBankMediaFindings, itemBankNewMediaReason } from "../../connector/extension/src/item-bank-guard.js";
import { completeQuizItemPayloadReason } from "../../connector/extension/src/quiz-item-payload.js";

const WORKER_SOURCE = readFileSync(new URL("../../connector/extension/src/service-worker.js", import.meta.url), "utf8");

const ORIGIN = "https://school.instructure.com";
const COURSE_ID = "42";
const QUIZ_ID = "77";
const ITEM_ID = "88";
const ITEMS_PATH = `/api/quiz/v1/courses/${COURSE_ID}/quizzes/${QUIZ_ID}/items`;
const CONTENT_SOURCE = readFileSync(new URL("../../connector/extension/src/canvas-content.js", import.meta.url), "utf8");
const CATALOG = JSON.parse(readFileSync(new URL("../../artifacts/canvas-api/canvas-api-catalog.json", import.meta.url), "utf8"));

const FIRST = '<img src="/courses/42/files/61">';
const SECOND = '<img src="/courses/42/files/62">';
const THIRD = '<img src="/courses/42/files/63">';
const FIRST_REPAIRED = '<img src="/courses/42/files/61" alt="A mitochondrion">';

function catalogOperation(toolName) {
  const operation = CATALOG.operations.find((entry) => entry.toolName === toolName);
  assert.ok(operation, `missing Canvas operation ${toolName}`);
  return { ...operation, morrowCourseTarget: canvasOperationAdmission(operation).courseTarget };
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function essayItem(body) {
  return {
    id: ITEM_ID, entry_type: "Item", status: "mutable", position: 1, points_possible: 1,
    entry: {
      interaction_type_slug: "essay",
      item_body: body,
      interaction_data: { rce: true, essay: null, word_count: true, file_upload: false, spell_check: true, word_limit_enabled: false },
      scoring_data: { value: "" },
      scoring_algorithm: "None",
    },
  };
}

/**
 * Runs the real content script the way Chrome runs it: the file is evaluated as
 * a classic script against these page globals, so the request the test reads is
 * the request Canvas would receive.
 */
async function sendQuizItem(args, { stored = essayItem(`<p>${FIRST}${SECOND}</p>`), toolName = "canvas_update_quiz_item" } = {}) {
  const keys = ["location", "document", "fetch", "chrome", "__morrowCanvasConnectorInstalled"];
  const descriptors = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const operation = catalogOperation(toolName);
  const requests = [];
  const listeners = [];
  const values = {
    location: { origin: ORIGIN, protocol: "https:", pathname: `/courses/${COURSE_ID}/quizzes` },
    document: { cookie: "_csrf_token=csrf-value; _legacy_normandy_session=session" },
    fetch: async (input, options = {}) => {
      const url = new URL(String(input?.href ?? input), ORIGIN);
      if (url.pathname === "/api/v1/users/self/profile") return jsonResponse({ id: "7", name: "Teacher" });
      if (url.pathname === `/api/v1/courses/${COURSE_ID}`) return jsonResponse({ id: COURSE_ID, name: "Biology" });
      const method = options.method || "GET";
      requests.push({ method, pathname: url.pathname, body: options.body ?? null });
      if (method === "GET") {
        if (url.pathname === ITEMS_PATH) return jsonResponse([{ id: ITEM_ID, position: 1, entry_type: "Item" }]);
        return jsonResponse(stored);
      }
      return jsonResponse(stored);
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
        arguments: { course_id: COURSE_ID, assignment_id: QUIZ_ID, item_id: ITEM_ID, ...args },
        principalId: "7",
        expiresAt: Date.now() + 60_000,
        courseId: COURSE_ID,
      }, null, resolve);
      if (handled !== true) reject(new Error("the content script did not accept the execute message"));
    });
    return { result, requests, written: requests.filter((request) => request.method !== "GET") };
  } finally {
    for (const key of keys) {
      const descriptor = descriptors.get(key);
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
}

/** The copy of the rule that lives inside canvas-content.js, lifted out to be compared. */
function contentScriptRule() {
  const start = CONTENT_SOURCE.indexOf("  const NEW_QUIZ_MEDIA_RULE = (() => {");
  assert.ok(start >= 0, "canvas-content.js no longer carries its copy of the media rule");
  const end = CONTENT_SOURCE.indexOf("\n  })();", start);
  assert.ok(end > start, "the media rule copy in canvas-content.js is not closed");
  const source = CONTENT_SOURCE.slice(start + "  const NEW_QUIZ_MEDIA_RULE = ".length, end + "\n  })();".length);
  return runInThisContext(`(${source.replace(/;\s*$/, "")})`, { filename: "canvas-content-media-rule.js" });
}

// Every case is one stored question and one proposed change. `reason` is the
// verdict both copies of the rule have to reach: the module the Item Bank guard
// exports, and the copy inside canvas-content.js.
const CASES = [
  { name: "an unchanged question adds nothing", stored: `<p>${FIRST}${SECOND}</p>`, proposed: `<p>${FIRST}${SECOND}</p>`, reason: null },
  { name: "describing the first image is allowed", stored: `<p>${FIRST}${SECOND}</p>`, proposed: `<p>${FIRST_REPAIRED}${SECOND}</p>`, reason: null },
  { name: "describing both images is allowed", stored: `<p>${FIRST}${SECOND}</p>`, proposed: `<p>${FIRST_REPAIRED}<img src="/courses/42/files/62" alt="A ribosome"></p>`, reason: null },
  { name: "a third undescribed image is refused", stored: `<p>${FIRST}${SECOND}</p>`, proposed: `<p>${FIRST_REPAIRED}${SECOND}${THIRD}</p>`, reason: "media_image_alt_missing" },
  { name: "a second copy of the same undescribed image is refused", stored: `<p>${FIRST}</p>`, proposed: `<p>${FIRST}${FIRST}</p>`, reason: "media_image_alt_missing" },
  { name: "a code already present never excuses a new element", stored: `<p>${FIRST}</p>`, proposed: `<p>${FIRST}${SECOND}</p>`, reason: "media_image_alt_missing" },
  { name: "a new unsupported source is refused", stored: `<p>${FIRST}</p>`, proposed: `<p>${FIRST}<img src="ftp://x/y" alt="a"></p>`, reason: "media_src_unsupported" },
  { name: "an unsupported source already stored is allowed", stored: '<p><img src="ftp://x/y" alt="a"></p>', proposed: '<p><img src="ftp://x/y" alt="a"></p>', reason: null },
  { name: "unreadable markup names no element, so it is always refused", stored: "<p><script><img src='/courses/42/files/1'></p>", proposed: "<p><script><img src='/courses/42/files/1'></p>", reason: "media_markup_unreadable" },
  { name: "a question with no media is clean", stored: "<p>Plain text.</p>", proposed: "<p>Plain text still.</p>", reason: null },
];

test("both copies of the relative media rule reach the same verdict", () => {
  const content = contentScriptRule();
  for (const rule of [{ label: "item-bank-guard", newMediaReason: itemBankNewMediaReason }, { label: "canvas-content", newMediaReason: content.newMediaReason }]) {
    for (const entry of CASES) {
      assert.equal(
        rule.newMediaReason(essayItem(entry.proposed), essayItem(entry.stored)),
        entry.reason,
        `${rule.label}: ${entry.name}`,
      );
    }
  }
});

test("both copies find the same media problems in the same order", () => {
  const content = contentScriptRule();
  for (const entry of CASES) {
    const payload = essayItem(entry.proposed);
    assert.deepEqual(
      content.mediaFindings(payload),
      itemBankMediaFindings(payload),
      entry.name,
    );
  }
});

test("the validation copy hides only media, so every other rule still runs", () => {
  const content = contentScriptRule();
  const held = essayItem(`<p>${FIRST}${SECOND}</p>`);
  const neutral = content.withoutHeldMedia(held);
  assert.deepEqual(content.mediaFindings(neutral), [], "the validation copy still carries a media problem");
  assert.deepEqual(itemBankMediaFindings(neutral), []);
  // The payload keeps its shape, so the rest of the contract sees the same question.
  assert.equal(neutral.entry.interaction_type_slug, "essay");
  assert.equal(neutral.entry.scoring_algorithm, "None");
  assert.notEqual(neutral.entry.item_body.trim(), "", "an image-only body must not become blank");
  // Nothing is rewritten in place.
  assert.equal(held.entry.item_body, `<p>${FIRST}${SECOND}</p>`);
  // A payload with no media is returned untouched.
  const clean = essayItem("<p>Plain.</p>");
  assert.equal(content.withoutHeldMedia(clean), clean);
});

test("a repair that describes one of two undescribed images is sent, and leaves the other alone", async () => {
  const { result, written } = await sendQuizItem({
    item_entry_item_body: `<p>${FIRST_REPAIRED}${SECOND}</p>`,
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(written.length, 1, "exactly one change is sent");
  const sent = JSON.parse(written[0].body);
  assert.equal(sent.item.entry.item_body, `<p>${FIRST_REPAIRED}${SECOND}</p>`);
  // The second image is untouched: still present, still undescribed.
  assert.ok(sent.item.entry.item_body.includes(SECOND));
});

test("the same repair is refused when it also adds a third undescribed image", async () => {
  const { result, written } = await sendQuizItem({
    item_entry_item_body: `<p>${FIRST_REPAIRED}${SECOND}${THIRD}</p>`,
  });
  assert.equal(result.ok, false);
  assert.equal(result.sent, false);
  assert.match(result.error, /^new_quiz_item_payload_invalid:/);
  assert.match(result.error, /alt attribute/);
  assert.deepEqual(written, [], "no change may be sent");
});

test("a stored media problem never hides a rule that is not about media", async () => {
  // The body keeps both stored images and is otherwise unchanged, but the
  // scoring algorithm this question would end up with is not one Canvas accepts.
  const { result, written } = await sendQuizItem({
    item_entry_item_body: `<p>${FIRST}${SECOND}</p>`,
    item_entry_scoring_algorithm: "Equivalence",
  });
  assert.equal(result.ok, false);
  assert.equal(result.sent, false);
  assert.match(result.error, /^new_quiz_item_payload_invalid:/);
  assert.doesNotMatch(result.error, /alt attribute/);
  assert.deepEqual(written, [], "no change may be sent");
});

test("a create carrying an undescribed image is still refused outright", async () => {
  const { result, written } = await sendQuizItem({
    item_entry_type: "Item",
    item_entry_item_body: `<p>${FIRST}</p>`,
    item_entry_interaction_type_slug: "essay",
    item_entry_interaction_data: { rce: true, essay: null, word_count: true, file_upload: false, spell_check: true, word_limit_enabled: false },
    item_entry_scoring_data: { value: "" },
    item_entry_scoring_algorithm: "None",
    morrow_new_quiz_item_lifecycle_guard: {
      kind: "create",
      before_items_sha256: "0".repeat(64),
      payload_sha256: "0".repeat(64),
    },
  }, { toolName: "canvas_create_quiz_item" });
  assert.equal(result.ok, false);
  assert.equal(result.sent, false);
  assert.deepEqual(written, [], "no change may be sent");
});

/**
 * The Item Banks pre-flight in connector/extension/src/service-worker.js. That
 * worker never holds the stored question, so an update's media is left to the
 * Item Banks frame, which reads the stored question immediately before the
 * write. What the worker still decides is exactly this, and it decides it with
 * its own copy of the traversal, pinned below.
 */
function workerPreflight(item, nickname, withoutHeldMedia) {
  const findings = itemBankMediaFindings(item);
  const absolute = nickname === "create_item" ? findings[0] : findings.find((finding) => !finding.tag);
  if (absolute) return `item_bank_payload_${absolute.reason}`;
  const reason = completeQuizItemPayloadReason(withoutHeldMedia(item, findings));
  return reason ? `item_bank_payload_${reason}` : null;
}

test("the Item Banks pre-flight keeps every non-media refusal and defers only an update's media", () => {
  const content = contentScriptRule();
  const held = (item) => content.withoutHeldMedia(item);
  const undescribed = essayItem(`<p>${FIRST}${SECOND}</p>`);
  const repaired = essayItem(`<p>${FIRST_REPAIRED}${SECOND}</p>`);
  const unreadable = essayItem("<p><script><img src='/courses/42/files/1'></p>");
  const broken = { ...undescribed, entry: { ...undescribed.entry, scoring_algorithm: "Equivalence" } };

  // A create is judged on its own, so every media problem still refuses here.
  assert.equal(workerPreflight(undescribed, "create_item", held), "item_bank_payload_media_image_alt_missing");
  assert.equal(workerPreflight(repaired, "create_item", held), "item_bank_payload_media_image_alt_missing");
  // An update's media problems go to the frame, which holds the stored question.
  assert.equal(workerPreflight(undescribed, "update_item", held), null);
  assert.equal(workerPreflight(repaired, "update_item", held), null);
  // Unreadable markup names no element, so it can never be matched later.
  assert.equal(workerPreflight(unreadable, "update_item", held), "item_bank_payload_media_markup_unreadable");
  // A rule that is not about media still refuses, even behind a media problem.
  assert.equal(workerPreflight(broken, "update_item", held), "item_bank_payload_create_scoring_algorithm_invalid");
  assert.equal(workerPreflight(essayItem("<p>Plain.</p>"), "update_item", held), null);
});

test("the service worker runs that pre-flight, with its own copy of the traversal", () => {
  assert.match(WORKER_SOURCE, /const findings = itemBankMediaFindings\(item\);/);
  assert.match(
    WORKER_SOURCE,
    /const absolute = operation\.nickname === "create_item" \? findings\[0\] : findings\.find\(\(finding\) => !finding\.tag\);/,
  );
  assert.match(WORKER_SOURCE, /completeQuizItemPayloadReason\(withoutMediaElements\(item, findings\)\)/);
  // The worker must not reach Canvas with a media refusal it cannot justify.
  assert.doesNotMatch(WORKER_SOURCE, /completeQuizItemPayloadReason\(item\)/);
});
