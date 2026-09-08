/**
 * Validate known question shapes before a create or replacement. Canvas
 * validates interaction types without a local checker. Choice, matching,
 * numeric, and rich fill-in-the-blank shapes have local checks; media rules
 * apply to all interaction types.
 *
 * These rules are the same rules as `connector/extension/src/quiz-item-payload.js`,
 * which is the module the Item Banks frame enforces them with. That module
 * cannot be imported here: it is plain JavaScript with no declaration file, and
 * a declaration file cannot live beside it because the Morrow Bridge release
 * ships an exact file set (`BRIDGE_SOURCE_FILES` in
 * `scripts/package-mcp-bundle.mjs`). `test/quiz-item-payload.test.ts` runs both
 * implementations over the one shared case list in
 * `scripts/test/lib/quiz-item-payload-cases.mjs` and requires the same verdict
 * from each, so the two cannot drift apart unnoticed.
 *
 * Everything here is pure: no I/O, no clock, no DOM. It never throws. A payload
 * it accepts returns null; a payload it refuses returns one reason token naming
 * the rule that refused it, and `quizItemPayloadMessage` turns that token into
 * the sentence a person reads.
 *
 * Live-unverified by construction: whether Canvas accepts a payload these rules
 * pass is not established here, and it cannot be. That is the point of the
 * pass-through rule — Canvas is the authority on its own schema.
 */

/** Elements whose `src` the harvest constrains, and the three prefixes it allows. */
const MEDIA_ELEMENTS: readonly string[] = ["img", "audio", "video"];
const MEDIA_SRC_PREFIXES: readonly string[] = ["https://", "/courses/", "/api/v1/files/"];
/** The interaction shapes this file knows how to read. Every other slug passes through. */
const CHOICE_SLUGS: readonly string[] = ["choice", "multiple_choice"];
const CHOICE_INTERACTION_TYPE_ID = 1;
const RICH_FILL_SLUGS: readonly string[] = ["rich_fill_blank", "rich_fill", "rich_fill_in_the_blank"];
/**
 * The three blank kinds the harvest names. A blank that names a kind not listed
 * here is refused rather than sent unchecked, because every other rich fill rule
 * keys off the kind and an unread kind makes the rest of them undecidable.
 */
const BLANK_KINDS: Readonly<Record<string, string>> = { openentry: "openEntry", dropdown: "TextInChoices", textinchoices: "TextInChoices", wordbank: "wordbank" };

