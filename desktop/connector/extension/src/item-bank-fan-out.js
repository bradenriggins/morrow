// An Item Bank is shared machinery. This module records the courses Morrow
// observed and verifies that a reviewer acknowledged every observed external
// course. Canvas exposes no authoritative account-wide reverse-use list, so a
// valid record remains explicit about unread sources and never claims complete
// reach.
//
// The distinction the module exists to hold: "no course draws from this bank"
// and "nobody enumerated the courses" are different answers, and only the first
// one authorises a change. A source Morrow could not read is never recorded as
// an empty fan-out, which is why the incomplete reason says so in words.
//
// The module does no I/O and reads no clock. It never throws: an input it
// cannot use returns null, and a record it cannot trust returns a reason.
//
// The actor is not repeated here. It is bound in the frozen operation with the
// bank, the course and the payload digests (contract section 5).

export const ITEM_BANK_FAN_OUT_SCHEMA = "morrow.canvas.item-bank.fan-out.v1";
// The three enumeration sources a complete record needs. `quiz_uses` has no
// Item Banks route, so it can only come from a Canvas-side enumeration. When
// nobody supplies it, the record stays incomplete and every change is refused.
export const ITEM_BANK_FAN_OUT_SOURCES = Object.freeze(["bank_entries", "shared_banks", "quiz_uses"]);
export const ITEM_BANK_FAN_OUT_MAX_AGE_MS = 60 * 60 * 1_000;

const COURSE_ID = /^[1-9][0-9]*$/;
const ENTITY_TYPE = /^[a-z][a-z0-9_]{0,63}$/;
const ENTITY_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const SHA256 = /^[0-9a-f]{64}$/;
// ISO 8601 with an explicit timezone. A stamp without one names no instant, so
// it can never show that the record is fresh.
const TIMEZONE = /(?:Z|[+-][0-9]{2}:?[0-9]{2})$/i;

// Copied from connector/extension/src/edit-policy.js. That module imports the
// generated admission table, and the guard that admits an Item Bank change
// imports both files, so this one stays a leaf instead of importing it. Both
// copies must produce the same bytes for the same value.
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  return JSON.stringify(value === undefined ? null : value);
}

async function digest(value) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stable(value)))), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

const text = (value) => typeof value === "string" ? value : typeof value === "number" && Number.isFinite(value) ? String(value) : "";
const compareText = (a, b) => a < b ? -1 : a > b ? 1 : 0;
// Course ids are decimal with no leading zero, so length before text is their
// numeric order. It keeps course 10 after course 9 in every list a person reads.
const compareCourseIds = (a, b) => a.length === b.length ? compareText(a, b) : a.length - b.length;
const compareConsumers = (a, b) => compareCourseIds(a.course_id, b.course_id) || compareText(a.entity_type, b.entity_type) || compareText(a.entity_id, b.entity_id);
const sameList = (value, expected) => Array.isArray(value) && value.length === expected.length && expected.every((entry, index) => value[index] === entry);
const externalCourseIds = (consumers, courseId) => [...new Set(consumers.map((consumer) => consumer.course_id))].filter((id) => id !== courseId).sort(compareCourseIds);

// Every enumeration source that was not walked to its end, whether it is
// missing from the record, unfinished, or named unreachable. A record whose
// `unreachable` field is not a list is treated as nothing read at all.
function unreadSources(record) {
  const exhausted = new Map();
  for (const row of Array.isArray(record.sources) ? record.sources : []) {
    const name = text(row?.name);
    exhausted.set(name, exhausted.has(name) ? false : row?.exhausted === true);
  }
  const declared = Array.isArray(record.unreachable) ? record.unreachable.map(text) : [...ITEM_BANK_FAN_OUT_SOURCES];
  return [...new Set([...declared, ...ITEM_BANK_FAN_OUT_SOURCES.filter((name) => exhausted.get(name) !== true)])].sort(compareText);
}

function normalizeSources(values) {
  if (values === undefined) return [];
  if (!Array.isArray(values)) return null;
  const rows = new Map();
  for (const value of values) {
    const name = text(value?.name);
    // A source name this module does not know means the caller and the contract
    // disagree about what a complete walk is, so no record is built.
    if (!ITEM_BANK_FAN_OUT_SOURCES.includes(name) || rows.has(name)) return null;
    const pages = value?.pages === undefined ? 0 : value.pages;
    if (!Number.isSafeInteger(pages) || pages < 0) return null;
    rows.set(name, { name, pages, exhausted: value?.exhausted === true });
  }
  return ITEM_BANK_FAN_OUT_SOURCES.filter((name) => rows.has(name)).map((name) => rows.get(name));
}

function normalizeUnreachable(values) {
  if (values === undefined) return [];
  if (!Array.isArray(values)) return null;
  const names = values.map(text);
  return names.every((name) => ENTITY_TYPE.test(name)) ? [...new Set(names)] : null;
}

