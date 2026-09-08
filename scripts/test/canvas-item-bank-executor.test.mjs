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
    ["list_banks", { course_id: "42", page: 2, per_page: 50, morrow_max_pages: 1 }, "GET", "/api/banks?course_id=42&page=2&per_page=50", undefined],
    ["get_bank", { bank_id: "91" }, "GET", "/api/banks/91", undefined],
    ["list_entries", { bank_id: "91", page: 3, per_page: 20, morrow_max_pages: 1 }, "GET", "/api/banks/91/bank_entries?page=3&per_page=20", undefined],
    ["get_entry", { bank_id: "91", bank_entry_id: "401" }, "GET", "/api/banks/91/bank_entries/401", undefined],
    ["list_shares", { bank_id: "91", page: 2, per_page: 50 }, "GET", "/api/banks/91/shared_banks?page=2&per_page=50", undefined],
    ["create_bank", { title: "Question bank" }, "POST", "/api/banks", { bank: { title: "Question bank", language: "en" } }],
    ["archive_bank", { bank_id: "91" }, "DELETE", "/api/banks/91", undefined],
    ["attach_item", { bank_id: "91", item_id: "501" }, "POST", "/api/banks/91/bank_entries", { bank_entry: { bank_id: "91", entry_type: "Item", entry_id: "501" } }],
    ["create_item", { bank_id: "91", item: { title: "Reusable question", interaction_type_slug: "essay" } }, "POST", "/api/banks/91/items", { item: { title: "Reusable question", interaction_type_slug: "essay" } }],
    ["get_item", { bank_id: "91", item_id: "501" }, "GET", "/api/banks/91/items/501", undefined],
    ["update_item", { bank_id: "91", item_id: "501", item: { title: "Revised question" } }, "PATCH", "/api/banks/91/items/501", { item: { title: "Revised question" } }],
    ["delete_entry", { bank_id: "91", bank_entry_id: "401" }, "DELETE", "/api/banks/91/bank_entries/401", undefined],
    ["share_bank", { bank_id: "91", entity_type: "course", entity_id: "42" }, "POST", "/api/banks/91/shared_banks", { shared_bank: { entity_id: "42", entityType: "course", bank_id: "91", permission: "read" } }],
  ];
  assert.equal(cases.length, 13);
  assert.equal(operations.size, 13);

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
    let calls = 0;
    globalThis.fetch = async () => { calls += 1; return new Response("{}"); };
    const probe = await executeItemBankInPage({ ...input("create_bank", { title: "Question bank" }), contextOnly: true });
    assert.deepEqual(probe, { matched: true, ok: true, sent: false });
    assert.equal(calls, 0);
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

test("Item Bank writes stay uncertain on 408, 429, and 5xx while reads never claim uncertainty", async () => {
  const cases = [
    [400, false], [403, false], [404, false], [408, true], [409, false], [429, true], [500, true], [502, true], [503, true],
  ];
  await withPageContext(async () => {
    for (const [status, outcomeUnknown] of cases) {
      let calls = 0;
      globalThis.fetch = async () => {
        calls += 1;
        return new Response(JSON.stringify({ errors: [{ message: "Item Bank refused" }] }), { status, headers: { "content-type": "application/json" } });
      };
      const write = await executeItemBankInPage(input("update_item", { bank_id: "91", item_id: "501", item: { title: "Revised question" } }));
      assert.deepEqual(
        { ok: write.ok, sent: write.sent, status: write.status, outcomeUnknown: write.outcomeUnknown },
        { ok: false, sent: true, status, outcomeUnknown },
        `write ${status}`,
      );
      assert.equal(calls, 1, `write ${status}`);

      calls = 0;
      const read = await executeItemBankInPage(input("list_entries", { bank_id: "91" }));
      assert.deepEqual(
        { ok: read.ok, sent: read.sent, status: read.status, outcomeUnknown: read.outcomeUnknown },
        { ok: false, sent: true, status, outcomeUnknown: false },
        `read ${status}`,
      );
      assert.equal(calls, 1, `read ${status}`);
    }
  });
});