const INTERACTION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
/** Comments, and tags whose attribute values may hold a ">" inside quotes. */
const TAG = /<!--[\s\S]*?-->|<(?:"[^"]*"|'[^']*'|[^'">])*>/g;
const TAG_NAME = /^<\s*(\/?)\s*([a-zA-Z][^\s/>]*)/;
/** One attribute with a quoted value, an unquoted value, or no value at all. */
const ATTRIBUTE = /^\s+([A-Za-z_:][-A-Za-z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/;
/** Elements whose content is not markup. A media tag inside one of them is text. */
const RAW_TEXT: readonly string[] = ["script", "style", "iframe", "object", "embed", "textarea", "title"];
const MEDIA_TAG = /<\s*(?:img|audio|video)\b/i;
const BLANK_MARKER = /id\s*=\s*(?:"blank_([^"]*)"|'blank_([^']*)')/g;
/** A question payload is a handful of levels deep. Deeper than this is not one Morrow reads. */
const MAX_DEPTH = 32;

type Plain = Record<string, unknown>;

function plainObject(value: unknown): value is Plain {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Scalars a payload may carry as an id, an answer, or a listed choice. */
function scalar(value: unknown): value is string | number {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

function asText(value: unknown): string {
  return scalar(value) ? String(value) : "";
}

function normalizeSlug(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase().replaceAll(/[\s-]+/g, "_") : "";
}

/**
 * The media elements one HTML string carries, in document order.
 *
 * `open` is true when the string ends inside an element whose content is not
 * markup, which means a media element after it was not seen. The caller treats
 * that as unreadable rather than as an absence.
 */
function mediaElements(value: string): { readonly elements: readonly { readonly name: string; readonly tag: string }[]; readonly open: boolean } {
  const elements: { name: string; tag: string }[] = [];
  let rawText = "";
  for (const match of value.matchAll(TAG)) {
    const tag = match[0];
    if (tag.startsWith("<!--")) continue;
    const parsed = TAG_NAME.exec(tag);
    if (!parsed) continue;
    const closing = parsed[1] === "/";
    const name = (parsed[2] ?? "").toLowerCase();
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
function tagAttributes(tag: string): Map<string, string> | null {
  const open = TAG_NAME.exec(tag);
  if (!open || open[1] === "/" || !tag.endsWith(">")) return null;
  let rest = tag.slice(open[0].length, tag.length - (tag.endsWith("/>") ? 2 : 1));
  const attributes = new Map<string, string>();
  while (rest.trim().length > 0) {
    const match = ATTRIBUTE.exec(rest);
    if (!match) return null;
    const name = (match[1] ?? "").toLowerCase();
    if (attributes.has(name)) return null;
    attributes.set(name, match[2] ?? match[3] ?? match[4] ?? "");
    rest = rest.slice(match[0].length);
  }
  return attributes;
}

/**
 * The media rule for one string: every image names its alternative text, and
 * every media source is one Canvas can serve.
 */
function stringMediaReason(value: string): string | null {
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

/**
 * Media lives in the question body, in every answer body, and in feedback, so
 * the rule runs over every string the payload carries rather than over a list of
 * fields that would go stale the moment Canvas adds one.
 */
function mediaReason(value: unknown, depth: number): string | null {
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

/** Which of the four checked shapes this payload declares, or "" for every other type. */
function interactionKind(entry: Plain, item: Plain): string {
  const slug = normalizeSlug(entry.interaction_type_slug ?? item.interaction_type_slug);
  const typeId = entry.interaction_type_id ?? item.interaction_type_id;
  if (CHOICE_SLUGS.includes(slug)) return "choice";
  if (slug === "matching") return "matching";
  if (slug === "numeric") return "numeric";
  if (RICH_FILL_SLUGS.includes(slug)) return "rich_fill";
  if (!slug && Number(typeId) === CHOICE_INTERACTION_TYPE_ID) return "choice";
  return "";
}

/** A body is blank when it carries neither text nor an image. */
function hasContent(value: unknown): boolean {
  if (!scalar(value)) return false;
  const text = String(value);
  return text.replaceAll(TAG, "").replaceAll("&nbsp;", " ").trim() !== "" || MEDIA_TAG.test(text);
}

/** The ids of one member list, or a reason token naming what was wrong with them. */
function memberIds(rows: readonly unknown[], invalid: string, duplicate: string): string[] | string {
  const ids: string[] = [];
  for (const row of rows) {
    if (!plainObject(row)) return invalid;
    const memberId = asText(row.id);
    if (!INTERACTION_ID.test(memberId)) return invalid;
    if (ids.includes(memberId)) return duplicate;
    ids.push(memberId);
  }
  return ids;
}

function sameIdSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

function choiceReason(interaction: unknown, scoring: unknown): string | null {
  if (!plainObject(interaction) || !Array.isArray(interaction.choices)) return "choice_list_missing";
  if (interaction.choices.length < 2) return "choice_too_few";
  const ids = memberIds(interaction.choices, "choice_id_invalid", "choice_id_duplicate");
  if (!Array.isArray(ids)) return ids;
  for (const choice of interaction.choices) {
    const body = plainObject(choice) ? choice.item_body ?? choice.body : undefined;
    if (!hasContent(body)) return "choice_body_blank";
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

function matchingReason(interaction: unknown, scoring: unknown): string | null {
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
  const editData = scoring.edit_data;
  if (!plainObject(editData) || !Array.isArray(editData.matches)) return "matching_edit_data_matches_missing";
  const matched: string[] = [];
  for (const match of editData.matches) {
    if (!plainObject(match)) return "matching_edit_data_matches_mismatch";
    const questionId = asText(match.question_id ?? match.id);
    if (!questionId || matched.includes(questionId)) return "matching_edit_data_matches_mismatch";
    matched.push(questionId);
  }
  return sameIdSet(matched, ids) ? null : "matching_edit_data_matches_mismatch";
}

function numericReason(interaction: unknown, scoring: unknown): string | null {
  const value = plainObject(scoring) ? scoring.value : undefined;
  if (Array.isArray(value)) {
    // The public New Quiz item contract uses a list of typed numeric responses.
    const ids = memberIds(value, "numeric_response_invalid", "numeric_response_invalid");
    if (!Array.isArray(ids) || ids.length === 0) return "numeric_response_invalid";
    const numeric = (number: unknown): boolean => (typeof number === "number" || (typeof number === "string" && number.trim() !== ""))
      && Number.isFinite(Number(number));
    for (const response of value) {
      if (!plainObject(response)) return "numeric_response_invalid";
      if (response.type === "withinARange") {
        if (!numeric(response.start) || !numeric(response.end) || Number(response.start) > Number(response.end)) return "numeric_response_invalid";
      } else {
        if (!numeric(response.value)) return "numeric_response_invalid";
        if (response.type === "marginOfError") {
          if (!numeric(response.margin) || Number(response.margin) < 0 || !["percent", "absolute"].includes(asText(response.margin_type))) return "numeric_response_invalid";
        } else if (response.type === "preciseResponse") {
          if (!numeric(response.precision) || !Number.isInteger(Number(response.precision)) || Number(response.precision) < 0
            || !["decimals", "significantDigits"].includes(asText(response.precision_type))) return "numeric_response_invalid";
        } else if (response.type !== "exactResponse") return "numeric_response_invalid";
      }
    }
  } else if (value !== undefined && value !== null && (typeof value !== "number" || !Number.isFinite(value))) return "numeric_scoring_value_not_a_number";
  if (!plainObject(interaction)) return null;
  const units = interaction.units;
  if (units !== undefined && units !== null && !(typeof units === "string" && units.trim() !== "")) return "numeric_units_blank";
  const dimensions = interaction.dimensions;
  if (dimensions === undefined || dimensions === null) return null;
  if (!plainObject(dimensions) || Object.keys(dimensions).length === 0) return "numeric_dimensions_invalid";
  for (const bound of ["min", "max", "step"] as const) {
    const held = dimensions[bound];
    if (held === undefined || held === null) continue;
    if (typeof held !== "number" || !Number.isFinite(held)) return "numeric_dimensions_invalid";
  }
  if (typeof dimensions.min === "number" && typeof dimensions.max === "number" && dimensions.min > dimensions.max) return "numeric_dimensions_min_above_max";
  return null;
}

function scoringRow(scoring: unknown, blankId: string): Plain | null {
  const rows = plainObject(scoring) && Array.isArray(scoring.value) ? scoring.value : [];
  return rows.find((row): row is Plain => plainObject(row) && asText(row.id) === blankId) ?? null;
}

/** A scoring row holds the answer either under `scoring_data` or on the row. */
function rowAnswer(row: Plain | null): Plain | null {
  if (row && plainObject(row.scoring_data)) return row.scoring_data;
  return plainObject(row) ? row : null;
}

function blankKind(blank: Plain, row: Plain | null): string {
  const named = normalizeSlug(blank.answer_type ?? blank.blank_type ?? blank.type ?? row?.scoring_algorithm);
  return BLANK_KINDS[named.replaceAll("_", "")] ?? "";
}

/** Every string a listed choice can be named by. */
function choiceTokens(choice: unknown): string[] {
  if (scalar(choice)) return [String(choice)];
  if (!plainObject(choice)) return [];
  return [choice.id, choice.item_body ?? choice.body ?? choice.value ?? choice.text].filter(scalar).map(String);
}

function openEntryReason(blank: Plain, row: Plain | null): string | null {
  const answer = blank.answers ?? rowAnswer(row)?.value;
  const answers = Array.isArray(answer) ? answer : answer === undefined || answer === null ? [] : [answer];
  if (answers.length === 0 || !answers.every((value) => scalar(value) && String(value).trim() !== "")) return "rich_fill_open_entry_answers_missing";
  return null;
}

function textInChoicesReason(blank: Plain, row: Plain | null): string | null {
  const listed = blank.choices ?? rowAnswer(row)?.choices;
  if (!Array.isArray(listed) || listed.length < 2) return "rich_fill_text_in_choices_too_few";
  const tokens = listed.flatMap(choiceTokens);
  const correct = asText(blank.value ?? rowAnswer(row)?.value);
  return correct !== "" && tokens.includes(correct) ? null : "rich_fill_text_in_choices_value_not_listed";
}

function wordBankReason(interaction: Plain, scoring: unknown, itemBody: unknown, ids: readonly string[], wordBankIds: readonly string[]): string | null {
  if (!Array.isArray(interaction.word_bank_choices) || interaction.word_bank_choices.length < 2) return "rich_fill_word_bank_choices_too_few";
  const choiceIds = memberIds(interaction.word_bank_choices, "rich_fill_word_bank_choice_id_invalid", "rich_fill_word_bank_choice_id_duplicate");
  if (!Array.isArray(choiceIds)) return choiceIds;
  if (!plainObject(scoring) || !Array.isArray(scoring.value)) return "rich_fill_scoring_ids_mismatch";
  const scoredIds = memberIds(scoring.value, "rich_fill_scoring_ids_mismatch", "rich_fill_scoring_ids_mismatch");
  if (!Array.isArray(scoredIds) || !sameIdSet(scoredIds, ids)) return "rich_fill_scoring_ids_mismatch";
  const answers: string[] = [];
  for (const blankId of ids) {
    const answer = rowAnswer(scoringRow(scoring, blankId));
    const value = asText(answer?.value);
    if (wordBankIds.includes(blankId)) {
      if (value.trim() === "") return "rich_fill_blank_answer_missing";
      // A word-bank blank must point at the same answer that it reveals.
      if (asText(answer?.blank_text) !== value) return "rich_fill_blank_text_mismatch";
      if (!choiceIds.includes(asText(answer?.choice_id))) return "rich_fill_choice_id_unknown";
    }
    answers.push(asText(answer?.blank_text) || value);
  }
  const markers = [...String(itemBody ?? "").matchAll(BLANK_MARKER)].map((match) => match[1] ?? match[2] ?? "");
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

function richFillReason(interaction: unknown, scoring: unknown, itemBody: unknown): string | null {
  const blanks = plainObject(interaction)
    ? Array.isArray(interaction.blanks) ? interaction.blanks : Array.isArray(interaction.entries) ? interaction.entries : null
    : null;
  if (!blanks || blanks.length === 0 || !plainObject(interaction)) return "rich_fill_blanks_missing";
  const ids = memberIds(blanks, "rich_fill_blank_id_invalid", "rich_fill_blank_id_duplicate");
  if (!Array.isArray(ids)) return ids;
  const kinds = blanks.map((blank, index) => plainObject(blank) ? blankKind(blank, scoringRow(scoring, ids[index] ?? "")) : "");
  if (kinds.includes("")) return "rich_fill_blank_kind_unreadable";
  const wordBankIds = ids.filter((_, index) => kinds[index] === "wordbank");
  if (wordBankIds.length > 0) {
    const reason = wordBankReason(interaction, scoring, itemBody, ids, wordBankIds);
    if (reason) return reason;
  }
  for (const [index, blank] of blanks.entries()) {
    if (!plainObject(blank)) return "rich_fill_blank_id_invalid";
    if (kinds[index] === "wordbank") continue;
    const row = scoringRow(scoring, ids[index] ?? "");
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
 * reason token, not a sentence for a person: `quizItemPayloadMessage` turns it
 * into one.
 *
 * The payload is the question itself, either as a whole item record with its
 * fields under `entry` (`{id, entry_type, entry: {...}}`), or flat. A payload
 * that carries neither `interaction_data` nor `scoring_data` changes nothing
 * this file structurally checks — a title-only or points-only update, for one —
 * so only the media rules run over it.
 */
export function quizItemPayloadReason(item: unknown): string | null {
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

/**
 * The sentence a person reads for one reason token. Each one names the part of
 * the question that is wrong and what to change, because the person who reads
 * it is the person who has to fix the question.
 */
const MESSAGES: Readonly<Record<string, string>> = {
  payload_not_an_object: "The question has to be an object holding entry_type and entry.",
  payload_too_deep: "This question nests deeper than Morrow reads, so Morrow could not check every image in it.",
  media_markup_unreadable: "Morrow could not read the HTML of this question well enough to check its images. Look for an unclosed tag or an unclosed script block.",
  media_image_alt_missing: "One image in this question has no alt attribute. Add alternative text that says what the image shows, or alt=\"\" if the image is decorative.",
  media_src_unsupported: "One image, audio, or video in this question loads from an address Canvas does not serve. Use an https address, a /courses/ path, or an /api/v1/files/ path.",
  choice_list_missing: "A multiple-choice question needs its choices in entry.interaction_data.choices.",
  choice_too_few: "A multiple-choice question needs at least two choices.",
  choice_id_duplicate: "Two choices in this question share one id. New Quizzes matches choices by id, so each choice needs its own.",
  choice_id_invalid: "One choice in this question has no id Morrow can read.",
  choice_body_blank: "One choice in this question has no text and no image in it.",
  choice_scoring_value_not_a_choice_id: "The answer key names a choice this question does not have. Every value in entry.scoring_data has to be one of the choice ids.",
  matching_questions_missing: "A matching question needs its prompts in entry.interaction_data.questions.",
  matching_question_id_duplicate: "Two prompts in this matching question share one id.",
  matching_question_id_invalid: "One prompt in this matching question has no id Morrow can read.",
  matching_scoring_value_not_an_object: "The answer key of a matching question has to be an object keyed by prompt id.",
  matching_scoring_value_keys_mismatch: "The answer key does not name exactly the prompts this matching question holds.",
  matching_edit_data_matches_missing: "A matching question needs entry.scoring_data.edit_data.matches, covering every prompt.",
  matching_edit_data_matches_mismatch: "The match list does not cover exactly the prompts this matching question holds, once each.",
  numeric_scoring_value_not_a_number: "A numeric question needs a number as its answer.",
  numeric_response_invalid: "A numeric response needs a unique id, a supported response type and valid numeric values for that type.",
  numeric_units_blank: "The units on this numeric question are empty. Name the units or leave them out.",
  numeric_dimensions_invalid: "The accepted range on this numeric question needs numbers for the values it names.",
  numeric_dimensions_min_above_max: "The lowest accepted value on this numeric question is above the highest.",
  rich_fill_blanks_missing: "A fill-in-the-blank question needs at least one blank in entry.interaction_data.",
  rich_fill_blank_id_duplicate: "Two blanks in this question share one id.",
  rich_fill_blank_id_invalid: "One blank in this question has no id Morrow can read.",
  rich_fill_blank_kind_unreadable: "Morrow cannot tell what kind one blank is. Morrow reads a typed blank (openEntry), a listed-choice blank (dropdown or TextInChoices), and a word-bank blank.",
  rich_fill_open_entry_answers_missing: "A typed blank needs at least one answer, and no answer may be empty.",
  rich_fill_text_in_choices_too_few: "A listed-choice blank needs at least two choices.",
  rich_fill_text_in_choices_value_not_listed: "The correct value of a listed-choice blank is not one of the choices it lists.",
  rich_fill_word_bank_choices_too_few: "A word bank needs at least two choices.",
  rich_fill_word_bank_choice_id_duplicate: "Two word-bank choices share one id.",
  rich_fill_word_bank_choice_id_invalid: "One word-bank choice has no id Morrow can read.",
  rich_fill_scoring_ids_mismatch: "The word-bank scoring does not name exactly the blanks this question holds.",
  rich_fill_blank_answer_missing: "One word-bank blank has no answer.",
  rich_fill_blank_text_mismatch: "One word-bank blank shows text that is not its own answer.",
  rich_fill_choice_id_unknown: "One word-bank blank points at a choice that is not in the word bank.",
  rich_fill_body_blank_markers_mismatch: "The question body does not mark exactly the blanks this question holds. Each blank needs id=\"blank_<id>\" in the body.",
  rich_fill_working_item_body_answers_out_of_order: "The authoring copy of the body does not carry every answer in backticks in blank order.",
};

/** Every reason token this file can return, so a test can prove each one has a sentence. */
export const QUIZ_ITEM_PAYLOAD_REASONS: readonly string[] = Object.freeze(Object.keys(MESSAGES));

/** The sentence for one reason token. An unmapped token names itself rather than reading as nothing. */
export function quizItemPayloadMessage(reason: string): string {
  return MESSAGES[reason] ?? `Morrow refused this question payload: ${reason}.`;
}
