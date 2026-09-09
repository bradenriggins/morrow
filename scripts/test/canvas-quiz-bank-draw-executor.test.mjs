import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { executeQuizBankDrawInPage } from "../../connector/extension/src/quiz-bank-draw-executor.js";

const catalog = JSON.parse(readFileSync(new URL("../../artifacts/canvas-api/canvas-api-catalog.json", import.meta.url), "utf8"));
const operations = new Map(catalog.operations.filter((operation) => operation.service === "item_bank").map((operation) => [operation.nickname, operation]));
const TOKEN = `Signature ${"builder-secret-".repeat(8)}`;
const storage = (values) => ({ getItem: (key) => Object.hasOwn(values, key) ? values[key] : null });
const stable = (value) => Array.isArray(value) ? `[${value.map(stable).join(",")}]` : value && typeof value === "object" ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}` : JSON.stringify(value === undefined ? null : value);
const digest = async (value) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stable(value)))), (byte) => byte.toString(16).padStart(2, "0")).join("");

async function observed(bankId = "91") {
  return {
    fan_out: {
      schema: "morrow.canvas.item-bank.fan-out.v1", bank_id: bankId, course_id: "42",
      established_at: new Date().toISOString(), sources: [], unreachable: ["quiz_uses", "shared_banks"], complete: false,
      consumers: [], consumer_count: 0, external_course_ids: [], consumers_sha256: await digest([]),
    },
    fan_out_receipt: "a".repeat(64), acknowledged_course_ids: [],
  };
}

async function withBuilder(callback, fetch) {
  const keys = ["location", "document", "localStorage", "sessionStorage", "performance", "fetch"];
  const descriptors = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const values = {
    location: { hostname: "school.quiz-lti.instructure.com" },
    document: { referrer: "https://school.instructure.com/courses/42/assignments/188?display=borderless" },
    localStorage: storage({ backend_url: "https://school.quiz-lti.instructure.com", "quiz.build_token": TOKEN }),
    sessionStorage: storage({}),
    performance: { getEntriesByType: () => [{ name: "https://school.quiz-api.instructure.com/api/quizzes/77" }] },
    fetch,
  };
  try {
    for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    return await callback();
  } finally {
    for (const key of keys) {
      const descriptor = descriptors.get(key);
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  }
}

function input(nickname, args, extra = {}) {
  const operation = operations.get(nickname);
  assert.ok(operation, nickname);
  return {
    operation,
    arguments: args,
    canvasOrigin: "https://school.instructure.com",
    courseId: "42",
    assignmentId: "188",
    ...extra,
  };
}

function provider() {
  const entries = [{ id: "10", entry_type: "Item", entry_id: "501", position: 1, points_possible: 1, properties: {} }];
  const requests = [];
  const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  const fetch = async (url, options = {}) => {
    const parsed = new URL(url);
    const method = options.method || "GET";
    requests.push({ method, path: parsed.pathname, body: options.body ? JSON.parse(options.body) : undefined, options });
    if (parsed.pathname === "/api/quizzes/77" && method === "GET") return json({ id: "77", title: "Quiz" });
    if (parsed.pathname === "/api/quizzes/77/quiz_entries" && method === "GET") {
      const page = Number(parsed.searchParams.get("page"));
      return json({ quiz_entries: page === 1 ? entries : [] });
    }
    if (parsed.pathname === "/api/quizzes/77/quiz_entries" && method === "POST") {
      const row = { id: "11", ...JSON.parse(options.body).quiz_entry };
      entries.push(row);
      return json({ quiz_entry: row }, 201);
    }
    const entry = parsed.pathname.match(/^\/api\/quizzes\/77\/quiz_entries\/([1-9][0-9]*)$/);
    if (entry && method === "DELETE") {
      const index = entries.findIndex((row) => String(row.id) === entry[1]);
      if (index >= 0) entries.splice(index, 1);
      return new Response(null, { status: 204 });
    }
    return json({ error: "missing" }, 404);
  };
  return { entries, requests, fetch };
}

test("the builder read binds one assignment and returns the complete entry snapshot", async () => {
  const p = provider();
  await withBuilder(async () => {
    const result = await executeQuizBankDrawInPage(input("list_quiz_draws", { course_id: "42", assignment_id: "188" }));
    assert.equal(result.ok, true);
    assert.equal(result.quizId, "77");
    assert.deepEqual(result.data, p.entries);
    assert.match(result.snapshotSha256, /^[0-9a-f]{64}$/);
    assert.equal(result.paginationComplete, true);
    assert.equal(result.pagesRead, 2);
    assert.deepEqual(p.requests.filter((request) => request.method === "GET").map((request) => request.path), [
      "/api/quizzes/77",
      "/api/quizzes/77/quiz_entries",
      "/api/quizzes/77/quiz_entries",
    ]);
    assert.equal(JSON.stringify(result).includes(TOKEN), false);
  }, p.fetch);
});

test("the builder read combines pages and requires an empty end page", async () => {
  const p = provider();
  const pageTwo = [{ id: "20", entry_type: "Item", entry_id: "502", position: 2, points_possible: 1, properties: {} }];
  const fetch = async (url, options = {}) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/api/quizzes/77/quiz_entries" && (options.method || "GET") === "GET") {
      const page = Number(parsed.searchParams.get("page"));
      if (page === 1) return new Response(JSON.stringify({ quiz_entries: p.entries }));
      if (page === 2) return new Response(JSON.stringify({ quiz_entries: pageTwo }));
      return new Response(JSON.stringify({ quiz_entries: [] }));
    }
    return p.fetch(url, options);
  };
  await withBuilder(async () => {
    const result = await executeQuizBankDrawInPage(input("list_quiz_draws", { course_id: "42", assignment_id: "188" }));
    assert.equal(result.ok, true);
    assert.deepEqual(result.data, [...p.entries, ...pageTwo]);
    assert.equal(result.paginationComplete, true);
    assert.equal(result.pagesRead, 3);
  }, fetch);
});

test("an entry list beyond the bound fails closed", async () => {
  const p = provider();
  const overLimit = Array.from({ length: 10_001 }, (_, index) => ({ id: String(index + 1) }));
  const fetch = async (url, options = {}) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/api/quizzes/77/quiz_entries" && (options.method || "GET") === "GET") {
      return new Response(JSON.stringify({ quiz_entries: overLimit }));
    }
    return p.fetch(url, options);
  };
  await withBuilder(async () => {
    const result = await executeQuizBankDrawInPage(input("list_quiz_draws", { course_id: "42", assignment_id: "188" }));
    assert.deepEqual(result, { matched: true, ok: false, sent: false, error: "quiz_bank_entries_unreadable" });
    assert.equal(p.requests.some((request) => request.method === "POST"), false);
  }, fetch);
});

test("both builder create shapes use exact snapshots, one dispatch, and complete-list readback", async () => {
  for (const nickname of ["attach_bank_to_quiz", "attach_bank_entry_to_quiz"]) {
    const p = provider();
    await withBuilder(async () => {
      const bankSha256 = "a".repeat(64);
      const entrySha256 = "b".repeat(64);
      const args = nickname === "attach_bank_to_quiz"
        ? { course_id: "42", assignment_id: "188", bank_id: "91", pick_count: 5, points_per_item: 2, position: 2,
          expected_snapshot: { bank_sha256: bankSha256, quiz_entries_sha256: await digest(p.entries) }, ...await observed() }
        : { course_id: "42", assignment_id: "188", bank_id: "91", bank_entry_id: "401", points_per_item: 2, position: 2,
          expected_snapshot: { bank_sha256: bankSha256, entry_sha256: entrySha256, quiz_entries_sha256: await digest(p.entries) }, ...await observed() };
      const result = await executeQuizBankDrawInPage(input(nickname, args, {
        verifiedBankSha256: bankSha256,
        ...(nickname === "attach_bank_entry_to_quiz" ? { verifiedEntrySha256: entrySha256 } : {}),
      }));
      assert.equal(result.ok, true, `${nickname}: ${JSON.stringify(result)}`);
      assert.equal(result.sent, true);
      assert.equal(result.outcomeUnknown, false);
      assert.equal(result.verification.status, "verified");
      assert.equal(p.requests.filter((request) => request.method === "POST").length, 1);
    }, p.fetch);
  }
});

test("the exact builder delete uses one dispatch and verifies absence from a complete list", async () => {
  const p = provider();
  p.entries.push({ id: "11", entry_type: "Bank", entry_id: "91", position: 2, points_possible: 2, properties: { sample_num: 5 } });
  await withBuilder(async () => {
    const bankSha256 = "a".repeat(64);
    const result = await executeQuizBankDrawInPage(input("delete_quiz_bank_entry", {
      course_id: "42", assignment_id: "188", bank_id: "91", quiz_entry_id: "11",
      expected_snapshot: {
        bank_sha256: bankSha256,
        quiz_entries_sha256: await digest(p.entries),
        quiz_entry_sha256: await digest(p.entries[1]),
      },
      ...await observed(),
    }, { verifiedBankSha256: bankSha256 }));
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.sent, true);
    assert.equal(result.outcomeUnknown, false);
    assert.equal(result.verification.status, "verified");
    assert.equal(result.verification.evidence, "exact_quiz_bank_entry_absent_from_complete_entry_list");
    assert.equal(p.requests.filter((request) => request.method === "DELETE").length, 1);
    assert.equal(p.entries.some((row) => row.id === "11"), false);
  }, p.fetch);
});

test("a sent builder write is not successful when exact readback does not confirm it", async () => {
  const p = provider();
  const fetch = async (url, options = {}) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/api/quizzes/77/quiz_entries" && options.method === "POST") {
      p.requests.push({ method: "POST", path: parsed.pathname });
      return new Response(JSON.stringify({ error: "temporary" }), { status: 500 });
    }
    return p.fetch(url, options);
  };
  await withBuilder(async () => {
    const bankSha256 = "a".repeat(64);
    const result = await executeQuizBankDrawInPage(input("attach_bank_to_quiz", {
      course_id: "42", assignment_id: "188", bank_id: "91", pick_count: 5, points_per_item: 2, position: 2,
      expected_snapshot: { bank_sha256: bankSha256, quiz_entries_sha256: await digest(p.entries) },
      ...await observed(),
    }, { verifiedBankSha256: bankSha256 }));
    assert.equal(result.ok, false);
    assert.equal(result.sent, true);
    assert.equal(result.outcomeUnknown, true);
    assert.equal(result.verification.status, "unconfirmed");
  }, fetch);
});

test("wrong frame, assignment, quiz ambiguity, or payload fails closed", async () => {
  const p = provider();
  await withBuilder(async () => {
    const result = await executeQuizBankDrawInPage(input("list_quiz_draws", { course_id: "42", assignment_id: "189" }));
    assert.deepEqual(result, { matched: true, ok: false, sent: false, error: "quiz_bank_course_assignment_mismatch" });
    assert.equal(p.requests.length, 0);
  }, p.fetch);
});

// ItemProperties.sample_num is "the number of items to randomly select from the bank. null if all
// items should be included", so an omitted pick count is the documented all-items draw.
// https://developerdocs.instructure.com/services/canvas/resources/new_quiz_items
test("an omitted pick count sends the documented all-items draw and verifies that exact saved value", async () => {
  const p = provider();
  await withBuilder(async () => {
    const bankSha256 = "a".repeat(64);
    const result = await executeQuizBankDrawInPage(input("attach_bank_to_quiz", {
      course_id: "42", assignment_id: "188", bank_id: "91", points_per_item: 2, position: 2,
      expected_snapshot: { bank_sha256: bankSha256, quiz_entries_sha256: await digest(p.entries) },
      ...await observed(),
    }, { verifiedBankSha256: bankSha256 }));
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.verification.status, "verified");
    assert.equal(result.verification.evidence, "new_exact_quiz_bank_entry_found_in_complete_entry_list");
    const post = p.requests.find((request) => request.method === "POST");
    assert.deepEqual(post.body, {
      quiz_entry: { entry_type: "Bank", entry_id: "91", position: 2, points_possible: 2, properties: { sample_num: null } },
    });
    assert.equal(p.requests.filter((request) => request.method === "POST").length, 1);
  }, p.fetch);
});

test("an all-items draw is not verified when Canvas saves a numbered sample instead", async () => {
  const p = provider();
  const fetch = async (url, options = {}) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/api/quizzes/77/quiz_entries" && options.method === "POST") {
      p.requests.push({ method: "POST", path: parsed.pathname });
      const row = { id: "11", entry_type: "Bank", entry_id: "91", position: 2, points_possible: 2, properties: { sample_num: 5 } };
      p.entries.push(row);
      return new Response(JSON.stringify({ quiz_entry: row }), { status: 201, headers: { "content-type": "application/json" } });
    }
    return p.fetch(url, options);
  };
  await withBuilder(async () => {
    const bankSha256 = "a".repeat(64);
    const result = await executeQuizBankDrawInPage(input("attach_bank_to_quiz", {
      course_id: "42", assignment_id: "188", bank_id: "91", points_per_item: 2, position: 2,
      expected_snapshot: { bank_sha256: bankSha256, quiz_entries_sha256: await digest(p.entries) },
      ...await observed(),
    }, { verifiedBankSha256: bankSha256 }));
    assert.equal(result.ok, false);
    assert.equal(result.sent, true);
    assert.equal(result.outcomeUnknown, true);
    assert.equal(result.verification.status, "mismatch");
    assert.equal(result.verification.reason, "quiz_bank_entry_not_found");
  }, fetch);
});

test("an all-items draw already present is recognised and nothing is sent again", async () => {
  const p = provider();
  p.entries.push({ id: "11", entry_type: "Bank", entry_id: "91", position: 2, points_possible: 2, properties: { sample_num: null } });
  await withBuilder(async () => {
    const bankSha256 = "a".repeat(64);
    const result = await executeQuizBankDrawInPage(input("attach_bank_to_quiz", {
      course_id: "42", assignment_id: "188", bank_id: "91", points_per_item: 2, position: 2,
      expected_snapshot: { bank_sha256: bankSha256, quiz_entries_sha256: await digest(p.entries) },
      ...await observed(),
    }, { verifiedBankSha256: bankSha256 }));
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.sent, false);
    assert.equal(result.verification.evidence, "exact_quiz_bank_entry_already_present");
    assert.equal(p.requests.filter((request) => request.method === "POST").length, 0);
  }, p.fetch);
});

test("a pick count that is not a positive whole number is refused before dispatch", async () => {
  const p = provider();
  await withBuilder(async () => {
    const bankSha256 = "a".repeat(64);
    for (const pick_count of [0, -1, 1.5, "many"]) {
      const result = await executeQuizBankDrawInPage(input("attach_bank_to_quiz", {
        course_id: "42", assignment_id: "188", bank_id: "91", pick_count, points_per_item: 2, position: 2,
        expected_snapshot: { bank_sha256: bankSha256, quiz_entries_sha256: await digest(p.entries) },
        ...await observed(),
      }, { verifiedBankSha256: bankSha256 }));
      assert.deepEqual(result, { matched: true, ok: false, sent: false, error: "quiz_bank_payload_invalid" }, String(pick_count));
    }
    assert.equal(p.requests.filter((request) => request.method === "POST").length, 0);
  }, p.fetch);
});
