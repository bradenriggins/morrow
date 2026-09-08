import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { executeItemBankInPage } from "../../connector/extension/src/item-bank-executor.js";
import { establishFanOut, fanOutDigest, validFanOut } from "../../connector/extension/src/item-bank-fan-out.js";
import {
  applyItemBankImageAlt,
  escapeItemBankAlt,
  itemBankContentImages,
  itemBankEntryLinksItem,
  itemBankImageAttributes,
  itemBankInteractionIds,
  itemBankItemDigest,
  itemBankProtectedState,
  itemBankProtectedStateDigest,
  sameItemBankInteractionIds,
  validItemBankGuard,
} from "../../connector/extension/src/item-bank-guard.js";

const catalog = JSON.parse(readFileSync(new URL("../../artifacts/canvas-api/canvas-api-catalog.json", import.meta.url), "utf8"));
const UPDATE_ITEM = catalog.operations.find((operation) => operation.service === "item_bank" && operation.nickname === "update_item");
assert.ok(UPDATE_ITEM, "missing Item Bank operation update_item");

const COURSE = "42";
const BANK = "91";
const ENTRY_ID = "401";
const ITEM_ID = "501";
const ITEM_PATH = `/api/banks/${BANK}/items/${ITEM_ID}`;
const ENTRY_PATH = `/api/banks/${BANK}/bank_entries/${ENTRY_ID}`;
const ALT = "A microscope slide of cells in metaphase, with chromosomes lined up at the centre";
// The exact src text as it is written in the stored body. The guard digests
// that text, not an entity-decoded form, so a Canvas file URL keeps its &amp;.
const TARGET_SRC = "/courses/42/files/77/preview?wrap=1&amp;verifier=abc";
const SECOND_SRC = "/courses/42/files/78/preview";
const BODY = [
  "<p>Which slide shows metaphase?</p>",
  `<p><img src="${TARGET_SRC}"></p>`,
  `<p><img src="${SECOND_SRC}" alt="A labelled diagram of anaphase"></p>`,
].join("\n");

const sha256 = (value) => createHash("sha256").update(value, "utf8").digest("hex");

const ITEM = Object.freeze({
  id: ITEM_ID,
  entry_type: "Item",
  position: 3,
  status: "active",
  updated_at: "2026-09-01T10:00:00Z",
  entry: {
    title: "Mitosis stages",
    item_body: BODY,
    interaction_type_slug: "choice",
    interaction_data: { choices: [{ id: "c1", item_body: "Metaphase" }, { id: "c2", item_body: "Anaphase" }] },
    scoring_data: { value: "c1" },
    points_possible: 1,
    updated_at: "2026-09-01T10:00:00Z",
  },
});
const ENTRY = Object.freeze({ id: ENTRY_ID, entry_type: "Item", entry_id: ITEM_ID, position: 1 });

const CONSUMERS = Object.freeze([
  { course_id: COURSE, entity_type: "bank_entry", entity_id: ENTRY_ID },
  { course_id: "77", entity_type: "course", entity_id: "77" },
  { course_id: "9", entity_type: "quiz", entity_id: "5150" },
]);
const EXTERNAL = Object.freeze(["9", "77"]);
const SOURCES = Object.freeze([
  { name: "bank_entries", pages: 1, exhausted: true },
  { name: "shared_banks", pages: 1, exhausted: true },
  { name: "quiz_uses", pages: 1, exhausted: true },
]);

const clone = (value) => structuredClone(value);

async function fanOut(overrides = {}) {
  return await establishFanOut({
    bankId: BANK, courseId: COURSE, sources: SOURCES, consumers: CONSUMERS, unreachable: [], observedAt: Date.now() - 60_000, ...overrides,
  });
}

async function guardFor(item, overrides = {}) {
  return {
    kind: "item_bank_entry_image_alt",
    course_id: COURSE,
    bank_id: BANK,
    bank_entry_id: ENTRY_ID,
    item_id: ITEM_ID,
    entry_type: "Item",
    item_sha256: await itemBankItemDigest(item),
    protected_state_sha256: await itemBankProtectedStateDigest(item),
    image_index: 1,
    image_src_sha256: sha256(TARGET_SRC),
    alt_text: ALT,
    fan_out: await fanOut(),
    acknowledged_course_ids: [...EXTERNAL],
    ...overrides,
  };
}

