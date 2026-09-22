import assert from "node:assert/strict";
import test from "node:test";
import {
  ITEM_BANK_FAN_OUT_MAX_AGE_MS,
  ITEM_BANK_FAN_OUT_SCHEMA,
  ITEM_BANK_FAN_OUT_SOURCES,
  establishFanOut,
  fanOutDigest,
  normalizeFanOutConsumers,
  validFanOut,
} from "../../connector/extension/src/item-bank-fan-out.js";

const NOW = Date.parse("2026-09-06T18:00:00Z");
const BANK = "91";
const COURSE = "42";
const READ = Object.freeze([
  { name: "bank_entries", pages: 2, exhausted: true },
  { name: "shared_banks", pages: 1, exhausted: true },
  { name: "quiz_uses", pages: 1, exhausted: true },
]);
// The bank holds an entry in its own course, is shared into course 77, and one
// quiz in course 9 draws from it. Courses 9 and 77 are the external reach.
const CONSUMERS = Object.freeze([
  { course_id: "42", entity_type: "bank_entry", entity_id: "401" },
  { course_id: "77", entity_type: "course", entity_id: "77" },
  { course_id: "9", entity_type: "quiz", entity_id: "5150" },
]);
const EXTERNAL = ["9", "77"];

const record = (overrides = {}) => establishFanOut({
  bankId: BANK, courseId: COURSE, sources: READ, consumers: CONSUMERS, unreachable: [], observedAt: NOW - 60_000, ...overrides,
});
const reason = (fanOut, overrides = {}) => validFanOut(fanOut, {
  bankId: BANK, courseId: COURSE, acknowledgedCourseIds: EXTERNAL, now: NOW, ...overrides,
});
// The record is never a complete-reach claim. Canvas exposes no account-wide
// reverse-use list, so `quiz_uses` always stays unread. What the record does is
// disclose the courses Morrow observed, and a reviewer acknowledges exactly
// those courses before an existing bank changes.
const UNPROVABLE = "authoritative_reach_claim_refused";

test("a bounded record discloses the observed courses and authorizes the acknowledged change", async () => {
  const fanOut = await record();
  assert.equal(fanOut.schema, ITEM_BANK_FAN_OUT_SCHEMA);
  assert.equal(fanOut.bank_id, BANK);
  assert.equal(fanOut.course_id, COURSE);
  assert.equal(fanOut.complete, false);
  assert.deepEqual(fanOut.unreachable, ["quiz_uses"]);
  assert.deepEqual(fanOut.sources.map((row) => row.name), [...ITEM_BANK_FAN_OUT_SOURCES]);
  assert.deepEqual(fanOut.consumers, [
    { course_id: "9", entity_type: "quiz", entity_id: "5150" },
    { course_id: "42", entity_type: "bank_entry", entity_id: "401" },
    { course_id: "77", entity_type: "course", entity_id: "77" },
  ]);
  assert.equal(fanOut.consumer_count, 3);
  assert.deepEqual(fanOut.external_course_ids, EXTERNAL);
  assert.equal(fanOut.consumers_sha256, await fanOutDigest(CONSUMERS));
  assert.equal(fanOut.established_at, "2026-09-06T17:59:00.000Z");
  assert.equal(fanOut.sources.find((row) => row.name === "quiz_uses").exhausted, false);
  assert.equal(await reason(fanOut), null);
});

test("the consumer digest is stable across key order, row order and id form", async () => {
  const shuffled = [
    { entity_id: "77", course_id: "77", entity_type: "course" },
    { entity_type: "quiz", entity_id: "5150", course_id: 9 },
    { entity_id: "401", entity_type: "bank_entry", course_id: "42" },
  ];
  assert.equal(await fanOutDigest(shuffled), await fanOutDigest(CONSUMERS));
  assert.deepEqual(normalizeFanOutConsumers(shuffled), normalizeFanOutConsumers(CONSUMERS));
  assert.notEqual(await fanOutDigest([...CONSUMERS, { course_id: "88", entity_type: "course", entity_id: "88" }]), await fanOutDigest(CONSUMERS));
  // Course ids sort as numbers, so course 10 reads after course 9.
  assert.deepEqual(normalizeFanOutConsumers([
    { course_id: "10", entity_type: "course", entity_id: "10" },
    { course_id: "9", entity_type: "course", entity_id: "9" },
  ]).map((consumer) => consumer.course_id), ["9", "10"]);
  assert.equal(normalizeFanOutConsumers([...CONSUMERS, CONSUMERS[1]]), null);
  assert.equal(await fanOutDigest([...CONSUMERS, CONSUMERS[1]]), null);
  assert.equal(normalizeFanOutConsumers([{ course_id: "0", entity_type: "course", entity_id: "1" }]), null);
  assert.equal(normalizeFanOutConsumers([{ course_id: "42", entity_type: "", entity_id: "1" }]), null);
  assert.equal(normalizeFanOutConsumers("42"), null);
});

