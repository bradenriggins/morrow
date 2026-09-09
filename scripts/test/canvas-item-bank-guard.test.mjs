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
  itemBankEntryMatchesTarget,
  itemBankImageAttributes,
  itemBankInteractionIds,
  itemBankItemDigest,
  itemBankMediaFindings,
  itemBankNewMediaReason,
  itemBankProtectedState,
  itemBankProtectedStateDigest,
  sameItemBankInteractionIds,
  validItemBankGuard,
} from "../../connector/extension/src/item-bank-guard.js";

const catalog = JSON.parse(readFileSync(new URL("../../artifacts/canvas-api/canvas-api-catalog.json", import.meta.url), "utf8"));
const UPDATE_ITEM = catalog.operations.find((operation) => operation.service === "item_bank" && operation.nickname === "update_item");
assert.ok(UPDATE_ITEM, "missing Item Bank operation update_item");

const COURSE = "42";
const CONTEXT_UUID = "course-context-uuid";
const BANK = "91";
const ENTRY_ID = "401";
const ITEM_ID = "501";
const ASSOCIATION_PATH = "/api/banks";
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
// The same question with a second undescribed image. Repairing the first image
// must not be refused because the second one still needs its own repair, and
// the second one must come back untouched.
const TWO_UNDESCRIBED = [
  "<p>Which slide shows metaphase?</p>",
  `<p><img src="${TARGET_SRC}"></p>`,
  `<p><img src="${SECOND_SRC}"></p>`,
].join("\n");

const sha256 = (value) => createHash("sha256").update(value, "utf8").digest("hex");

const item = (body) => Object.freeze({
  id: ITEM_ID,
  entry_type: "Item",
  position: 3,
  status: "active",
  updated_at: "2026-09-01T10:00:00Z",
  entry: {
    title: "Mitosis stages",
    item_body: body,
    interaction_type_slug: "choice",
    interaction_data: { choices: [{ id: "c1", item_body: "Metaphase" }, { id: "c2", item_body: "Anaphase" }] },
    scoring_data: { value: "c1" },
    points_possible: 1,
    updated_at: "2026-09-01T10:00:00Z",
  },
});
const ITEM = item(BODY);
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

async function guardFor(source, overrides = {}) {
  return {
    kind: "item_bank_entry_image_alt",
    course_id: COURSE,
    bank_id: BANK,
    bank_entry_id: ENTRY_ID,
    item_id: ITEM_ID,
    entry_type: "Item",
    item_sha256: await itemBankItemDigest(source),
    protected_state_sha256: await itemBankProtectedStateDigest(source),
    image_index: 1,
    image_src_sha256: sha256(TARGET_SRC),
    alt_text: ALT,
    fan_out: await fanOut(),
    acknowledged_course_ids: [...EXTERNAL],
    ...overrides,
  };
}

/** The body every accepted repair must send: the stored body with one alt added. */
async function repairedBody(source = ITEM) {
  const applied = await applyItemBankImageAlt(source.entry.item_body, { image_index: 1, image_src_sha256: sha256(TARGET_SRC), alt_text: ALT });
  assert.equal(applied.error, undefined);
  return applied.body;
}

async function savedItem(source = ITEM) {
  const saved = clone(source);
  saved.entry.item_body = await repairedBody(source);
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
    document: { referrer: `https://school.instructure.com/courses/${COURSE}/external_tools/54065` },
    sessionStorage: storage({ current_user: JSON.stringify({ id: "7" }) }),
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
function bank({ source = ITEM, entry = ENTRY, readback, readbackThrows = false, patchStatus = 200, patchThrows = false, entryStatus = 200 } = {}) {
  const calls = [];
  const requests = [];
  let itemReads = 0;
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(String(url));
    const method = options.method || "GET";
    calls.push(`${method} ${parsed.pathname}`);
    requests.push({ method, pathname: parsed.pathname, options, body: options.body ? JSON.parse(options.body) : undefined });
    if (method === "GET" && parsed.pathname === ASSOCIATION_PATH) {
      assert.equal(parsed.searchParams.get("course_id"), CONTEXT_UUID);
      return jsonResponse([{ id: BANK, title: "Biology bank" }]);
    }
    if (method === "GET" && parsed.pathname === ITEM_PATH) {
      itemReads += 1;
      if (itemReads === 1) return jsonResponse(source);
      if (readbackThrows) throw new TypeError("the Item Banks frame is gone");
      return jsonResponse(readback ?? await savedItem(source));
    }
    if (method === "GET" && parsed.pathname === ENTRY_PATH) return jsonResponse(entry, entryStatus);
    if (method === "PATCH" && parsed.pathname === ITEM_PATH) {
      if (patchThrows) throw new TypeError("the Item Banks frame lost the answer");
      return jsonResponse(patchStatus === 200 ? await savedItem(source) : { errors: [{ message: "The Item Banks API did not accept this change." }] }, patchStatus);
    }
    throw new Error(`unexpected request ${method} ${parsed.pathname}`);
  };
  return { calls, requests, fetchImpl };
}