// Accepts a Date, epoch milliseconds, or an ISO 8601 string that carries a
// timezone. The stored stamp is always UTC, so it always names one instant.
function isoStamp(value) {
  const stamp = value instanceof Date ? value
    : typeof value === "number" ? new Date(value)
      : typeof value === "string" && TIMEZONE.test(value) ? new Date(value)
        : null;
  return stamp && Number.isFinite(stamp.getTime()) ? stamp.toISOString() : null;
}

// The sorted, de-duplicated consumer list, or null when a row is unusable or
// the same course, entity type and entity triple appears twice. A duplicate is
// refused rather than collapsed: it means the enumeration double-counted, and
// this module cannot tell which count is right.
export function normalizeFanOutConsumers(values) {
  if (!Array.isArray(values)) return null;
  const rows = [];
  const seen = new Set();
  for (const value of values) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const consumer = { course_id: text(value.course_id), entity_type: text(value.entity_type), entity_id: text(value.entity_id) };
    if (!COURSE_ID.test(consumer.course_id) || !ENTITY_TYPE.test(consumer.entity_type) || !ENTITY_ID.test(consumer.entity_id)) return null;
    const key = `${consumer.course_id} ${consumer.entity_type} ${consumer.entity_id}`;
    if (seen.has(key)) return null;
    seen.add(key);
    rows.push(consumer);
  }
  return rows.sort(compareConsumers);
}

// The digest covers the normalized list, so the key order, the row order, and a
// numeric id written as a number all give the same answer for the same set.
export async function fanOutDigest(consumers) {
  const normalized = normalizeFanOutConsumers(consumers);
  return normalized === null ? null : digest(normalized);
}

export async function establishFanOut({ bankId, courseId, sources, consumers, unreachable, observedAt }) {
  const bank = text(bankId);
  const course = text(courseId);
  const establishedAt = isoStamp(observedAt);
  const rows = normalizeSources(sources);
  const named = normalizeUnreachable(unreachable);
  const normalized = normalizeFanOutConsumers(consumers);
  if (!ENTITY_ID.test(bank) || !COURSE_ID.test(course) || !establishedAt || rows === null || named === null || normalized === null) return null;
  const unread = [...new Set([...named, "quiz_uses", ...ITEM_BANK_FAN_OUT_SOURCES.filter((name) => !rows.some((row) => row.name === name && row.exhausted))])].sort(compareText);
  const heldRows = rows.map((row) => row.name === "quiz_uses" ? { ...row, exhausted: false } : row);
  return {
    schema: ITEM_BANK_FAN_OUT_SCHEMA,
    bank_id: bank,
    course_id: course,
    established_at: establishedAt,
    sources: heldRows,
    unreachable: unread,
    complete: unread.length === 0,
    consumers: normalized,
    consumer_count: normalized.length,
    external_course_ids: externalCourseIds(normalized, course),
    consumers_sha256: await digest(normalized),
  };
}

// Returns null when the record authorises a change to this bank in this course,
// or the one reason it does not. Each reason is a fixed token so that every
// layer names the same cause; the guard reports it as
// `item_bank_fan_out_<reason>`.
export async function validFanOut(record, { bankId, courseId, acknowledgedCourseIds, now }) {
  const bank = text(bankId);
  const course = text(courseId);
  if (!record || typeof record !== "object" || Array.isArray(record)) return "missing_record";
  if (record.schema !== ITEM_BANK_FAN_OUT_SCHEMA) return "wrong_schema";
  if (!ENTITY_ID.test(bank) || record.bank_id !== bank) return "bank_mismatch";
  if (!COURSE_ID.test(course) || record.course_id !== course) return "course_mismatch";
  // A complete claim would be false because Canvas exposes no authoritative
  // account-wide reverse-use list. The record is usable only as an observed
  // reach disclosure and acknowledgement.
  if (record.complete !== false || unreadSources(record).length === 0) return "authoritative_reach_claim_refused";
  const consumers = normalizeFanOutConsumers(record.consumers);
  if (consumers === null) return "consumers_invalid";
  if (record.consumer_count !== consumers.length) return "consumer_count_mismatch";
  if (!SHA256.test(text(record.consumers_sha256)) || record.consumers_sha256 !== await digest(consumers)) return "consumers_digest_mismatch";
  if (typeof record.established_at !== "string" || !TIMEZONE.test(record.established_at) || !Number.isFinite(Date.parse(record.established_at))) return "established_at_unreadable";
  if (!Number.isFinite(now)) return "record_age_unknown";
  if (Date.parse(record.established_at) > now) return "record_from_future";
  if (now - Date.parse(record.established_at) > ITEM_BANK_FAN_OUT_MAX_AGE_MS) return "record_too_old";
  const external = externalCourseIds(consumers, course);
  if (!sameList(record.external_course_ids, external)) return "external_course_ids_mismatch";
  // The acknowledgement is an exact list, never an omission: a bank that
  // reaches no other course still needs the empty list to be sent.
  if (!Array.isArray(acknowledgedCourseIds) || !sameList([...acknowledgedCourseIds].map(text).sort(compareCourseIds), external)) return "acknowledgement_mismatch";
  return null;
}
