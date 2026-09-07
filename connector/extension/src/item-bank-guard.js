// The Item Bank analogue of the Canvas content guard in
// connector/extension/src/canvas-content.js. One selected image in one Item
// Bank question receives alternative text. Nothing else about the question may
// change, and the change is refused unless the question Morrow reads in the
// Item Banks frame is byte-for-byte the one the repair was planned against.
//
// An Item Bank question is shared machinery, so this guard carries the fan-out
// record from ./item-bank-fan-out.js as well: the courses the bank reaches, and
// the acknowledgement of every course outside the selected one. Section 4 of
// docs/research/CANVAS-NEW-QUIZZES-ITEM-BANKS-CONTRACT-2026-09-06.md makes that
// record the precondition for changing an existing bank.
//
// Everything here is pure: no I/O, no clock, no DOM. It never throws. A value
// it cannot use returns null or a reason token. The Item Banks frame runs in
// the page's own MAIN world, where page script owns the HTML parser, so the
// image repair is a string operation over the exact stored body rather than a
// parse-and-reserialise. `connector/extension/src/item-bank-executor.js` copies
// these rules into the function Chrome injects, because Chrome serialises an
// injected function without its module scope;
// scripts/test/canvas-item-bank-guard.test.mjs executes both copies over the
// same fixtures and fails if they disagree.
//
// Live-unverified: no Morrow-connected tenant has answered
// GET /api/banks/{bank_id}/items/{item_id}. The item shape used here — `id`,
// `entry_type: "Item"`, `entry.item_body`, `entry.interaction_data` — is the
// New Quizzes item shape the harvest describes, and it stays unproven against a
// real bank.

export const ITEM_BANK_GUARD_KIND = "item_bank_entry_image_alt";
export const ITEM_BANK_GUARD_FIELDS = Object.freeze([
  "kind", "course_id", "bank_id", "bank_entry_id", "item_id", "entry_type",
  "item_sha256", "protected_state_sha256", "image_index", "image_src_sha256",
  "alt_text", "fan_out", "acknowledged_course_ids",
]);
// An item body longer than this is not a question, and the tag scan below is
// linear only over a bounded string.
export const ITEM_BANK_MAX_ITEM_BODY = 200_000;
// The four interaction_data collections whose element ids New Quizzes merges
// on. Section 2.2 of the contract document: a write that regenerates one of
// these ids orphans the old element into a blank ghost stub.
const INTERACTION_ID_GROUPS = Object.freeze(["choices", "questions", "blanks", "entries"]);