async function repair({ guard: guardOverrides = {}, server = {}, args, guardItem } = {}) {
  const source = guardItem ?? server.source ?? ITEM;
  const guard = await guardFor(source, guardOverrides);
  const api = bank(server);
  const result = await withPageContext(async (token) => {
    globalThis.fetch = api.fetchImpl;
    const capturedAt = Date.now();
    const value = await executeItemBankInPage({
      principalId: "7",
      canvasOrigin: "https://school.instructure.com",
      courseId: COURSE,
      operation: UPDATE_ITEM,
      arguments: args ?? { bank_id: BANK, item_id: ITEM_ID, morrow_item_bank_guard: guard },
      credential: {
        apiOrigin: "https://school.quiz-api.instructure.com",
        token,
        authType: "Signature",
        contextUuid: CONTEXT_UUID,
        canvasLocalContextId: COURSE,
        launchUrl: `https://school.instructure.com/courses/${COURSE}/external_tools/54065`,
        launchNonce: "b28f3aae-8888-4c5b-9a17-458f2e1fe309",
        launchedAt: capturedAt - 1_000,
        capturedAt,
      },
    });
    const encoded = JSON.stringify(value ?? null);
    assert.equal(encoded.includes(token), false, "the result carried the credential");
    assert.equal(encoded.includes(CONTEXT_UUID), false, "the result carried the private context");
    assert.equal(encoded.includes("morrow_item_bank_guard"), false, "the result carried the guard");
    assert.equal(encoded.includes("acknowledged_course_ids"), false, "the result carried the acknowledgement");
    assert.equal(encoded.includes("consumers_sha256"), false, "the result carried the fan-out record");
    assert.equal(encoded.includes(ALT), false, "the result carried the question content");
    return value;
  });
  const patches = api.requests.filter((request) => request.method === "PATCH");
  assert.ok(patches.length <= 1, `sent ${patches.length} PATCH requests`);
  return { result, calls: api.calls, requests: api.requests, guard, patches: patches.length, sentBody: patches[0]?.body };
}

test("a bounded fan-out record discloses reach and the acknowledged change proceeds", async () => {
  const record = await fanOut();
  assert.equal(record.complete, false);
  assert.deepEqual(record.unreachable, ["quiz_uses"]);
  assert.equal(record.sources.find((source) => source.name === "quiz_uses").exhausted, false);
  assert.equal(await validFanOut(record, {
    bankId: BANK, courseId: COURSE, acknowledgedCourseIds: EXTERNAL, now: Date.now(),
  }), null);
  assert.equal(record.consumers_sha256, await fanOutDigest(CONSUMERS));
});

test("the bank-entry target requires the exact row id and any present bank id", () => {
  const base = { id: ENTRY_ID, entry_type: "Item", entry_id: ITEM_ID };
  assert.equal(itemBankEntryLinksItem(base, ITEM_ID), true);
  assert.equal(itemBankEntryMatchesTarget(base, ENTRY_ID, BANK, ITEM_ID), true);
  assert.equal(itemBankEntryMatchesTarget({ ...base, bank_id: BANK }, ENTRY_ID, BANK, ITEM_ID), true);
  assert.equal(itemBankEntryMatchesTarget({ ...base, id: "402" }, ENTRY_ID, BANK, ITEM_ID), false);
  assert.equal(itemBankEntryMatchesTarget({ ...base, bank_id: "92" }, ENTRY_ID, BANK, ITEM_ID), false);
  assert.equal(itemBankEntryMatchesTarget({ ...base, entry_id: "502" }, ENTRY_ID, BANK, ITEM_ID), false);
});

