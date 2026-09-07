import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { executeItemBankInPage } from "../../connector/extension/src/item-bank-executor.js";
import { validateQuizItemPayload } from "../../connector/extension/src/quiz-item-payload.js";
import {
  CASES,
  choice,
  IMAGE,
  item,
  PASS_THROUGH_SLUGS,
  UNCHECKABLE_ENTRY,
} from "./lib/quiz-item-payload-cases.mjs";

const catalog = JSON.parse(readFileSync(new URL("../../artifacts/canvas-api/canvas-api-catalog.json", import.meta.url), "utf8"));
const operations = new Map(catalog.operations.filter((operation) => operation.service === "item_bank").map((operation) => [operation.nickname, operation]));

function storage(values) {
  return { getItem: (key) => Object.hasOwn(values, key) ? values[key] : null };
}

/**
 * Runs the copy of the rules inside the injected function, the way Chrome runs
 * it: `executeItemBankInPage` reads the page globals defined here, so the
 * verdict this returns is the verdict a real Item Banks frame would reach.
 *
 * Returns the executor result and every request it made, so a refusal can be
 * proven to happen before anything is sent.
 */
async function sendItem(nickname, argumentsValue) {
  const keys = ["location", "document", "sessionStorage", "localStorage", "fetch", "ENV"];
  const descriptors = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const calls = [];
  const values = {
    location: { hostname: "school.quiz-lti.instructure.com" },
    document: { referrer: "https://school.instructure.com/courses/42/external_tools/9" },
    sessionStorage: storage({
      current_user: JSON.stringify({ id: "7" }),
      "banks.build_token": `Signature ${"item-bank-credential-".repeat(4)}`,
      item_banks_scope: JSON.stringify({ course_id: "42" }),
    }),
    localStorage: storage({}),
    fetch: async (url, options) => {
      calls.push({ url: String(url), method: options.method, body: options.body ? JSON.parse(options.body) : null });
      return new Response(JSON.stringify({ id: "501", entry_type: "Item" }), { status: 200, headers: { "content-type": "application/json" } });
    },
    ENV: {},
  };
  try {
    for (const [key, value] of Object.entries(values)) {
      Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    }
    const operation = operations.get(nickname);
    assert.ok(operation, `missing Item Bank operation ${nickname}`);
    const result = await executeItemBankInPage({
      principalId: "7",
      canvasOrigin: "https://school.instructure.com",
      courseId: "42",
      operation,
      arguments: argumentsValue,
    });
    return { result, calls };
  } finally {
    for (const key of keys) {
      const descriptor = descriptors.get(key);
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
}

test("every payload rule reaches its own verdict", () => {
  for (const { name, item: payload, reason } of CASES) {
    assert.equal(validateQuizItemPayload(payload), reason, name);
  }
  // Two accepted and two refused cases for each shape the file checks, and one
  // media case for each of them, so no rule is proven in one direction only.
  const accepted = CASES.filter((entry) => entry.reason === null);
  const refused = CASES.filter((entry) => entry.reason !== null);
  assert.ok(accepted.length >= 20, `only ${accepted.length} accepted payloads`);
  assert.ok(refused.length >= 20, `only ${refused.length} refused payloads`);
  for (const prefix of ["choice_", "matching_", "numeric_", "rich_fill_", "media_"]) {
    assert.ok(refused.filter((entry) => entry.reason.startsWith(prefix)).length >= 2, `fewer than two refusals for ${prefix}`);
  }
});

test("a question read flat is read the same way as one wrapped in its item record", () => {
  for (const { name, item: payload, reason } of CASES) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload) || !payload.entry) continue;
    assert.equal(validateQuizItemPayload(payload.entry), reason, name);
  }
});

test("the eight interaction types an allowlist once refused are all sent", () => {
  // The same payload, refused as a choice question, is accepted under every one
  // of the eight. Nothing about it changes except the type it declares.
  assert.equal(validateQuizItemPayload(item({ interaction_type_slug: "choice", ...UNCHECKABLE_ENTRY })), "choice_too_few");
  for (const slug of PASS_THROUGH_SLUGS) {
    assert.equal(validateQuizItemPayload(item({ interaction_type_slug: slug, ...UNCHECKABLE_ENTRY })), null, slug);
  }
});

test("media is still checked for every one of the eight pass-through types", () => {
  for (const slug of PASS_THROUGH_SLUGS) {
    const described = item({ interaction_type_slug: slug, ...UNCHECKABLE_ENTRY, item_body: `<p>Sort these.</p>${IMAGE}` });
    const undescribed = item({ interaction_type_slug: slug, ...UNCHECKABLE_ENTRY, item_body: '<p>Sort these.</p><img src="/courses/42/files/9">' });
    const offsite = item({ interaction_type_slug: slug, ...UNCHECKABLE_ENTRY, item_body: '<p>Sort these.</p><img alt="A cell" src="http://example.edu/cell.png">' });
    assert.equal(validateQuizItemPayload(described), null, slug);
    assert.equal(validateQuizItemPayload(undescribed), "media_image_alt_missing", slug);
    assert.equal(validateQuizItemPayload(offsite), "media_src_unsupported", slug);
  }
});

test("the copy of the rules inside the injected function answers exactly as the module does", async () => {
  for (const { name, item: payload, reason } of CASES) {
    const { result, calls } = await sendItem("create_item", { bank_id: "91", item: payload });
    if (reason === null) {
      assert.equal(result.ok, true, name);
      assert.equal(calls.length, 1, name);
      assert.deepEqual(calls[0].body, { item: payload }, name);
    } else {
      assert.deepEqual(result, { matched: true, ok: false, sent: false, error: `item_bank_payload_${reason}` }, name);
      assert.deepEqual(calls, [], name);
    }
  }
});

test("a question update is checked by the same rules as a question create", async () => {
  const refused = await sendItem("update_item", { bank_id: "91", item_id: "501", item: choice({ scoring_data: { value: "c9" } }) });
  assert.deepEqual(refused.result, { matched: true, ok: false, sent: false, error: "item_bank_payload_choice_scoring_value_not_a_choice_id" });
  assert.deepEqual(refused.calls, []);

  const accepted = await sendItem("update_item", { bank_id: "91", item_id: "501", item: choice() });
  assert.equal(accepted.result.ok, true);
  assert.equal(accepted.calls.length, 1);
  assert.equal(accepted.calls[0].method, "PATCH");
});

test("a payload the caller already wrapped is checked, not the wrapper", async () => {
  const { result, calls } = await sendItem("create_item", { bank_id: "91", item: { item: choice({ scoring_data: { value: "c9" } }) } });
  assert.deepEqual(result, { matched: true, ok: false, sent: false, error: "item_bank_payload_choice_scoring_value_not_a_choice_id" });
  assert.deepEqual(calls, []);
});

test("a question that is not an object is refused before anything is sent", async () => {
  const { result, calls } = await sendItem("create_item", { bank_id: "91", item: "a question" });
  assert.deepEqual(result, { matched: true, ok: false, sent: false, error: "item_bank_payload_payload_not_an_object" });
  assert.deepEqual(calls, []);
});