/** The body every accepted repair must send: the stored body with one alt added. */
async function repairedBody(item = ITEM) {
  const applied = await applyItemBankImageAlt(item.entry.item_body, { image_index: 1, image_src_sha256: sha256(TARGET_SRC), alt_text: ALT });
  assert.equal(applied.error, undefined);
  return applied.body;
}

async function savedItem(item = ITEM) {
  const saved = clone(item);
  saved.entry.item_body = await repairedBody(item);
  // The provider owns these stamps. The protected state drops them, so they
  // must not make a matching readback look like a changed question.
  saved.updated_at = "2026-09-06T18:04:11Z";
  saved.entry.updated_at = "2026-09-06T18:04:11Z";
  return saved;
}

function storage(values) {
  return { getItem: (key) => Object.prototype.hasOwnProperty.call(values, key) ? values[key] : null };
}

async function withPageContext(callback) {
  const keys = ["location", "document", "sessionStorage", "localStorage", "fetch", "ENV"];
  const descriptors = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const token = `Signature ${"item-bank-credential-".repeat(4)}`;
  const values = {
    location: { hostname: "school.quiz-lti.instructure.com" },
    document: { referrer: `https://school.instructure.com/courses/${COURSE}/external_tools/9` },
    sessionStorage: storage({
      current_user: JSON.stringify({ id: "7" }),
      "banks.build_token": token,
      item_banks_scope: JSON.stringify({ course_id: COURSE }),
    }),
    localStorage: storage({}),
    ENV: {},
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

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

/**
 * One Item Banks API for one repair. Every request is recorded so each case can
 * prove how many were made, in what order, and that exactly one was a PATCH.
 */
function bank({ item = ITEM, entry = ENTRY, readback, readbackThrows = false, patchStatus = 200, entryStatus = 200 } = {}) {
  const calls = [];
  const requests = [];
  let itemReads = 0;
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(String(url));
    const method = options.method || "GET";
    calls.push(`${method} ${parsed.pathname}`);
    requests.push({ method, pathname: parsed.pathname, options });
    if (method === "GET" && parsed.pathname === ITEM_PATH) {
      itemReads += 1;
      if (itemReads === 1) return jsonResponse(item);
      if (readbackThrows) throw new TypeError("the Item Banks frame is gone");
      return jsonResponse(readback ?? await savedItem(item));
    }
    if (method === "GET" && parsed.pathname === ENTRY_PATH) return jsonResponse(entry, entryStatus);
    if (method === "PATCH" && parsed.pathname === ITEM_PATH) {
      return jsonResponse(patchStatus === 200 ? await savedItem(item) : { errors: [{ message: "The Item Banks API did not accept this change." }] }, patchStatus);
    }
    throw new Error(`unexpected request ${method} ${parsed.pathname}`);
  };
  return { calls, requests, fetchImpl };
}

async function repair({ guard: guardOverrides = {}, server = {}, args, guardItem } = {}) {
  const item = guardItem ?? server.item ?? ITEM;
  const guard = await guardFor(item, guardOverrides);
  const api = bank(server);
  const result = await withPageContext(async (token) => {
    globalThis.fetch = api.fetchImpl;
    const value = await executeItemBankInPage({
      principalId: "7",
      canvasOrigin: "https://school.instructure.com",
      courseId: COURSE,
      operation: UPDATE_ITEM,
      arguments: args ?? { bank_id: BANK, item_id: ITEM_ID, morrow_item_bank_guard: guard },
    });
    const encoded = JSON.stringify(value ?? null);
    assert.equal(encoded.includes(token), false, "the result carried the credential");
    assert.equal(encoded.includes("morrow_item_bank_guard"), false, "the result carried the guard");
    assert.equal(encoded.includes("acknowledged_course_ids"), false, "the result carried the acknowledgement");
    assert.equal(encoded.includes("consumers_sha256"), false, "the result carried the fan-out record");
    return value;
  });
  const patches = api.calls.filter((call) => call.startsWith("PATCH")).length;
  assert.ok(patches <= 1, `sent ${patches} PATCH requests`);
  return { result, calls: api.calls, requests: api.requests, guard, patches };
}

test("one guarded repair reads the question, sends one PATCH, and reads it again", async () => {
  const { result, calls, requests, patches } = await repair();
  assert.deepEqual(calls, [`GET ${ITEM_PATH}`, `GET ${ENTRY_PATH}`, `PATCH ${ITEM_PATH}`, `GET ${ITEM_PATH}`]);
  assert.equal(patches, 1);
  const patch = requests.find((request) => request.method === "PATCH");
  const expected = clone(ITEM);
  expected.entry.item_body = await repairedBody();
  assert.deepEqual(JSON.parse(patch.options.body), { item: expected });
  assert.equal(patch.options.credentials, "omit");
  assert.equal(patch.options.headers["Content-Type"], "application/json");
  assert.equal(patch.options.headers.AuthType, "Signature");
  assert.equal(requests[0].options.headers["Content-Type"], undefined, "a read must not claim a JSON body");
  assert.equal(result.ok, true);
  assert.equal(result.sent, true);
  assert.equal(result.outcomeUnknown, false);
  assert.deepEqual(result.verification, {
    schema: "morrow.browser-verification.v1",
    strategy: "item-bank-item-readback",
    status: "verified",
    evidence: "item_body_and_protected_state_reread_after_write",
  });
  // The provider echoes the whole saved question. An accepted repair answers
  // with the outcome, so neither the question nor the image source comes back.
  assert.equal(result.data, undefined);
  const encoded = JSON.stringify(result);
  assert.equal(encoded.includes(ALT), false);
  assert.equal(encoded.includes("/courses/42/files/77"), false);
});

test("the repaired body adds one alt attribute and changes nothing else", async () => {
  const repaired = await repairedBody();
  assert.equal(repaired, BODY.replace(`<img src="${TARGET_SRC}">`, `<img src="${TARGET_SRC}" alt="${escapeItemBankAlt(ALT)}">`));
  const before = itemBankContentImages(BODY);
  const after = itemBankContentImages(repaired);
  assert.equal(before.images.length, 2);
  assert.equal(after.images.length, 2);
  assert.equal(after.images[1].tag, before.images[1].tag);
  assert.equal(itemBankImageAttributes(after.images[0].tag).get("alt"), escapeItemBankAlt(ALT));
  assert.equal(itemBankImageAttributes(after.images[0].tag).get("src"), TARGET_SRC);
});

test("a question that changed since the repair was planned is never sent", async () => {
  const { result, calls } = await repair({ guard: { item_sha256: "b".repeat(64) } });
  assert.deepEqual(result, { matched: true, ok: false, sent: false, error: "item_bank_source_changed" });
  assert.deepEqual(calls, [`GET ${ITEM_PATH}`]);
});

test("an unreadable question read refuses before anything is sent", async () => {
  for (const item of ["not an item", null, ["an entry row"]]) {
    const { result, calls } = await repair({ guardItem: ITEM, server: { item } });
    assert.deepEqual(result, { matched: true, ok: false, sent: false, error: "item_bank_source_unavailable" }, JSON.stringify(item));
    assert.deepEqual(calls, [`GET ${ITEM_PATH}`], JSON.stringify(item));
  }
});

test("an incomplete fan-out refuses the repair before any request", async () => {
  const INCOMPLETE = "incomplete_unread_source_is_not_an_empty_fan_out";
  const cases = [
    // Nobody enumerated the quizzes, so nothing is known about the courses that
    // draw from this bank. That is not the same answer as "no course does".
    [INCOMPLETE, await fanOut({ sources: SOURCES.filter((row) => row.name !== "quiz_uses") })],
    [INCOMPLETE, await fanOut({ sources: SOURCES.map((row) => row.name === "shared_banks" ? { ...row, exhausted: false } : row) })],
    [INCOMPLETE, await fanOut({ unreachable: ["shared_banks"] })],
    ["bank_mismatch", await fanOut({ bankId: "92" })],
    ["record_too_old", await fanOut({ observedAt: Date.now() - (61 * 60 * 1_000) })],
  ];
  for (const [reason, record] of cases) {
    const { result, calls } = await repair({ guard: { fan_out: record } });
    assert.deepEqual(result, { matched: true, ok: false, sent: false, error: `item_bank_fan_out_${reason}` }, reason);
    assert.deepEqual(calls, [], reason);
  }
});

test("a fan-out whose consumers changed after the digest refuses the repair", async () => {
  const record = await fanOut();
  const tampered = { ...record, consumers: record.consumers.map((consumer) => consumer.course_id === "77" ? { ...consumer, course_id: "78" } : consumer) };
  const { result, calls } = await repair({ guard: { fan_out: tampered } });
  assert.deepEqual(result, { matched: true, ok: false, sent: false, error: "item_bank_fan_out_consumers_digest_mismatch" });
  assert.deepEqual(calls, []);
});

test("an acknowledgement that misses one course the bank reaches refuses the repair", async () => {
  for (const acknowledged of [["9"], [], ["9", "77", "88"]]) {
    const { result, calls } = await repair({ guard: { acknowledged_course_ids: acknowledged } });
    assert.deepEqual(result, { matched: true, ok: false, sent: false, error: "item_bank_fan_out_acknowledgement_mismatch" }, JSON.stringify(acknowledged));
    assert.deepEqual(calls, [], JSON.stringify(acknowledged));
  }
});

test("the in-frame fan-out rule answers exactly as item-bank-fan-out.js does", async () => {
  const record = await fanOut();
  const cases = [
    ["accepted", record, EXTERNAL],
    ["wrong_schema", { ...record, schema: "canvas.item-bank.fan-out.v1" }, EXTERNAL],
    ["course_mismatch", { ...record, course_id: "43" }, EXTERNAL],
    ["consumer_count_mismatch", { ...record, consumer_count: 2 }, EXTERNAL],
    ["external_course_ids_mismatch", { ...record, external_course_ids: ["9"] }, EXTERNAL],
    ["acknowledgement_mismatch", record, ["77"]],
    ["established_at_unreadable", { ...record, established_at: "2026-09-06 18:00:00" }, EXTERNAL],
    ["record_from_future", { ...record, established_at: new Date(Date.now() + 60_000).toISOString() }, EXTERNAL],
  ];
  for (const [label, fanOutRecord, acknowledged] of cases) {
    const reason = await validFanOut(fanOutRecord, { bankId: BANK, courseId: COURSE, acknowledgedCourseIds: acknowledged, now: Date.now() });
    assert.equal(reason, label === "accepted" ? null : label, `module ${label}`);
    const { result } = await repair({ guard: { fan_out: fanOutRecord, acknowledged_course_ids: acknowledged } });
    if (reason === null) assert.equal(result.ok, true, label);
    else assert.equal(result.error, `item_bank_fan_out_${reason}`, `frame ${label}`);
  }
});

test("an entry that does not resolve to this exact question refuses the repair", async () => {
  const cases = [
    ["a list row for another item", { id: ENTRY_ID, entry_type: "Item", entry_id: "999" }],
    ["a stimulus entry", { id: ENTRY_ID, entry_type: "Stimulus", entry_id: ITEM_ID }],
    ["an entry with no link at all", { id: ENTRY_ID, entry_type: "Item" }],
  ];
  for (const [label, entry] of cases) {
    const { result, calls } = await repair({ server: { entry } });
    assert.deepEqual(result, { matched: true, ok: false, sent: false, error: "item_bank_entry_unresolved" }, label);
    assert.deepEqual(calls, [`GET ${ITEM_PATH}`, `GET ${ENTRY_PATH}`], label);
  }
  const { result } = await repair({ server: { entryStatus: 404 } });
  assert.equal(result.error, "item_bank_entry_unresolved");
});

test("an entry that embeds its item resolves through every harvested shape", () => {
  assert.equal(itemBankEntryLinksItem(ENTRY, ITEM_ID), true);
  for (const shape of [
    { entry_type: "Item", item: { id: ITEM_ID } },
    { entry_type: "Item", entry: { id: ITEM_ID } },
    { entry_type: "Item", current_version: { id: ITEM_ID } },
    { entry_type: "Item", data: { item: { id: ITEM_ID } } },
    { entry_type: "Item", item: { data: { id: ITEM_ID } } },
  ]) {
    assert.equal(itemBankEntryLinksItem(shape, ITEM_ID), true, JSON.stringify(shape));
  }
  for (const shape of [null, "row", { entry_type: "Item", item: { id: "999" } }, { entry_type: "Stimulus", entry_id: ITEM_ID }]) {
    assert.equal(itemBankEntryLinksItem(shape, ITEM_ID), false, JSON.stringify(shape));
  }
});

test("an image that moved, already carries alt text, or cannot be named uniquely is refused", async () => {
  const shifted = await repair({ guard: { image_index: 2 } });
  assert.deepEqual(shifted.result, { matched: true, ok: false, sent: false, error: "item_bank_image_alt_target_changed" });
  assert.deepEqual(shifted.calls, [`GET ${ITEM_PATH}`, `GET ${ENTRY_PATH}`]);

  const missing = await repair({ guard: { image_index: 3 } });
  assert.equal(missing.result.error, "item_bank_image_alt_target_missing");

  const present = await repair({ guard: { image_index: 2, image_src_sha256: sha256(SECOND_SRC) } });
  assert.equal(present.result.error, "item_bank_image_alt_already_present");

  const twin = clone(ITEM);
  twin.entry.item_body = `<p><img src="${TARGET_SRC}"></p><p><img src="${TARGET_SRC}"></p>`;
  const ambiguous = await repair({ server: { item: twin } });
  assert.equal(ambiguous.result.error, "item_bank_image_alt_ambiguous");
  assert.deepEqual(ambiguous.calls, [`GET ${ITEM_PATH}`, `GET ${ENTRY_PATH}`]);
});

test("images the repair must not count are not counted", async () => {
  const guard = { image_index: 1, image_src_sha256: sha256(TARGET_SRC), alt_text: ALT };
  const inside = `<svg><image href="x"/><img src="/not/content"></svg><p><img src="${TARGET_SRC}"></p>`;
  const applied = await applyItemBankImageAlt(inside, guard);
  assert.equal(applied.error, undefined);
  assert.ok(applied.body.includes(`<img src="${TARGET_SRC}" alt="`));
  const commented = `<!-- <img src="/commented"> --><p><img src="${TARGET_SRC}"></p>`;
  assert.equal((await applyItemBankImageAlt(commented, guard)).error, undefined);
  const scripted = `<script>var markup = "<img src='/scripted'>";</script><p><img src="${TARGET_SRC}"></p>`;
  assert.equal((await applyItemBankImageAlt(scripted, guard)).error, undefined);
  // Markup this scan cannot finish reading, and an unquoted attribute value
  // whose trailing slash cannot be told from a self-closing tag.
  assert.equal((await applyItemBankImageAlt(`<svg><p><img src="${TARGET_SRC}">`, guard)).error, "item_bank_image_alt_markup_unreadable");
  assert.equal((await applyItemBankImageAlt(`<img src=${TARGET_SRC}/>`, guard)).error, "item_bank_image_alt_markup_unreadable");
  assert.equal((await applyItemBankImageAlt("", guard)).error, "item_bank_image_alt_body_unusable");
});

test("interaction element ids are read exactly, and a question whose ids cannot be read is refused", async () => {
  assert.deepEqual(itemBankInteractionIds(ITEM), ["choices:c1", "choices:c2"]);
  const reordered = clone(ITEM);
  reordered.entry.interaction_data.choices.reverse();
  assert.equal(sameItemBankInteractionIds(itemBankInteractionIds(ITEM), itemBankInteractionIds(reordered)), true);
  const regenerated = clone(ITEM);
  regenerated.entry.interaction_data.choices[0].id = "c9";
  assert.equal(sameItemBankInteractionIds(itemBankInteractionIds(ITEM), itemBankInteractionIds(regenerated)), false);
  for (const groups of [{ questions: [{ id: "q-1" }] }, { blanks: [{ id: "b1" }] }, { entries: [{ id: "e1" }] }]) {
    const item = clone(ITEM);
    item.entry.interaction_data = groups;
    assert.equal(itemBankInteractionIds(item).length, 1);
  }
  const unreadable = clone(ITEM);
  unreadable.entry.interaction_data = { choices: [{ item_body: "Metaphase" }] };
  const { result, calls } = await repair({ server: { item: unreadable } });
  assert.deepEqual(result, { matched: true, ok: false, sent: false, error: "item_bank_interaction_ids_unreadable" });
  assert.deepEqual(calls, [`GET ${ITEM_PATH}`, `GET ${ENTRY_PATH}`]);
});

test("a proposal that does not preserve every other field of the question is refused", async () => {
  const { result, calls } = await repair({ guard: { protected_state_sha256: "c".repeat(64) } });
  assert.deepEqual(result, { matched: true, ok: false, sent: false, error: "item_bank_protected_state_changed" });
  assert.deepEqual(calls, [`GET ${ITEM_PATH}`, `GET ${ENTRY_PATH}`]);
});

test("the protected state drops the changed body and the provider timestamps and nothing else", async () => {
  const state = itemBankProtectedState(ITEM);
  assert.equal(Object.hasOwn(state.entry, "item_body"), false);
  assert.equal(Object.hasOwn(state.entry, "updated_at"), false);
  assert.equal(Object.hasOwn(state, "updated_at"), false);
  assert.deepEqual(state.entry.interaction_data, ITEM.entry.interaction_data);
  assert.equal(state.entry.points_possible, 1);
  assert.equal(await itemBankProtectedStateDigest(ITEM), await itemBankProtectedStateDigest(await savedItem()));
  assert.equal(itemBankProtectedState({ id: ITEM_ID }), null);
});

test("a readback that does not match the question Morrow sent is never reported as verified", async () => {
  const cases = [
    ["saved_item_body_did_not_match", ITEM],
    ["saved_protected_state_did_not_match", await (async () => {
      const drifted = await savedItem();
      drifted.entry.points_possible = 5;
      return drifted;
    })()],
    ["item_bank_interaction_ids_changed", await (async () => {
      const ghosted = await savedItem();
      ghosted.entry.interaction_data.choices.push({ id: "c3", item_body: "" });
      return ghosted;
    })()],
    ["saved_item_did_not_match_target", { id: "999", entry_type: "Item", entry: { item_body: BODY } }],
  ];
  for (const [reason, readback] of cases) {
    const { result, calls, patches } = await repair({ server: { readback } });
    assert.equal(patches, 1, reason);
    assert.deepEqual(calls, [`GET ${ITEM_PATH}`, `GET ${ENTRY_PATH}`, `PATCH ${ITEM_PATH}`, `GET ${ITEM_PATH}`], reason);
    assert.equal(result.ok, true, reason);
    assert.equal(result.verification.status, "mismatch", reason);
    assert.equal(result.verification.reason, reason);
    assert.equal(result.outcomeUnknown, false, reason);
    assert.match(result.verification.expectedBodySha256, /^[0-9a-f]{64}$/);
    assert.match(result.verification.savedBodySha256, /^[0-9a-f]{64}$/);
  }
});

test("a readback that cannot be made leaves the outcome unknown and sends nothing more", async () => {
  const { result, calls, patches } = await repair({ server: { readbackThrows: true } });
  assert.equal(patches, 1);
  assert.deepEqual(calls, [`GET ${ITEM_PATH}`, `GET ${ENTRY_PATH}`, `PATCH ${ITEM_PATH}`, `GET ${ITEM_PATH}`]);
  assert.equal(result.ok, true);
  assert.equal(result.sent, true);
  assert.equal(result.outcomeUnknown, true);
  assert.deepEqual(result.verification, {
    schema: "morrow.browser-verification.v1",
    strategy: "item-bank-item-readback",
    status: "unconfirmed",
    reason: "item_bank_readback_unavailable",
  });
});

test("a refused PATCH is known, and an uncertain one is never repeated or read back as success", async () => {
  const refused = await repair({ server: { patchStatus: 422 } });
  assert.equal(refused.patches, 1);
  assert.deepEqual(refused.calls, [`GET ${ITEM_PATH}`, `GET ${ENTRY_PATH}`, `PATCH ${ITEM_PATH}`]);
  assert.equal(refused.result.ok, false);
  assert.equal(refused.result.sent, true);
  assert.equal(refused.result.status, 422);
  assert.equal(refused.result.outcomeUnknown, false);
  assert.equal(refused.result.verification, undefined);

  for (const status of [408, 429, 500, 502, 503]) {
    const uncertain = await repair({ server: { patchStatus: status } });
    assert.equal(uncertain.patches, 1, `HTTP ${status}`);
    assert.deepEqual(uncertain.calls, [`GET ${ITEM_PATH}`, `GET ${ENTRY_PATH}`, `PATCH ${ITEM_PATH}`], `HTTP ${status}`);
    assert.equal(uncertain.result.ok, false, `HTTP ${status}`);
    assert.equal(uncertain.result.sent, true, `HTTP ${status}`);
    assert.equal(uncertain.result.outcomeUnknown, true, `HTTP ${status}`);
    assert.equal(uncertain.result.verification, undefined, `HTTP ${status}`);
  }
});

test("a guard Morrow cannot read, or one that does not name this request, is refused", async () => {
  const base = await guardFor(ITEM);
  // Shapes the guard rule itself rejects.
  const malformed = [
    ["another guard kind", { kind: "new_quiz_item_image_alt" }],
    ["a stimulus entry type", { entry_type: "Stimulus" }],
    ["blank alternative text", { alt_text: "   " }],
    ["a short digest", { item_sha256: "abc" }],
    ["a zero image index", { image_index: 0 }],
    ["a duplicated acknowledgement", { acknowledged_course_ids: ["9", "9", "77"] }],
    ["a fan-out that is not a record", { fan_out: "complete" }],
    ["a course id that is not a course", { course_id: "0" }],
  ];
  // Shapes the rule accepts, and this frame refuses because they name another
  // course, another bank, or another question than the one it was asked for.
  const misdirected = [
    ["another course", { course_id: "43" }],
    ["another bank", { bank_id: "92" }],
    ["another question", { item_id: "502" }],
  ];
  for (const [label, overrides] of malformed) {
    assert.equal(validItemBankGuard({ ...base, ...overrides }), false, label);
  }
  for (const [label, overrides] of misdirected) {
    assert.equal(validItemBankGuard({ ...base, ...overrides }), true, label);
  }
  for (const [label, overrides] of [...malformed, ...misdirected]) {
    const { result, calls } = await repair({ guard: overrides });
    assert.deepEqual(result, { matched: true, ok: false, sent: false, error: "item_bank_guard_invalid" }, label);
    assert.deepEqual(calls, [], label);
  }
  assert.equal(validItemBankGuard(base), true);
  assert.equal(validItemBankGuard({ ...base, extra: 1 }), false);
  const { bank_entry_id: _dropped, ...incomplete } = base;
  assert.equal(validItemBankGuard(incomplete), false);
});

test("a guarded repair carries no question payload and no other argument", async () => {
  const guard = await guardFor(ITEM);
  for (const args of [
    { bank_id: BANK, item_id: ITEM_ID, morrow_item_bank_guard: guard, item: { entry: { item_body: "<p>replaced</p>" } } },
    { bank_id: BANK, item_id: ITEM_ID, morrow_item_bank_guard: guard, morrow_max_pages: 2 },
    { bank_id: "92", item_id: ITEM_ID, morrow_item_bank_guard: guard },
  ]) {
    const { result, calls } = await repair({ args });
    assert.deepEqual(result, { matched: true, ok: false, sent: false, error: "item_bank_guard_invalid" });
    assert.deepEqual(calls, []);
  }
});

test("a guard on any route other than the question update is refused before anything runs", async () => {
  const guard = await guardFor(ITEM);
  const getItem = catalog.operations.find((operation) => operation.service === "item_bank" && operation.nickname === "get_item");
  const result = await withPageContext(async () => {
    globalThis.fetch = async () => { throw new Error("no request may be made"); };
    return await executeItemBankInPage({
      principalId: "7",
      canvasOrigin: "https://school.instructure.com",
      courseId: COURSE,
      operation: getItem,
      arguments: { bank_id: BANK, item_id: ITEM_ID, morrow_item_bank_guard: guard },
    });
  });
  assert.deepEqual(result, { matched: true, ok: false, sent: false, error: "item_bank_guard_refused" });
});

test("an unguarded question update still sends the caller's payload", async () => {
  const calls = [];
  const result = await withPageContext(async () => {
    globalThis.fetch = async (url, options) => {
      calls.push({ url: String(url), body: JSON.parse(options.body) });
      return jsonResponse({ id: ITEM_ID });
    };
    return await executeItemBankInPage({
      principalId: "7",
      canvasOrigin: "https://school.instructure.com",
      courseId: COURSE,
      operation: UPDATE_ITEM,
      arguments: { bank_id: BANK, item_id: ITEM_ID, item: { title: "Revised question" } },
    });
  });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [{ url: `https://school.quiz-api.instructure.com${ITEM_PATH}`, body: { item: { title: "Revised question" } } }]);
});

test("the guard module and the fan-out module encode a value the same way", async () => {
  const consumers = [
    { course_id: "9", entity_type: "quiz", entity_id: "5150" },
    { course_id: "42", entity_type: "bank_entry", entity_id: ENTRY_ID },
    { course_id: "77", entity_type: "course", entity_id: "77" },
  ];
  assert.equal(await itemBankItemDigest(consumers), await fanOutDigest(consumers));
  assert.equal(await itemBankItemDigest({ b: 1, a: [2, null] }), await itemBankItemDigest({ a: [2, null], b: 1 }));
});