test("the legacy image guard remains structurally bounded", async () => {
  const guard = await guardFor(ITEM);
  assert.equal(validItemBankGuard(guard), true);
  for (const broken of [
    { kind: "page_image_alt" }, { entry_type: "Stimulus" }, { course_id: "0" }, { image_index: 0 },
    { image_src_sha256: "not-a-digest" }, { alt_text: "   " }, { alt_text: "x".repeat(501) },
    { fan_out: null }, { acknowledged_course_ids: ["9", "9"] }, { acknowledged_course_ids: "9" },
  ]) {
    assert.equal(validItemBankGuard({ ...guard, ...broken }), false, JSON.stringify(broken));
  }
  assert.equal(validItemBankGuard({ ...guard, extra: 1 }), false);
  const scan = itemBankContentImages(BODY);
  assert.equal(scan.open, false);
  assert.equal(scan.images.length, 2);
  assert.equal(itemBankImageAttributes(scan.images[0].tag).get("src"), TARGET_SRC);
  assert.deepEqual(itemBankInteractionIds(ITEM), ["choices:c1", "choices:c2"]);
  assert.equal(sameItemBankInteractionIds(itemBankInteractionIds(ITEM), itemBankInteractionIds(clone(ITEM))), true);
  assert.match(await itemBankItemDigest(ITEM), /^[0-9a-f]{64}$/);
  assert.deepEqual(itemBankProtectedState(ITEM), itemBankProtectedState(clone(ITEM)));
});

test("the pure image transform changes only one escaped alt attribute", async () => {
  const applied = await applyItemBankImageAlt(BODY, {
    image_index: 1,
    image_src_sha256: sha256(TARGET_SRC),
    alt_text: `Cells & chromosomes <labelled> "clearly"`,
  });
  assert.equal(applied.error, undefined);
  assert.ok(applied.body.includes(`alt="${escapeItemBankAlt(`Cells & chromosomes <labelled> "clearly"`)}"`));
  assert.ok(applied.body.includes(`<img src="${SECOND_SRC}" alt="A labelled diagram of anaphase">`));
  // The same transform refuses every target it cannot name exactly.
  const guard = { image_index: 1, image_src_sha256: sha256(TARGET_SRC), alt_text: ALT };
  assert.equal((await applyItemBankImageAlt("", guard)).error, "item_bank_image_alt_body_unusable");
  assert.equal((await applyItemBankImageAlt("<p>no image</p>", guard)).error, "item_bank_image_alt_target_missing");
  assert.equal((await applyItemBankImageAlt(`<img src="${SECOND_SRC}">`, guard)).error, "item_bank_image_alt_target_changed");
  assert.equal((await applyItemBankImageAlt(`<img src="${TARGET_SRC}" alt="already">`, guard)).error, "item_bank_image_alt_already_present");
  assert.equal((await applyItemBankImageAlt(`<img src="${TARGET_SRC}"><img src="${TARGET_SRC}">`, guard)).error, "item_bank_image_alt_ambiguous");
  assert.equal((await applyItemBankImageAlt(`<script><img src="${TARGET_SRC}">`, guard)).error, "item_bank_image_alt_markup_unreadable");
});

test("a legacy image repair sends one change and proves the saved question", async () => {
  const { result, calls, patches, sentBody } = await repair();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.sent, true);
  assert.equal(result.status, 200);
  assert.equal(result.outcomeUnknown, false);
  assert.equal(result.verification.status, "verified");
  assert.equal(result.verification.evidence, "item_body_and_protected_state_reread_after_write");
  assert.equal(patches, 1);
  // Fresh read, exact entry, one change, fresh read again.
  assert.deepEqual(calls, [
    `GET ${ASSOCIATION_PATH}`,
    `GET ${ITEM_PATH}`,
    `GET ${ENTRY_PATH}`,
    `PATCH ${ITEM_PATH}`,
    `GET ${ITEM_PATH}`,
  ]);
  // The bytes the frame sent are exactly the bytes the shared module computes.
  assert.equal(sentBody.item.entry.item_body, await repairedBody());
  assert.deepEqual(itemBankProtectedState(sentBody.item), itemBankProtectedState(ITEM));
});

