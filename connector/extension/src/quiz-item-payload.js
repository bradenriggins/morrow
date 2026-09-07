// The check Morrow makes on a New Quizzes question payload before it writes
// one. Section 6 of
// docs/research/CANVAS-NEW-QUIZZES-ITEM-BANKS-CONTRACT-2026-09-06.md is the
// source, and it applies to a proposed update as well as to a create.
//
// The rule that shapes the whole file: a validator that cannot check a shape
// must not forbid it. An earlier hard allowlist of four interaction types made
// ExamplePlatform refuse categorization, multi-answer, essay, true-false, ordering,
// file upload, formula, and hot spot before Canvas ever saw them. On 29 August
// 2026 three items were built and all three were rejected locally, so nobody
// learned what Canvas would have said. A malformed payload that reaches Canvas
// and comes back with a typed provider error is strictly better than telling a
// person a question type does not exist. So four interaction shapes are checked
// here — choice, matching, numeric, and rich fill in the blank — and every
// other interaction type passes through untouched. The media rules run for all
// of them, because an image with no alternative text is a defect in any
// question type and Morrow can see it in every one.
//
// Everything here is pure: no I/O, no clock, no DOM. It never throws. A payload
// it accepts returns null; a payload it refuses returns one reason token naming
// the rule that refused it. `connector/extension/src/item-bank-executor.js`
// copies these rules into the function Chrome injects, because Chrome
// serialises an injected function without its module scope;
// scripts/test/canvas-quiz-item-payload.test.mjs runs both copies over the same
// payloads and fails if they disagree.
//
// Live-unverified by construction: whether Canvas accepts a payload these rules
// pass is not established here, and it cannot be. That is the point of the
// pass-through rule — Canvas is the authority on its own schema.

// Elements whose `src` the harvest constrains, and the three prefixes it
// allows: an absolute https URL, a course file path, or the Canvas files API.
// Everything else — http, data:, a bare host, another tenant — is refused.
const MEDIA_ELEMENTS = Object.freeze(["img", "audio", "video"]);
const MEDIA_SRC_PREFIXES = Object.freeze(["https://", "/courses/", "/api/v1/files/"]);
// The interaction shapes this file knows how to read. Every other slug and
// every other interaction_type_id passes through.
const CHOICE_SLUGS = Object.freeze(["choice", "multiple_choice"]);
const CHOICE_INTERACTION_TYPE_ID = 1;
const RICH_FILL_SLUGS = Object.freeze(["rich_fill_blank", "rich_fill", "rich_fill_in_the_blank"]);
// The three blank kinds the harvest names. A blank names its kind in one of
// `answer_type`, `blank_type`, or `type`, or in the `scoring_algorithm` of its
// scoring row, read case-insensitively and without separators.
//
// A blank that names a kind not listed here is refused rather than sent
// unchecked. Every other rich fill rule keys off the kind — which blanks need
// answers, which need listed choices, and whether the question uses a word
// bank at all — so an unread kind makes the rest of them undecidable. The limit
// this leaves is real and visible in the reason token: a rich fill payload that
// names its blanks some other way is refused here rather than by Canvas.
const BLANK_KINDS = Object.freeze({ openentry: "openEntry", textinchoices: "TextInChoices", wordbank: "wordbank" });

