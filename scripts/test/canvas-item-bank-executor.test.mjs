import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { executeItemBankInPage } from "../../connector/extension/src/item-bank-executor.js";

const catalog = JSON.parse(readFileSync(new URL("../../artifacts/canvas-api/canvas-api-catalog.json", import.meta.url), "utf8"));
const operations = new Map(catalog.operations.filter((operation) => operation.service === "item_bank").map((operation) => [operation.nickname, operation]));

function storage(values) {
  return { getItem: (key) => Object.prototype.hasOwnProperty.call(values, key) ? values[key] : null };
}

async function withPageContext(callback, overrides = {}) {
  const keys = ["location", "document", "sessionStorage", "localStorage", "fetch", "ENV"];
  const descriptors = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const token = `Signature ${"secret-credential-".repeat(8)}`;
  const values = {
    location: { hostname: "school.quiz-lti.instructure.com" },
    document: { referrer: "https://school.instructure.com/courses/42/external_tools/9" },
    sessionStorage: storage({
      current_user: JSON.stringify({ id: "7" }),
      "banks.build_token": token,
      item_banks_scope: JSON.stringify({ course_id: "42" }),
    }),
    localStorage: storage({}),
    ENV: {},
    ...overrides,
  };
  try {
    for (const [key, value] of Object.entries(values)) {
      Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    }
    return await callback(token);
  } finally {
    for (const key of keys) {
      const descriptor = descriptors.get(key);
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
}

function input(nickname, argumentsValue) {
  const operation = operations.get(nickname);
  assert.ok(operation, `missing Item Bank operation ${nickname}`);
  return {
    principalId: "7",
    canvasOrigin: "https://school.instructure.com",
    courseId: "42",
    operation,
    arguments: argumentsValue,
  };
}

test("all Item Bank operations use exact routes, methods, queries, and bodies", async () => {
  const cases = [
    ["list_banks", { course_id: "42", page: 2, per_page: 50 }, "GET", "/api/banks?course_id=42&page=2&per_page=50", undefined],
    ["get_bank", { bank_id: "91" }, "GET", "/api/banks/91", undefined],
    ["list_entries", { bank_id: "91", page: 3, per_page: 20 }, "GET", "/api/banks/91/bank_entries?page=3&per_page=20", undefined],
    ["get_entry", { bank_id: "91", bank_entry_id: "401" }, "GET", "/api/banks/91/bank_entries/401", undefined],
    ["list_shares", { bank_id: "91" }, "GET", "/api/banks/91/shared_banks", undefined],
    ["create_bank", { title: "Question bank" }, "POST", "/api/banks", { bank: { title: "Question bank", language: "en" } }],
    ["archive_bank", { bank_id: "91" }, "DELETE", "/api/banks/91", undefined],
    ["attach_item", { bank_id: "91", item_id: "501" }, "POST", "/api/banks/91/bank_entries", { bank_entry: { bank_id: "91", entry_type: "Item", entry_id: "501" } }],
    ["create_item", { bank_id: "91", item: { title: "Reusable question", interaction_type_slug: "essay" } }, "POST", "/api/banks/91/items", { title: "Reusable question", interaction_type_slug: "essay" }],
    ["update_item", { bank_id: "91", item_id: "501", item: { title: "Revised question" } }, "PATCH", "/api/banks/91/items/501", { title: "Revised question" }],
    ["delete_entry", { bank_id: "91", bank_entry_id: "401" }, "DELETE", "/api/banks/91/bank_entries/401", undefined],
    ["share_bank", { bank_id: "91", entity_type: "Course", entity_id: "42" }, "POST", "/api/banks/91/shared_banks", { shared_bank: { entity_id: "42", entityType: "Course", bank_id: "91", permission: "read" } }],
  ];
  assert.equal(cases.length, 12);
  assert.equal(operations.size, 12);

  await withPageContext(async (token) => {
    for (const [nickname, argumentsValue, method, path, body] of cases) {
      let request;
      globalThis.fetch = async (url, options) => {
        request = { url, options };
        return new Response(JSON.stringify({ id: "11", title: "Question bank", token, credential: "must not escape" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      };
      const result = await executeItemBankInPage(input(nickname, argumentsValue));
      assert.equal(result.matched, true, nickname);
      assert.equal(result.ok, true, nickname);
      assert.equal(request.url, `https://school.quiz-api.instructure.com${path}`, nickname);
      assert.equal(request.options.method, method, nickname);
      assert.equal(request.options.headers.Authorization, token, nickname);
      assert.equal(request.options.headers.AuthType, "Signature", nickname);
      assert.equal(request.options.credentials, "omit", nickname);
      assert.deepEqual(request.options.body === undefined ? undefined : JSON.parse(request.options.body), body, nickname);
      assert.equal(JSON.stringify(result).includes(token), false, nickname);
      assert.equal(JSON.stringify(result).includes("must not escape"), false, nickname);
    }
  });
});

test("Item Bank execution rejects wrong tenant, principal, course, token, and path before fetch", async () => {
  const cases = [
    { label: "tenant", overrides: { location: { hostname: "other.quiz-lti.instructure.com" }, document: { referrer: "https://other.instructure.com/courses/42/external_tools/9" } }, mutate: (value) => value },
    { label: "referrer", overrides: { document: { referrer: "https://evil.example/courses/42/external_tools/9" } }, mutate: (value) => value },
    { label: "principal", overrides: {}, mutate: (value) => ({ ...value, principalId: "8" }) },
    { label: "course", overrides: {}, mutate: (value) => ({ ...value, courseId: "43" }) },
    { label: "token", overrides: { sessionStorage: storage({ current_user: JSON.stringify({ id: "7" }), item_banks_scope: JSON.stringify({ course_id: "42" }) }) }, mutate: (value) => value },
    { label: "path", overrides: {}, mutate: (value) => ({ ...value, operation: { ...value.operation, path: "/api/other" } }) },
  ];
  for (const entry of cases) {
    let calls = 0;
    await withPageContext(async () => {
      globalThis.fetch = async () => { calls += 1; return new Response("{}"); };
      const result = await executeItemBankInPage(entry.mutate(input("list_banks", {})));
      assert.notEqual(result.ok, true, entry.label);
    }, entry.overrides);
    assert.equal(calls, 0, entry.label);
  }
});

test("Item Bank transport loss marks writes unknown and reads safe to repeat", async () => {
  await withPageContext(async () => {
    globalThis.fetch = async () => { throw new TypeError("network disconnected"); };
    const write = await executeItemBankInPage(input("create_bank", { title: "Question bank" }));
    assert.deepEqual(write, { matched: true, ok: false, sent: true, outcomeUnknown: true, error: "item_bank_request_failed" });
    const read = await executeItemBankInPage(input("list_banks", {}));
    assert.deepEqual(read, { matched: true, ok: false, sent: false, outcomeUnknown: false, error: "item_bank_request_failed" });
  });
});