test("a repair fixes one reviewed image and leaves the other known issue alone", async () => {
  const source = item(TWO_UNDESCRIBED);
  const { result, patches, sentBody } = await repair({ server: { source }, guardItem: source });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.verification.status, "verified");
  assert.equal(patches, 1);
  const sent = sentBody.item.entry.item_body;
  assert.equal(sent, await repairedBody(source));
  assert.ok(sent.includes(`<img src="${TARGET_SRC}" alt="${escapeItemBankAlt(ALT)}">`), "the reviewed image was not repaired");
  // The second undescribed image is still exactly what Canvas held.
  assert.ok(sent.includes(`<img src="${SECOND_SRC}">`), "the untouched image changed");
  assert.equal(itemBankContentImages(sent).images.length, 2);
  assert.deepEqual(itemBankMediaFindings(sentBody.item).map((finding) => finding.reason), ["media_image_alt_missing"]);
  assert.equal(itemBankNewMediaReason(sentBody.item, source), null);
});

test("a question that changed since the review stops before any change is sent", async () => {
  // The guard was planned against the described question; Canvas now holds a
  // different one.
  const { result, calls, patches } = await repair({ server: { source: item(TWO_UNDESCRIBED) }, guardItem: ITEM });
  assert.equal(result.error, "item_bank_source_changed");
  assert.equal(result.sent, false);
  assert.equal(patches, 0);
  assert.deepEqual(calls, [`GET ${ASSOCIATION_PATH}`, `GET ${ITEM_PATH}`]);
});

test("a definite provider refusal is reported as refused and never repeated", async () => {
  const { result, patches } = await repair({ server: { patchStatus: 422 } });
  assert.equal(result.ok, false);
  assert.equal(result.sent, true);
  assert.equal(result.status, 422);
  assert.equal(result.outcomeUnknown, false);
  assert.equal(patches, 1);
});

test("an uncertain provider answer is never sent a second time", async () => {
  for (const patchStatus of [408, 429, 500, 503]) {
    const { result, patches } = await repair({ server: { patchStatus } });
    assert.equal(result.ok, false, String(patchStatus));
    assert.equal(result.sent, true, String(patchStatus));
    assert.equal(result.outcomeUnknown, true, String(patchStatus));
    assert.equal(patches, 1, String(patchStatus));
  }
  const lost = await repair({ server: { patchThrows: true } });
  assert.equal(lost.result.sent, true);
  assert.equal(lost.result.outcomeUnknown, true);
  assert.equal(lost.result.error, "item_bank_request_failed");
  assert.equal(lost.patches, 1);
});

test("a saved question that does not match the reviewed repair is never verified", async () => {
  const cases = [
    ["the change was not applied", { readback: ITEM }, "saved_item_body_did_not_match"],
    ["another question came back", { readback: { ...clone(ITEM), id: "502" } }, "saved_item_did_not_match_target"],
    ["a protected field changed", { readback: { ...clone(await savedItem()), points_possible: 5 } }, "saved_protected_state_did_not_match"],
  ];
  for (const [label, server, reason] of cases) {
    const { result, patches } = await repair({ server });
    assert.equal(result.ok, false, label);
    assert.equal(result.sent, true, label);
    assert.equal(result.outcomeUnknown, true, label);
    assert.equal(result.verification.status, "mismatch", `${label}: ${JSON.stringify(result.verification)}`);
    assert.equal(result.verification.reason, reason, label);
    assert.equal(patches, 1, label);
  }
  // An answer that never arrives leaves the outcome unknown, never failed and
  // never verified.
  const gone = await repair({ server: { readbackThrows: true } });
  assert.equal(gone.result.ok, false);
  assert.equal(gone.result.outcomeUnknown, true);
  assert.equal(gone.result.verification.status, "unconfirmed");
  assert.equal(gone.patches, 1);
});

test("a repair whose reach record is unusable stops before any read or change", async () => {
  const record = await fanOut();
  const cases = [
    ["a complete claim", { fan_out: { ...record, complete: true } }, "item_bank_fan_out_authoritative_reach_claim_refused"],
    ["an unacknowledged observed course", { acknowledged_course_ids: ["9"] }, "item_bank_fan_out_acknowledgement_mismatch"],
    ["a record for another bank", { fan_out: { ...record, bank_id: "92" } }, "item_bank_fan_out_bank_mismatch"],
    ["a record older than one hour", { fan_out: { ...record, established_at: new Date(Date.now() - 61 * 60 * 1_000).toISOString() } }, "item_bank_fan_out_record_too_old"],
    ["a record from the future", { fan_out: { ...record, established_at: new Date(Date.now() + 60_000).toISOString() } }, "item_bank_fan_out_record_from_future"],
  ];
  for (const [label, overrides, expected] of cases) {
    const { result, calls, patches } = await repair({ guard: overrides });
    assert.equal(result.error, expected, label);
    assert.equal(result.sent, false, label);
    assert.equal(patches, 0, label);
    assert.deepEqual(calls, [], label);
  }
});