const COURSE_ID = /^[1-9][0-9]*$/;
const ENTITY_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const INTERACTION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const SHA256 = /^[0-9a-f]{64}$/;
// Comments, and tags whose attribute values may hold a ">" inside quotes. The
// same scanner shape as the Page repair at canvas-content.js:110.
const TAG = /<!--[\s\S]*?-->|<(?:"[^"]*"|'[^']*'|[^'">])*>/g;
const TAG_NAME = /^<\s*(\/?)\s*([a-zA-Z][^\s/>]*)/;
// One attribute with a quoted value, or a bare attribute. An unquoted value is
// not read: it would make the self-closing "/" ambiguous with a "/" at the end
// of an unquoted URL, and the alt would be inserted in the wrong place.
const ATTRIBUTE = /^\s+([A-Za-z_:][-A-Za-z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/;
// Elements whose content is not markup, and elements whose images are not
// content images. contentImages() in canvas-content.js drops the same two
// subtrees with closest("svg, math").
const RAW_TEXT = Object.freeze(["script", "style", "iframe", "object", "embed", "textarea", "title"]);
const IMAGELESS_SUBTREE = Object.freeze(["svg", "math"]);

// Copied from connector/extension/src/item-bank-fan-out.js, which copied it
// from connector/extension/src/edit-policy.js. All three must produce the same
// bytes for the same value; the guard test digests one value through this
// module and through fanOutDigest to prove it.
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  return JSON.stringify(value === undefined ? null : value);
}

async function digest(text) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

const plain = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const decimal = (value) => typeof value === "string" && COURSE_ID.test(value);
const identifier = (value) => typeof value === "string" && ENTITY_ID.test(value);
const sha256 = (value) => typeof value === "string" && SHA256.test(value);
const compareText = (a, b) => a < b ? -1 : a > b ? 1 : 0;

// Exactly the escaping the Page repair uses, so an alt attribute Morrow writes
// carries the person's text and never new markup.
export function escapeItemBankAlt(value) {
  return value.replaceAll("&", "&amp;").replaceAll("\"", "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function validItemBankGuard(guard) {
  if (!plain(guard)) return false;
  const keys = Object.keys(guard);
  if (keys.length !== ITEM_BANK_GUARD_FIELDS.length || ITEM_BANK_GUARD_FIELDS.some((field) => !keys.includes(field))) return false;
  const acknowledged = guard.acknowledged_course_ids;
  return guard.kind === ITEM_BANK_GUARD_KIND
    && guard.entry_type === "Item"
    && decimal(guard.course_id)
    && identifier(guard.bank_id) && identifier(guard.bank_entry_id) && identifier(guard.item_id)
    && sha256(guard.item_sha256) && sha256(guard.protected_state_sha256)
    && Number.isSafeInteger(guard.image_index) && guard.image_index >= 1
    && sha256(guard.image_src_sha256)
    && typeof guard.alt_text === "string" && guard.alt_text.trim().length > 0 && guard.alt_text.length <= 500
    && plain(guard.fan_out)
    && Array.isArray(acknowledged) && acknowledged.every(decimal) && new Set(acknowledged).size === acknowledged.length;
}

// The digest the guard pins the whole current question with. Every later check
// reads the item this digest matched, so the body offsets, the interaction ids
// and the protected state are all taken from the same bytes.
export async function itemBankItemDigest(item) {
  return await digest(stable(item));
}

// The question with the one field this repair may change removed, plus the
// timestamps the provider owns. Its digest is what proves that a proposed
// question differs from the stored one in the image body alone.
export function itemBankProtectedState(item) {
  if (!plain(item) || !plain(item.entry) || typeof item.entry.item_body !== "string") return null;
  const state = structuredClone(item);
  delete state.entry.item_body;
  delete state.entry.updated_at;
  delete state.updated_at;
  return state;
}

export async function itemBankProtectedStateDigest(item) {
  const state = itemBankProtectedState(item);
  return state === null ? null : await digest(stable(state));
}

// The sorted interaction element ids, [] when the question has none, or null
// when a collection is present in a shape this rule cannot read. An unreadable
// interaction is refused rather than assumed unchanged.
export function itemBankInteractionIds(item) {
  if (!plain(item) || !plain(item.entry)) return null;
  const interaction = item.entry.interaction_data;
  if (interaction === undefined || interaction === null) return [];
  if (!plain(interaction)) return null;
  const ids = [];
  for (const group of INTERACTION_ID_GROUPS) {
    const rows = interaction[group];
    if (rows === undefined || rows === null) continue;
    if (!Array.isArray(rows)) return null;
    for (const row of rows) {
      if (!plain(row) || typeof row.id !== "string" || !INTERACTION_ID.test(row.id)) return null;
      ids.push(`${group}:${row.id}`);
    }
  }
  return new Set(ids).size === ids.length ? ids.sort(compareText) : null;
}

export function sameItemBankInteractionIds(left, right) {
  return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length && left.every((id, index) => id === right[index]);
}

// Section 3.3 of the contract document: an entry row is not an item. The row
// links to the wanted item when it is an Item entry and either its entry_id or
// an embedded item's own id is that item.
export function itemBankEntryLinksItem(entry, itemId) {
  if (!plain(entry) || !identifier(itemId) || entry.entry_type !== "Item") return false;
  if (typeof entry.entry_id === "string" && entry.entry_id === itemId) return true;
  for (const key of ["item", "entry", "current_version", "data"]) {
    const value = entry[key];
    if (!plain(value)) continue;
    if (typeof value.id === "string" && value.id === itemId) return true;
    for (const nested of ["item", "data"]) {
      const inner = value[nested];
      if (plain(inner) && typeof inner.id === "string" && inner.id === itemId) return true;
    }
  }
  return false;
}

// Every <img> the repair may count, in document order, with the exact byte
// range of its tag. `open` reports markup this scan did not finish reading, so
// an unclosed <script> or <svg> refuses the repair instead of miscounting it.
export function itemBankContentImages(body) {
  const images = [];
  let rawText = "";
  let imagelessDepth = 0;
  for (const match of body.matchAll(TAG)) {
    const tag = match[0];
    if (tag.startsWith("<!--")) continue;
    const parsed = TAG_NAME.exec(tag);
    if (!parsed) continue;
    const closing = parsed[1] === "/";
    const element = parsed[2].toLowerCase();
    if (rawText) {
      if (closing && element === rawText) rawText = "";
      continue;
    }
    if (RAW_TEXT.includes(element)) {
      if (!closing && !tag.endsWith("/>")) rawText = element;
      continue;
    }
    if (IMAGELESS_SUBTREE.includes(element)) {
      if (closing) imagelessDepth = Math.max(0, imagelessDepth - 1);
      else if (!tag.endsWith("/>")) imagelessDepth += 1;
      continue;
    }
    if (element !== "img" || closing || imagelessDepth > 0) continue;
    images.push({ start: match.index, end: match.index + tag.length - 1, tag });
  }
  return { images, open: rawText !== "" || imagelessDepth > 0 };
}

// The attributes of one image tag as they are written in the body, or null when
// the tag is not one readable <img>. Values are not entity-decoded: the guard's
// image_src_sha256 is the digest of the exact src text in the stored body.
export function itemBankImageAttributes(tag) {
  const open = /^<\s*img/i.exec(tag);
  if (!open || !tag.endsWith(">")) return null;
  const suffix = tag.endsWith("/>") ? 2 : 1;
  let rest = tag.slice(open[0].length, tag.length - suffix);
  const attributes = new Map();
  while (rest.trim().length > 0) {
    const match = ATTRIBUTE.exec(rest);
    if (!match) return null;
    const name = match[1].toLowerCase();
    if (attributes.has(name)) return null;
    attributes.set(name, match[2] ?? match[3] ?? "");
    rest = rest.slice(match[0].length);
  }
  return attributes;
}

/**
 * Adds the guard's alternative text to the one selected image, or names the one
 * reason it will not. Returns `{ body }` or `{ error }`; it never throws.
 *
 * The refusals are the Page repair's refusals: an image that moved, an image
 * that already carries alternative text, and a source the guard cannot name
 * uniquely.
 */
export async function applyItemBankImageAlt(body, guard) {
  if (typeof body !== "string" || body.length === 0 || body.length > ITEM_BANK_MAX_ITEM_BODY) {
    return { error: "item_bank_image_alt_body_unusable" };
  }
  const before = itemBankContentImages(body);
  if (before.open) return { error: "item_bank_image_alt_markup_unreadable" };
  const selected = before.images[guard.image_index - 1];
  if (!selected) return { error: "item_bank_image_alt_target_missing" };
  const attributes = itemBankImageAttributes(selected.tag);
  if (!attributes) return { error: "item_bank_image_alt_markup_unreadable" };
  const source = attributes.get("src");
  if (typeof source !== "string" || source.length === 0 || await digest(source) !== guard.image_src_sha256) {
    return { error: "item_bank_image_alt_target_changed" };
  }
  if (attributes.has("alt")) return { error: "item_bank_image_alt_already_present" };
  let matches = 0;
  for (const image of before.images) {
    const other = itemBankImageAttributes(image.tag);
    if (!other) return { error: "item_bank_image_alt_markup_unreadable" };
    if (typeof other.get("src") === "string" && await digest(other.get("src")) === guard.image_src_sha256) matches += 1;
  }
  if (matches !== 1) return { error: "item_bank_image_alt_ambiguous" };
  const suffix = selected.tag.endsWith("/>") ? "/>" : ">";
  const alt = escapeItemBankAlt(guard.alt_text);
  const tag = `${selected.tag.slice(0, selected.tag.length - suffix.length)} alt="${alt}"${suffix}`;
  const next = `${body.slice(0, selected.start)}${tag}${body.slice(selected.end + 1)}`;
  // The same scan over the result: one image gained one attribute, every other
  // image tag is the byte range it was, and nothing else parses differently.
  const after = itemBankContentImages(next);
  const changed = after.images[guard.image_index - 1];
  const changedAttributes = changed ? itemBankImageAttributes(changed.tag) : null;
  if (after.open || after.images.length !== before.images.length || !changedAttributes
    || changedAttributes.size !== attributes.size + 1
    || changedAttributes.get("alt") !== alt
    || [...attributes].some(([name, value]) => changedAttributes.get(name) !== value)
    || after.images.some((image, index) => index !== guard.image_index - 1 && image.tag !== before.images[index].tag)) {
    return { error: "item_bank_image_alt_body_mismatch" };
  }
  return { body: next };
}

// True when the saved body carries the guard's alternative text on the selected
// image and the same source. The alt is compared in its escaped form, because
// that is what the repair wrote into the body.
export async function itemBankImageAltPresent(body, guard) {
  if (typeof body !== "string" || body.length > ITEM_BANK_MAX_ITEM_BODY) return false;
  const scan = itemBankContentImages(body);
  if (scan.open) return false;
  const image = scan.images[guard.image_index - 1];
  const attributes = image ? itemBankImageAttributes(image.tag) : null;
  if (!attributes || attributes.get("alt") !== escapeItemBankAlt(guard.alt_text)) return false;
  const source = attributes.get("src");
  return typeof source === "string" && await digest(source) === guard.image_src_sha256;
}