test("an unread source is never an empty fan-out", async () => {
  const missing = await record({ sources: READ.filter((row) => row.name !== "quiz_uses") });
  assert.equal(missing.complete, false);
  assert.deepEqual(missing.unreachable, ["quiz_uses"]);
  assert.equal(await reason(missing), null);

  const unexhausted = await record({ sources: READ.map((row) => row.name === "shared_banks" ? { ...row, exhausted: false } : row) });
  assert.equal(unexhausted.complete, false);
  assert.deepEqual(unexhausted.unreachable, ["quiz_uses", "shared_banks"]);
  assert.equal(await reason(unexhausted), null);

  // A bank with no consumers found still discloses that a source was unread.
  // Nothing enumerated is not the same answer as nothing found, so the record
  // says so and the reviewer acknowledges an empty external list on purpose.
  const nothingRead = await record({ sources: [], consumers: [] });
  assert.deepEqual(nothingRead.unreachable, [...ITEM_BANK_FAN_OUT_SOURCES].sort());
  assert.deepEqual(nothingRead.external_course_ids, []);
  assert.equal(await reason(nothingRead, { acknowledgedCourseIds: [] }), null);
});

test("a record that claims complete reach is refused", async () => {
  const fanOut = await record();
  // Nothing may present itself as an authoritative account-wide answer.
  assert.equal(await reason({ ...fanOut, complete: true }), UNPROVABLE);
  assert.equal(await reason({ ...fanOut, complete: "false" }), UNPROVABLE);
  assert.equal(await reason({
    ...fanOut,
    unreachable: [],
    sources: READ.map((row) => ({ ...row, exhausted: true })),
  }), UNPROVABLE);
  // A record with no `unreachable` list names nothing read, which is still an
  // unread source, so it stays usable as a disclosure.
  assert.equal(await reason({ ...fanOut, unreachable: undefined }), null);
  assert.equal(await reason({ ...fanOut, sources: READ.filter((row) => row.name !== "quiz_uses"), unreachable: [] }), null);
});

test("a record that was edited after it was taken is refused", async () => {
  const fanOut = await record();
  assert.equal(await reason({ ...fanOut, consumers_sha256: "0".repeat(64) }), "consumers_digest_mismatch");
  assert.equal(await reason({ ...fanOut, consumers_sha256: "not-a-digest" }), "consumers_digest_mismatch");
  // A consumer removed after the digest was taken, with the count corrected to
  // match, is exactly the change the digest exists to catch.
  assert.equal(await reason({ ...fanOut, consumers: fanOut.consumers.slice(1), consumer_count: 2, external_course_ids: ["77"] }), "consumers_digest_mismatch");
  assert.equal(await reason({ ...fanOut, consumer_count: 2 }), "consumer_count_mismatch");
  assert.equal(await reason({ ...fanOut, consumer_count: "3" }), "consumer_count_mismatch");
  assert.equal(await reason({ ...fanOut, consumers: [...fanOut.consumers, fanOut.consumers[0]], consumer_count: 4 }), "consumers_invalid");
  assert.equal(await reason({ ...fanOut, consumers: undefined, consumer_count: 0 }), "consumers_invalid");
  // Hiding one external course from the acknowledgement list is refused even
  // though the consumer digest still matches.
  assert.equal(await reason({ ...fanOut, external_course_ids: ["9"] }), "external_course_ids_mismatch");
  assert.equal(await reason({ ...fanOut, external_course_ids: [...EXTERNAL, "88"] }), "external_course_ids_mismatch");
  assert.equal(await reason({ ...fanOut, external_course_ids: ["77", "9"] }), "external_course_ids_mismatch");
  assert.equal(await reason({ ...fanOut, external_course_ids: undefined }), "external_course_ids_mismatch");
  assert.equal(await reason({ ...fanOut, schema: "canvas.item-bank.fan-out.v1" }), "wrong_schema");
  assert.equal(await reason(null), "missing_record");
  assert.equal(await reason(undefined), "missing_record");
  assert.equal(await reason([fanOut]), "missing_record");
});

