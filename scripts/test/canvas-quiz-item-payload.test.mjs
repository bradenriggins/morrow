import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { executeItemBankInPage } from "../../connector/extension/src/item-bank-executor.js";
import { completeQuizItemPayloadReason, validateQuizItemPayload } from "../../connector/extension/src/quiz-item-payload.js";
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
 * Runs the injected Item Banks function the way Chrome runs it.
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
    document: { referrer: "https://school.instructure.com/courses/42/external_tools/54065" },
    sessionStorage: storage({ current_user: JSON.stringify({ id: "7" }) }),
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

test("the eight interaction types an allowlist once refused pass the partial structural guard", () => {
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

test("generic Item Bank question creates require the exact frame credential before payload dispatch", async () => {
  for (const { name, item: payload, reason } of CASES) {
    const { result, calls } = await sendItem("create_item", { bank_id: "91", item: payload });
    assert.deepEqual(result, { matched: true, ok: false, sent: false, error: "item_bank_credential_unavailable" }, `${name}: ${reason}`);
    assert.deepEqual(calls, [], name);
  }
});

test("generic Item Bank question updates require the exact frame credential", async () => {
  const refused = await sendItem("update_item", { bank_id: "91", item_id: "501", item: choice({ scoring_data: { value: "c9" } }) });
  assert.deepEqual(refused.result, { matched: true, ok: false, sent: false, error: "item_bank_credential_unavailable" });
  assert.deepEqual(refused.calls, []);

  const accepted = await sendItem("update_item", { bank_id: "91", item_id: "501", item: choice() });
  assert.deepEqual(accepted.result, { matched: true, ok: false, sent: false, error: "item_bank_credential_unavailable" });
  assert.deepEqual(accepted.calls, []);
});

test("a wrapped generic Item Bank create still requires the exact frame credential", async () => {
  const { result, calls } = await sendItem("create_item", { bank_id: "91", item: { item: choice({ scoring_data: { value: "c9" } }) } });
  assert.deepEqual(result, { matched: true, ok: false, sent: false, error: "item_bank_credential_unavailable" });
  assert.deepEqual(calls, []);
});

test("a non-object generic Item Bank create cannot bypass the credential boundary", async () => {
  const { result, calls } = await sendItem("create_item", { bank_id: "91", item: "a question" });
  assert.deepEqual(result, { matched: true, ok: false, sent: false, error: "item_bank_credential_unavailable" });
  assert.deepEqual(calls, []);
});

const CATEGORY_A = "11111111-1111-4111-8111-111111111111";
const CATEGORY_B = "22222222-2222-4222-8222-222222222222";
const ANSWER_A = "33333333-3333-4333-8333-333333333333";
const ANSWER_B = "44444444-4444-4444-8444-444444444444";

function categorizationCreate(over = {}) {
  return item({
    interaction_type_slug: "categorization", item_body: "<p>Sort these.</p>", scoring_algorithm: "Categorization",
    interaction_data: {
      categories: { [CATEGORY_A]: { id: CATEGORY_A, item_body: "A" }, [CATEGORY_B]: { id: CATEGORY_B, item_body: "B" } },
      distractors: { [ANSWER_A]: { id: ANSWER_A, item_body: "Alpha" }, [ANSWER_B]: { id: ANSWER_B, item_body: "Beta" } },
      category_order: [CATEGORY_A, CATEGORY_B],
    },
    scoring_data: { score_method: "all_or_nothing", value: [
      { id: CATEGORY_A, scoring_algorithm: "AllOrNothing", scoring_data: { value: [ANSWER_A] } },
      { id: CATEGORY_B, scoring_algorithm: "AllOrNothing", scoring_data: { value: [ANSWER_B] } },
    ] },
    ...over,
  });
}

function matchingCreate(over = {}) {
  return item({
    interaction_type_slug: "matching", item_body: "<p>Match each one.</p>", scoring_algorithm: "DeepEquals",
    interaction_data: { questions: [{ id: "a", item_body: "Alpha" }, { id: "b", item_body: "Beta" }], answers: ["One", "Two"] },
    scoring_data: {
      value: { a: "One", b: "Two" },
      edit_data: { matches: [{ question_id: "a", question_body: "Alpha", answer_body: "One" }, { question_id: "b", question_body: "Beta", answer_body: "Two" }], distractors: [] },
    },
    ...over,
  });
}

/**
 * A create writes the whole object, so a key Morrow never checked must never reach Canvas. The
 * key sets are the ones the New Quiz Items appendix publishes for these two question types.
 * https://developerdocs.instructure.com/services/canvas/resources/new_quiz_items
 */
test("matching and categorization creates refuse an unrecognised structural key", () => {
  const base = categorizationCreate().entry;
  const matchingBase = matchingCreate().entry;
  const cases = [
    ["categorization baseline", categorizationCreate(), null],
    ["categorization interaction key", categorizationCreate({ interaction_data: { ...base.interaction_data, unexpected: true } }), "categorization_structure_invalid"],
    ["categorization scoring key", categorizationCreate({ scoring_data: { ...base.scoring_data, unexpected: true } }), "categorization_scoring_invalid"],
    ["categorization scoring row key", categorizationCreate({ scoring_data: { ...base.scoring_data, value: base.scoring_data.value.map((row, index) => index === 0 ? { ...row, unexpected: true } : row) } }), "categorization_scoring_invalid"],
    ["categorization nested scoring key", categorizationCreate({ scoring_data: { ...base.scoring_data, value: base.scoring_data.value.map((row, index) => index === 0 ? { ...row, scoring_data: { ...row.scoring_data, unexpected: true } } : row) } }), "categorization_scoring_invalid"],
    // Canvas documents the categorization questions shuffle as "currently always false".
    ["categorization shuffled questions", categorizationCreate({ properties: { shuffle_rules: { questions: { shuffled: true } } } }), "create_properties_invalid"],
    ["matching baseline", matchingCreate(), null],
    ["matching interaction key", matchingCreate({ interaction_data: { ...matchingBase.interaction_data, unexpected: true } }), "matching_structure_invalid"],
    ["matching scoring key", matchingCreate({ scoring_data: { ...matchingBase.scoring_data, unexpected: true } }), "matching_structure_invalid"],
    ["matching edit_data key", matchingCreate({ scoring_data: { ...matchingBase.scoring_data, edit_data: { ...matchingBase.scoring_data.edit_data, unexpected: true } } }), "matching_structure_invalid"],
    ["matching match row key", matchingCreate({ scoring_data: { ...matchingBase.scoring_data, edit_data: { ...matchingBase.scoring_data.edit_data, matches: matchingBase.scoring_data.edit_data.matches.map((match, index) => index === 0 ? { ...match, unexpected: true } : match) } } }), "matching_structure_invalid"],
    // Matching documents its questions shuffle as a real setting, so it stays allowed.
    ["matching shuffled questions", matchingCreate({ properties: { shuffle_rules: { questions: { shuffled: true } } } }), null],
  ];
  for (const [name, payload, reason] of cases) {
    assert.equal(completeQuizItemPayloadReason(payload), reason, name);
  }
});