test("a guard that does not match this exact target is refused before any read", async () => {
  const cases = [
    ["another course", { guard: { course_id: "43" } }, "item_bank_course_mismatch"],
    ["another bank", { guard: { bank_id: "92" } }, "item_bank_guard_invalid"],
    ["a structurally invalid guard", { guard: { image_index: 0 } }, "item_bank_guard_invalid"],
    ["another question", { guard: { item_id: "502" } }, "item_bank_guard_invalid"],
    ["a guard with an unexpected field", { guard: { extra: 1 } }, "item_bank_guard_invalid"],
  ];
  for (const [label, options, expected] of cases) {
    const { result, calls, patches } = await repair(options);
    assert.equal(result.error, expected, label);
    assert.equal(result.sent, false, label);
    assert.equal(patches, 0, label);
    assert.deepEqual(calls, [], label);
  }
  // A guarded request carries the guard and its two target ids, nothing else.
  const guard = await guardFor(ITEM);
  const extra = await repair({ args: { bank_id: BANK, item_id: ITEM_ID, title: "Renamed", morrow_item_bank_guard: guard } });
  assert.equal(extra.result.error, "item_bank_guard_invalid");
  assert.equal(extra.patches, 0);
});

test("a guard on any operation other than the item update is refused", async () => {
  const guard = await guardFor(ITEM);
  await withPageContext(async (token) => {
    let calls = 0;
    globalThis.fetch = async () => { calls += 1; return jsonResponse([]); };
    const capturedAt = Date.now();
    const result = await executeItemBankInPage({
      principalId: "7",
      canvasOrigin: "https://school.instructure.com",
      courseId: COURSE,
      operation: catalog.operations.find((operation) => operation.service === "item_bank" && operation.nickname === "rename_bank"),
      arguments: { bank_id: BANK, title: "Renamed", morrow_item_bank_guard: guard },
      credential: {
        apiOrigin: "https://school.quiz-api.instructure.com", token, authType: "Signature", contextUuid: CONTEXT_UUID,
        canvasLocalContextId: COURSE, launchUrl: `https://school.instructure.com/courses/${COURSE}/external_tools/54065`,
        launchNonce: "b28f3aae-8888-4c5b-9a17-458f2e1fe309", launchedAt: capturedAt - 1_000, capturedAt,
      },
    });
    assert.equal(result.error, "item_bank_guard_refused");
    assert.equal(result.sent, false);
    assert.equal(calls, 0);
  });
});

test("a bank entry that does not name this exact question stops the repair", async () => {
  const { result, calls, patches } = await repair({ server: { entry: { id: ENTRY_ID, entry_type: "Item", entry_id: "999" } } });
  assert.equal(result.error, "item_bank_entry_unresolved");
  assert.equal(result.sent, false);
  assert.equal(patches, 0);
  assert.deepEqual(calls, [`GET ${ASSOCIATION_PATH}`, `GET ${ITEM_PATH}`, `GET ${ENTRY_PATH}`]);
});

test("an image the guard cannot name uniquely stops the repair", async () => {
  const duplicate = item([
    "<p>Which slide shows metaphase?</p>",
    `<p><img src="${TARGET_SRC}"></p>`,
    `<p><img src="${TARGET_SRC}"></p>`,
  ].join("\n"));
  const { result, patches } = await repair({ server: { source: duplicate }, guardItem: duplicate });
  assert.equal(result.error, "item_bank_image_alt_ambiguous");
  assert.equal(result.sent, false);
  assert.equal(patches, 0);

  const described = item(`<p><img src="${TARGET_SRC}" alt="already described"></p>`);
  const present = await repair({ server: { source: described }, guardItem: described });
  assert.equal(present.result.error, "item_bank_image_alt_already_present");
  assert.equal(present.patches, 0);
});