const INTERACTION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
// Comments, and tags whose attribute values may hold a ">" inside quotes. The
// same scanner shape as the Item Bank guard at item-bank-guard.js:48.
const TAG = /<!--[\s\S]*?-->|<(?:"[^"]*"|'[^']*'|[^'">])*>/g;
const TAG_NAME = /^<\s*(\/?)\s*([a-zA-Z][^\s/>]*)/;
// One attribute with a quoted value, an unquoted value, or no value at all.
// The Item Bank guard reads quoted values only, because it rewrites the tag and
// an unquoted value makes the self-closing "/" ambiguous. This file only reads
// the tag, so an unquoted value is read rather than treated as unreadable.
const ATTRIBUTE = /^\s+([A-Za-z_:][-A-Za-z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/;
// Elements whose content is not markup. A media tag written inside one of them
// is text, not an image, so the scan skips it.
const RAW_TEXT = Object.freeze(["script", "style", "iframe", "object", "embed", "textarea", "title"]);
const MEDIA_TAG = /<\s*(?:img|audio|video)\b/i;
const BLANK_MARKER = /id\s*=\s*(?:"blank_([^"]*)"|'blank_([^']*)')/g;
// A question payload is a handful of levels deep. Anything deeper than this is
// not a question Morrow can read, and an unread branch could carry an image.
const MAX_DEPTH = 32;

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// Scalars a payload may carry as an id, an answer, or a listed choice. An
// object in one of those places is not a value this file can compare.
function scalar(value) {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

function asText(value) {
  return scalar(value) ? String(value) : "";
}

function normalizeSlug(value) {
  return typeof value === "string" ? value.trim().toLowerCase().replaceAll(/[\s-]+/g, "_") : "";
}

/**
 * The media elements one HTML string carries, in document order.
 *
 * `open` is true when the string ends inside an element whose content is not
 * markup, which means a media element after it was not seen. The caller treats
 * that as unreadable rather than as an absence.
 */
function mediaElements(value) {
  const elements = [];
  let rawText = "";
  for (const match of value.matchAll(TAG)) {
    const tag = match[0];
    if (tag.startsWith("<!--")) continue;
    const parsed = TAG_NAME.exec(tag);
    if (!parsed) continue;
    const closing = parsed[1] === "/";
    const name = parsed[2].toLowerCase();
    if (rawText) {
      if (closing && name === rawText) rawText = "";
      continue;
    }
    if (RAW_TEXT.includes(name)) {
      if (!closing && !tag.endsWith("/>")) rawText = name;
      continue;
    }
    if (closing || !MEDIA_ELEMENTS.includes(name)) continue;
    elements.push({ name, tag });
  }
  return { elements, open: rawText !== "" };
}

/** The attributes of one opening tag, lowercased, or null when it cannot be read. */
function tagAttributes(tag) {
  const open = TAG_NAME.exec(tag);
  if (!open || open[1] === "/" || !tag.endsWith(">")) return null;
  let rest = tag.slice(open[0].length, tag.length - (tag.endsWith("/>") ? 2 : 1));
  const attributes = new Map();
  while (rest.trim().length > 0) {
    const match = ATTRIBUTE.exec(rest);
    if (!match) return null;
    const name = match[1].toLowerCase();
    if (attributes.has(name)) return null;
    attributes.set(name, match[2] ?? match[3] ?? match[4] ?? "");
    rest = rest.slice(match[0].length);
  }
  return attributes;
}

/**
 * The media rule for one string: every image names its alternative text, and
 * every media source is one Canvas can serve.
 *
 * A string with no media element in it is not markup this rule reads, so it
 * returns null without parsing.
 */
function stringMediaReason(value) {
  if (!MEDIA_TAG.test(value)) return null;
  const scan = mediaElements(value);
  if (scan.open) return "media_markup_unreadable";
  for (const element of scan.elements) {
    const attributes = tagAttributes(element.tag);
    if (!attributes) return "media_markup_unreadable";
    // Presence, not content: `alt=""` is how a decorative image is marked, and
    // it is the author's answer rather than a missing one.
    if (element.name === "img" && !attributes.has("alt")) return "media_image_alt_missing";
    const source = attributes.get("src");
    if (source !== undefined && !MEDIA_SRC_PREFIXES.some((prefix) => source.startsWith(prefix))) return "media_src_unsupported";
  }
  return null;
}

// Media lives in the question body, in every answer body, and in feedback, so
// the rule runs over every string the payload carries rather than over a list
// of fields that would go stale the moment Canvas adds one.
function mediaReason(value, depth) {
  if (depth > MAX_DEPTH) return "payload_too_deep";
  if (typeof value === "string") return stringMediaReason(value);
  if (Array.isArray(value)) {
    for (const member of value) {
      const reason = mediaReason(member, depth + 1);
      if (reason) return reason;
    }
    return null;
  }
  if (plainObject(value)) {
    for (const child of Object.values(value)) {
      const reason = mediaReason(child, depth + 1);
      if (reason) return reason;
    }
  }
  return null;
}

/**
 * Which of the four checked shapes this payload declares, or "" for every other
 * interaction type.
 */
function interactionKind(entry, item) {
  const slug = normalizeSlug(entry.interaction_type_slug ?? item.interaction_type_slug);
  const typeId = entry.interaction_type_id ?? item.interaction_type_id;
  if (CHOICE_SLUGS.includes(slug)) return "choice";
  if (slug === "matching") return "matching";
  if (slug === "numeric") return "numeric";
  if (RICH_FILL_SLUGS.includes(slug)) return "rich_fill";
  if (!slug && Number(typeId) === CHOICE_INTERACTION_TYPE_ID) return "choice";
  return "";
}

// A body is blank when it carries neither text nor an image. An answer that is
// only an image is a real answer, so it is not blank.
function hasContent(value) {
  if (!scalar(value)) return false;
  const text = String(value);
  return text.replaceAll(TAG, "").replaceAll("&nbsp;", " ").trim() !== "" || MEDIA_TAG.test(text);
}

/** The ids of one member list, or a reason token naming what was wrong with them. */
function memberIds(rows, invalid, duplicate) {
  const ids = [];
  for (const row of rows) {
    if (!plainObject(row)) return invalid;
    const memberId = asText(row.id);
    if (!INTERACTION_ID.test(memberId)) return invalid;
    if (ids.includes(memberId)) return duplicate;
    ids.push(memberId);
  }
  return ids;
}

function sameIdSet(left, right) {
  return left.length === right.length && left.every((value) => right.includes(value));
}

function choiceReason(interaction, scoring) {
  if (!plainObject(interaction) || !Array.isArray(interaction.choices)) return "choice_list_missing";
  if (interaction.choices.length < 2) return "choice_too_few";
  const ids = memberIds(interaction.choices, "choice_id_invalid", "choice_id_duplicate");
  if (!Array.isArray(ids)) return ids;
  for (const choice of interaction.choices) {
    if (!hasContent(choice.item_body ?? choice.body)) return "choice_body_blank";
  }
  // The answer key names choices by id, as one id or as a list of them. A key
  // that names an id no choice carries marks the wrong answer correct.
  const value = plainObject(scoring) ? scoring.value : undefined;
  if (value === undefined || value === null) return null;
  const members = Array.isArray(value) ? value : [value];
  if (members.length === 0) return "choice_scoring_value_not_a_choice_id";
  for (const member of members) {
    if (!ids.includes(asText(member))) return "choice_scoring_value_not_a_choice_id";
  }
  return null;
}

function matchingReason(interaction, scoring) {
  if (!plainObject(interaction) || !Array.isArray(interaction.questions) || interaction.questions.length === 0) return "matching_questions_missing";
  const ids = memberIds(interaction.questions, "matching_question_id_invalid", "matching_question_id_duplicate");
  if (!Array.isArray(ids)) return ids;
  if (!plainObject(scoring)) return null;
  // The inline New Quiz convention that matching ids must read q-1..q-N is not
  // applied here. The harvest is explicit that it does not transfer to a bank
  // payload, where only presence and uniqueness are checkable.
  if (!plainObject(scoring.value)) return "matching_scoring_value_not_an_object";
  if (!sameIdSet(Object.keys(scoring.value), ids)) return "matching_scoring_value_keys_mismatch";
  // Live-unverified: whether Canvas would accept a matching payload with no
  // edit_data is not established. The harvest requires the match list to cover
  // every question, and Morrow keeps that requirement.
  if (!plainObject(scoring.edit_data) || !Array.isArray(scoring.edit_data.matches)) return "matching_edit_data_matches_missing";
  const matched = [];
  for (const match of scoring.edit_data.matches) {
    if (!plainObject(match)) return "matching_edit_data_matches_mismatch";
    const questionId = asText(match.question_id ?? match.id);
    if (!questionId || matched.includes(questionId)) return "matching_edit_data_matches_mismatch";
    matched.push(questionId);
  }
  return sameIdSet(matched, ids) ? null : "matching_edit_data_matches_mismatch";
}

function numericReason(interaction, scoring) {
  const value = plainObject(scoring) ? scoring.value : undefined;
  // `typeof true` is "boolean" in JavaScript, so a boolean cannot reach the
  // number check here. The harvest names the boolean case because in Python,
  // where the harvested validator ran, a boolean is a kind of integer and would
  // have passed one.
  if (value !== undefined && value !== null && (typeof value !== "number" || !Number.isFinite(value))) return "numeric_scoring_value_not_a_number";
  if (!plainObject(interaction)) return null;
  const units = interaction.units;
  if (units !== undefined && units !== null && !(typeof units === "string" && units.trim() !== "")) return "numeric_units_blank";
  const dimensions = interaction.dimensions;
  if (dimensions === undefined || dimensions === null) return null;
  if (!plainObject(dimensions) || Object.keys(dimensions).length === 0) return "numeric_dimensions_invalid";
  for (const bound of ["min", "max", "step"]) {
    const held = dimensions[bound];
    if (held === undefined || held === null) continue;
    if (typeof held !== "number" || !Number.isFinite(held)) return "numeric_dimensions_invalid";
  }
  if (typeof dimensions.min === "number" && typeof dimensions.max === "number" && dimensions.min > dimensions.max) return "numeric_dimensions_min_above_max";
  return null;
}

function scoringRow(scoring, blankId) {
  const rows = plainObject(scoring) && Array.isArray(scoring.value) ? scoring.value : [];
  return rows.find((row) => plainObject(row) && asText(row.id) === blankId) ?? null;
}

// A scoring row holds the answer either under `scoring_data` or on the row.
function rowAnswer(row) {
  return plainObject(row?.scoring_data) ? row.scoring_data : plainObject(row) ? row : null;
}

function blankKind(blank, row) {
  const named = normalizeSlug(blank.answer_type ?? blank.blank_type ?? blank.type ?? row?.scoring_algorithm);
  return BLANK_KINDS[named.replaceAll("_", "")] ?? "";
}

// Every string a listed choice can be named by: the value itself when it is a
// scalar, and both the id and the body when it is an object.
function choiceTokens(choice) {
  if (scalar(choice)) return [String(choice)];
  if (!plainObject(choice)) return [];
  return [choice.id, choice.item_body ?? choice.body ?? choice.value ?? choice.text].filter(scalar).map(String);
}

function openEntryReason(blank, row) {
  const answer = blank.answers ?? rowAnswer(row)?.value;
  const answers = Array.isArray(answer) ? answer : answer === undefined || answer === null ? [] : [answer];
  if (answers.length === 0 || !answers.every((value) => scalar(value) && String(value).trim() !== "")) return "rich_fill_open_entry_answers_missing";
  return null;
}

function textInChoicesReason(blank, row) {
  const listed = blank.choices ?? rowAnswer(row)?.choices;
  if (!Array.isArray(listed) || listed.length < 2) return "rich_fill_text_in_choices_too_few";
  const tokens = listed.flatMap(choiceTokens);
  const correct = asText(blank.value ?? rowAnswer(row)?.value);
  return correct !== "" && tokens.includes(correct) ? null : "rich_fill_text_in_choices_value_not_listed";
}

function wordBankReason(interaction, scoring, itemBody, ids) {
  if (!Array.isArray(interaction.word_bank_choices) || interaction.word_bank_choices.length < 2) return "rich_fill_word_bank_choices_too_few";
  const choiceIds = memberIds(interaction.word_bank_choices, "rich_fill_word_bank_choice_id_invalid", "rich_fill_word_bank_choice_id_duplicate");
  if (!Array.isArray(choiceIds)) return choiceIds;
  if (!plainObject(scoring) || !Array.isArray(scoring.value)) return "rich_fill_scoring_ids_mismatch";
  const scoredIds = memberIds(scoring.value, "rich_fill_scoring_ids_mismatch", "rich_fill_scoring_ids_mismatch");
  if (!Array.isArray(scoredIds) || !sameIdSet(scoredIds, ids)) return "rich_fill_scoring_ids_mismatch";
  const answers = [];
  for (const blankId of ids) {
    const answer = rowAnswer(scoringRow(scoring, blankId));
    const value = asText(answer?.value);
    if (value.trim() === "") return "rich_fill_blank_answer_missing";
    // The learner sees the word bank; `blank_text` is what the blank shows when
    // the answer is revealed, so it has to be that answer and not another word.
    if (asText(answer.blank_text) !== value) return "rich_fill_blank_text_mismatch";
    if (!choiceIds.includes(asText(answer.choice_id))) return "rich_fill_choice_id_unknown";
    answers.push(value);
  }
  const markers = [...String(itemBody ?? "").matchAll(BLANK_MARKER)].map((match) => match[1] ?? match[2]);
  if (!sameIdSet([...new Set(markers)], ids)) return "rich_fill_body_blank_markers_mismatch";
  // The working body is the authoring copy: every answer appears in backticks
  // where its blank sits, so the order carries the pairing.
  const working = typeof scoring.working_item_body === "string" ? scoring.working_item_body : "";
  let cursor = 0;
  for (const answer of answers) {
    const found = working.indexOf(`\`${answer}\``, cursor);
    if (found < 0) return "rich_fill_working_item_body_answers_out_of_order";
    cursor = found + answer.length + 2;
  }
  return null;
}

function richFillReason(interaction, scoring, itemBody) {
  const blanks = plainObject(interaction)
    ? Array.isArray(interaction.blanks) ? interaction.blanks : Array.isArray(interaction.entries) ? interaction.entries : null
    : null;
  if (!blanks || blanks.length === 0) return "rich_fill_blanks_missing";
  const ids = memberIds(blanks, "rich_fill_blank_id_invalid", "rich_fill_blank_id_duplicate");
  if (!Array.isArray(ids)) return ids;
  const kinds = blanks.map((blank, index) => blankKind(blank, scoringRow(scoring, ids[index])));
  if (kinds.includes("")) return "rich_fill_blank_kind_unreadable";
  // A word bank is one shared list for the whole question. Mixing it with a
  // typed or a listed blank leaves the other blanks pointing at nothing.
  const wordBank = kinds.includes("wordbank");
  if (wordBank && kinds.some((kind) => kind !== "wordbank")) return "rich_fill_word_bank_mixed_with_other_blanks";
  if (wordBank) return wordBankReason(interaction, scoring, itemBody, ids);
  for (const [index, blank] of blanks.entries()) {
    const row = scoringRow(scoring, ids[index]);
    const reason = kinds[index] === "openEntry" ? openEntryReason(blank, row) : textInChoicesReason(blank, row);
    if (reason) return reason;
  }
  return null;
}

/**
 * Checks one New Quizzes question payload and names the rule that refuses it.
 *
 * Returns null when Morrow has nothing to object to, which includes every
 * interaction type this file does not know how to read. A returned string is a
 * reason token, not a sentence for a person: the caller names the surface it
 * refused on.
 *
 * The payload is the question itself, either as a whole item record with its
 * fields under `entry` (`{id, entry_type, entry: {...}}`), or flat. A payload that carries neither
 * `interaction_data` nor `scoring_data` changes nothing this file structurally
 * checks — a title-only or points-only update, for one — so only the media
 * rules run over it.
 */
export function validateQuizItemPayload(item) {
  if (!plainObject(item)) return "payload_not_an_object";
  const entry = plainObject(item.entry) ? item.entry : item;
  const media = mediaReason(item, 0);
  if (media) return media;
  const kind = interactionKind(entry, item);
  if (!kind) return null;
  const interaction = entry.interaction_data;
  const scoring = entry.scoring_data;
  if ((interaction === undefined || interaction === null) && (scoring === undefined || scoring === null)) return null;
  if (kind === "choice") return choiceReason(interaction, scoring);
  if (kind === "matching") return matchingReason(interaction, scoring);
  if (kind === "numeric") return numericReason(interaction, scoring);
  return richFillReason(interaction, scoring, entry.item_body);
}