test("An oversize Item Bank response classifies the write by the same status rule", async () => {
  await withPageContext(async () => {
    const oversize = JSON.stringify({ note: "a".repeat(2 * 1024 * 1024) });
    for (const [status, outcomeUnknown] of [[200, true], [400, false], [503, true]]) {
      globalThis.fetch = async () => new Response(oversize, { status, headers: { "content-type": "application/json" } });
      const write = await executeItemBankInPage(input("update_item", { bank_id: "91", item_id: "501", item: { title: "Revised question" } }));
      assert.deepEqual(write, { matched: true, ok: false, sent: true, status, outcomeUnknown, error: "item_bank_response_too_large" }, `write ${status}`);
      const read = await executeItemBankInPage(input("get_entry", { bank_id: "91", bank_entry_id: "401" }));
      assert.deepEqual(read, { matched: true, ok: false, sent: true, status, outcomeUnknown: false, error: "item_bank_response_too_large" }, `read ${status}`);
    }
  });
});

test("Item Bank sharing refuses every scope except an exact course before any request", async () => {
  await withPageContext(async () => {
    for (const entityType of ["account", "Course", "COURSE", "user"]) {
      let calls = 0;
      globalThis.fetch = async () => { calls += 1; return new Response("{}"); };
      const result = await executeItemBankInPage(input("share_bank", { bank_id: "91", entity_type: entityType, entity_id: "42" }));
      assert.deepEqual(result, { matched: true, ok: false, sent: false, error: "item_bank_share_scope_unsupported" }, entityType);
      assert.equal(calls, 0, entityType);
    }
  });
});

test("Item Bank list reads stay course-bound and report bounded pagination", async () => {
  await withPageContext(async () => {
    let calls = 0;
    globalThis.fetch = async (url) => {
      calls += 1;
      const page = new URL(url).searchParams.get("page");
      return new Response(JSON.stringify([{ id: page }]), { status: 200, headers: { "content-type": "application/json" } });
    };
    const mismatched = await executeItemBankInPage(input("list_banks", { course_id: "43" }));
    assert.deepEqual(mismatched, { matched: true, ok: false, sent: false, error: "item_bank_course_mismatch" });
    assert.equal(calls, 0);

    const result = await executeItemBankInPage(input("list_banks", { course_id: "42", morrow_max_pages: 2 }));
    assert.equal(calls, 2);
    assert.equal(result.pageCount, 2);
    assert.equal(result.truncated, true);
    assert.deepEqual(result.data, [{ id: "1" }, { id: "2" }]);
  });
});

test("Item Bank share reads page through every bounded affected-course result", async () => {
  await withPageContext(async () => {
    const requestedPages = [];
    globalThis.fetch = async (url) => {
      const page = new URL(url).searchParams.get("page");
      requestedPages.push(page);
      return new Response(JSON.stringify([{ id: `share-${page}`, entity_id: page }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const result = await executeItemBankInPage(input("list_shares", {
      bank_id: "91",
      page: 3,
      per_page: 50,
      morrow_max_pages: 2,
    }));

    assert.deepEqual(requestedPages, ["3", "4"]);
    assert.equal(result.pageCount, 2);
    assert.equal(result.truncated, true);
    assert.deepEqual(result.data, [
      { id: "share-3", entity_id: "3" },
      { id: "share-4", entity_id: "4" },
    ]);
  });
});

test("Item Bank lists flag sanitized and unknown collection data as incomplete", async () => {
  await withPageContext(async () => {
    globalThis.fetch = async (url) => {
      const page = new URL(url).searchParams.get("page");
      const data = page === "1" ? Array.from({ length: 10_001 }, () => ({})) : [];
      return new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
    };
    const sanitized = await executeItemBankInPage(input("list_banks", { course_id: "42", morrow_max_pages: 2 }));
    assert.equal(sanitized.truncated, true);
    assert.equal(sanitized.data.length, 10_000);

    globalThis.fetch = async () => new Response(JSON.stringify({ entries: [] }), { status: 200, headers: { "content-type": "application/json" } });
    const wrapped = await executeItemBankInPage(input("list_entries", { bank_id: "91", morrow_max_pages: 2 }));
    assert.equal(wrapped.truncated, true);
  });
});