test("a stale, undated, or future record cannot authorize a change", async () => {
  const stale = await record({ observedAt: NOW - ITEM_BANK_FAN_OUT_MAX_AGE_MS - 60_000 });
  assert.equal(stale.established_at, "2026-09-06T16:59:00.000Z");
  assert.equal(await reason(stale), "record_too_old");
  const edge = await record({ observedAt: NOW - ITEM_BANK_FAN_OUT_MAX_AGE_MS });
  assert.equal(await reason(edge), null);
  assert.equal(await reason(await record({ observedAt: NOW - ITEM_BANK_FAN_OUT_MAX_AGE_MS - 1 })), "record_too_old");
  const future = await record({ observedAt: NOW + 1 });
  assert.equal(await reason(future), "record_from_future");

  const fanOut = await record();
  assert.equal(await reason({ ...fanOut, established_at: "2026-09-06T17:59:00" }), "established_at_unreadable");
  assert.equal(await reason({ ...fanOut, established_at: "just now" }), "established_at_unreadable");
  assert.equal(await reason({ ...fanOut, established_at: NOW - 60_000 }), "established_at_unreadable");
  assert.equal(await reason(fanOut, { now: undefined }), "record_age_unknown");

  // An offset stamp is kept as the one instant it names.
  const offset = await record({ observedAt: "2026-09-06T13:59:00-04:00" });
  assert.equal(offset.established_at, "2026-09-06T17:59:00.000Z");
  assert.equal(await reason(offset), null);
});

test("a record for another bank or another course is refused", async () => {
  const fanOut = await record();
  assert.equal(await reason(fanOut, { bankId: "92" }), "bank_mismatch");
  assert.equal(await reason(fanOut, { bankId: "" }), "bank_mismatch");
  assert.equal(await reason(fanOut, { courseId: "43" }), "course_mismatch");
  assert.equal(await reason(fanOut, { courseId: "0" }), "course_mismatch");
  assert.equal(await reason(await record({ bankId: "92" })), "bank_mismatch");
  assert.equal(await reason(await record({ courseId: "9" })), "course_mismatch");
});

test("the acknowledgement must name the observed external courses exactly", async () => {
  const fanOut = await record();
  for (const acknowledgedCourseIds of [["9"], ["77"], [...EXTERNAL, "88"], ["9", "9", "77"], [], undefined, "9,77"]) {
    assert.equal(await reason(fanOut, { acknowledgedCourseIds }), "acknowledgement_mismatch", JSON.stringify(acknowledgedCourseIds));
  }
  // Order and number form do not matter; the set of courses does.
  assert.equal(await reason(fanOut, { acknowledgedCourseIds: ["77", "9"] }), null);
  assert.equal(await reason(fanOut, { acknowledgedCourseIds: [9, 77] }), null);
});

test("an owner bank with no share rows still needs its observed reach acknowledged", async () => {
  const local = await record({ consumers: [{ course_id: COURSE, entity_type: "bank_entry", entity_id: "401" }] });
  assert.equal(local.complete, false);
  assert.equal(local.consumer_count, 1);
  assert.deepEqual(local.external_course_ids, []);
  assert.deepEqual(local.unreachable, ["quiz_uses"]);
  // An empty external list is still an explicit acknowledgement, never an
  // omission: the reviewer says "no other course was observed", in writing.
  assert.equal(await reason(local, { acknowledgedCourseIds: [] }), null);
  assert.equal(await reason(local, { acknowledgedCourseIds: undefined }), "acknowledgement_mismatch");
  assert.equal(await reason(local, { acknowledgedCourseIds: ["77"] }), "acknowledgement_mismatch");
});

test("no record is built from input it could not record honestly", async () => {
  assert.equal(await record({ consumers: [...CONSUMERS, CONSUMERS[0]] }), null);
  assert.equal(await record({ consumers: [{ course_id: "42", entity_type: "bank_entry" }] }), null);
  assert.equal(await record({ consumers: undefined }), null);
  assert.equal(await record({ sources: [...READ, { name: "bank_index", pages: 1, exhausted: true }] }), null);
  assert.equal(await record({ sources: [...READ, READ[0]] }), null);
  assert.equal(await record({ sources: [{ name: "bank_entries", pages: -1, exhausted: true }] }), null);
  assert.equal(await record({ unreachable: "quiz_uses" }), null);
  assert.equal(await record({ bankId: "" }), null);
  assert.equal(await record({ courseId: "0" }), null);
  assert.equal(await record({ observedAt: "2026-09-06T17:59:00" }), null);
  assert.equal(await record({ observedAt: "whenever" }), null);
  assert.equal(await record({ observedAt: undefined }), null);
  // A quiz_uses source can never be recorded as walked to its end, whatever the
  // caller claims, because Canvas has no route that would prove it.
  const claimed = await record({ sources: READ.map((row) => ({ ...row, exhausted: true })) });
  assert.equal(claimed.sources.find((row) => row.name === "quiz_uses").exhausted, false);
  assert.equal(claimed.complete, false);
});
