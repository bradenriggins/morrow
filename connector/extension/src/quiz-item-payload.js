/**
 * Validate the complete documented shape of all 12 New Quiz question types
 * before a create or replacement. Every supported type fails closed against
 * its structure, scoring references, feedback, properties, and media rules.
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
 * local contract: Canvas remains the authority on whether it accepts a payload.
 */
/** Elements whose `src` the harvest constrains, and the three prefixes it allows. */
const MEDIA_ELEMENTS = ["img", "audio", "video"];
const MEDIA_SRC_PREFIXES = ["https://", "/courses/", "/api/v1/files/"];
/** The interaction shapes this file knows how to read. Every other slug passes through. */
const CHOICE_SLUGS = ["choice", "multiple_choice"];
const CHOICE_INTERACTION_TYPE_ID = 1;
const RICH_FILL_SLUGS = ["rich_fill_blank", "rich_fill", "rich_fill_in_the_blank"];
/**
 * The three blank kinds the harvest names. A blank that names a kind not listed
 * here is refused rather than sent unchecked, because every other rich fill rule
 * keys off the kind and an unread kind makes the rest of them undecidable.
 */
const BLANK_KINDS = { openentry: "openEntry", dropdown: "TextInChoices", textinchoices: "TextInChoices", wordbank: "wordbank" };
const INTERACTION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** Comments, and tags whose attribute values may hold a ">" inside quotes. */
const TAG = /<!--[\s\S]*?-->|<(?:"[^"]*"|'[^']*'|[^'">])*>/g;
const TAG_NAME = /^<\s*(\/?)\s*([a-zA-Z][^\s/>]*)/;
/** One attribute with a quoted value, an unquoted value, or no value at all. */
const ATTRIBUTE = /^\s+([A-Za-z_:][-A-Za-z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/;
/** Elements whose content is not markup. A media tag inside one of them is text. */
const RAW_TEXT = ["script", "style", "iframe", "object", "embed", "textarea", "title"];
const MEDIA_TAG = /<\s*(?:img|audio|video)\b/i;
const BLANK_MARKER = /id\s*=\s*(?:"blank_([^"]*)"|'blank_([^']*)')/g;
/** A question payload is a handful of levels deep. Deeper than this is not one Morrow reads. */
const MAX_DEPTH = 32;
function plainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
/** Scalars a payload may carry as an id, an answer, or a listed choice. */
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
        if (tag.startsWith("<!--"))
            continue;
        const parsed = TAG_NAME.exec(tag);
        if (!parsed)
            continue;
        const closing = parsed[1] === "/";
        const name = (parsed[2] ?? "").toLowerCase();
        if (rawText) {
            if (closing && name === rawText)
                rawText = "";
            continue;
        }
        if (RAW_TEXT.includes(name)) {
            if (!closing && !tag.endsWith("/>"))
                rawText = name;
            continue;
        }
        if (closing || !MEDIA_ELEMENTS.includes(name))
            continue;
        elements.push({ name, tag });
    }
    return { elements, open: rawText !== "" };
}
/** The attributes of one opening tag, lowercased, or null when it cannot be read. */
function tagAttributes(tag) {
    const open = TAG_NAME.exec(tag);
    if (!open || open[1] === "/" || !tag.endsWith(">"))
        return null;
    let rest = tag.slice(open[0].length, tag.length - (tag.endsWith("/>") ? 2 : 1));
    const attributes = new Map();
    while (rest.trim().length > 0) {
        const match = ATTRIBUTE.exec(rest);
        if (!match)
            return null;
        const name = (match[1] ?? "").toLowerCase();
        if (attributes.has(name))
            return null;
        attributes.set(name, match[2] ?? match[3] ?? match[4] ?? "");
        rest = rest.slice(match[0].length);
    }
    return attributes;
}
/**
 * The media rule for one string: every image names its alternative text, and
 * every media source is one Canvas can serve.
 */
function stringMediaReason(value) {
    if (!MEDIA_TAG.test(value))
        return null;
    const scan = mediaElements(value);
    if (scan.open)
        return "media_markup_unreadable";
    for (const element of scan.elements) {
        const attributes = tagAttributes(element.tag);
        if (!attributes)
            return "media_markup_unreadable";
        // Presence, not content: `alt=""` is how a decorative image is marked, and
        // it is the author's answer rather than a missing one.
        if (element.name === "img" && !attributes.has("alt"))
            return "media_image_alt_missing";
        const source = attributes.get("src");
        if (source !== undefined && !MEDIA_SRC_PREFIXES.some((prefix) => source.startsWith(prefix)))
            return "media_src_unsupported";
    }
    return null;
}
/**
 * Media lives in the question body, in every answer body, and in feedback, so
 * the rule runs over every string the payload carries rather than over a list of
 * fields that would go stale the moment Canvas adds one.
 */
function mediaReason(value, depth) {
    if (depth > MAX_DEPTH)
        return "payload_too_deep";
    if (typeof value === "string")
        return stringMediaReason(value);
    if (Array.isArray(value)) {
        for (const member of value) {
            const reason = mediaReason(member, depth + 1);
            if (reason)
                return reason;
        }
        return null;
    }
    if (plainObject(value)) {
        for (const child of Object.values(value)) {
            const reason = mediaReason(child, depth + 1);
            if (reason)
                return reason;
        }
    }
    return null;
}
/** Which of the four checked shapes this payload declares, or "" for every other type. */
function interactionKind(entry, item) {
    const slug = normalizeSlug(entry.interaction_type_slug ?? item.interaction_type_slug);
    const typeId = entry.interaction_type_id ?? item.interaction_type_id;
    if (CHOICE_SLUGS.includes(slug))
        return "choice";
    if (slug === "matching")
        return "matching";
    if (slug === "numeric")
        return "numeric";
    if (RICH_FILL_SLUGS.includes(slug))
        return "rich_fill";
    if (!slug && Number(typeId) === CHOICE_INTERACTION_TYPE_ID)
        return "choice";
    return "";
}
/** A body is blank when it carries neither text nor an image. */
function hasContent(value) {
    if (!scalar(value))
        return false;
    const text = String(value);
    return text.replaceAll(TAG, "").replaceAll("&nbsp;", " ").trim() !== "" || MEDIA_TAG.test(text);
}
/** The ids of one member list, or a reason token naming what was wrong with them. */
function memberIds(rows, invalid, duplicate) {
    const ids = [];
    for (const row of rows) {
        if (!plainObject(row))
            return invalid;
        const memberId = asText(row.id);
        if (!INTERACTION_ID.test(memberId))
            return invalid;
        if (ids.includes(memberId))
            return duplicate;
        ids.push(memberId);
    }
    return ids;
}
function sameIdSet(left, right) {
    return left.length === right.length && left.every((value) => right.includes(value));
}
function choiceReason(interaction, scoring) {
    if (!plainObject(interaction) || !Array.isArray(interaction.choices))
        return "choice_list_missing";
    if (interaction.choices.length < 2)
        return "choice_too_few";
    const ids = memberIds(interaction.choices, "choice_id_invalid", "choice_id_duplicate");
    if (!Array.isArray(ids))
        return ids;
    for (const choice of interaction.choices) {
        const body = plainObject(choice) ? choice.item_body ?? choice.itemBody ?? choice.body : undefined;
        if (!hasContent(body))
            return "choice_body_blank";
    }
    // The answer key names choices by id, as one id or as a list of them. A key
    // that names an id no choice carries marks the wrong answer correct.
    const value = plainObject(scoring) ? scoring.value : undefined;
    if (value === undefined || value === null)
        return null;
    const members = Array.isArray(value) ? value : [value];
    if (members.length === 0)
        return "choice_scoring_value_not_a_choice_id";
    for (const member of members) {
        if (!ids.includes(asText(member)))
            return "choice_scoring_value_not_a_choice_id";
    }
    return null;
}
function matchingReason(interaction, scoring) {
    if (!plainObject(interaction) || !Array.isArray(interaction.questions) || interaction.questions.length === 0)
        return "matching_questions_missing";
    const ids = memberIds(interaction.questions, "matching_question_id_invalid", "matching_question_id_duplicate");
    if (!Array.isArray(ids))
        return ids;
    if (!plainObject(scoring))
        return null;
    // The inline New Quiz convention that matching ids must read q-1..q-N is not
    // applied here. The harvest is explicit that it does not transfer to a bank
    // payload, where only presence and uniqueness are checkable.
    if (!plainObject(scoring.value))
        return "matching_scoring_value_not_an_object";
    if (!sameIdSet(Object.keys(scoring.value), ids))
        return "matching_scoring_value_keys_mismatch";
    // Live-unverified: whether Canvas would accept a matching payload with no
    // edit_data is not established. The harvest requires the match list to cover
    // every question, and Morrow keeps that requirement.
    const editData = scoring.edit_data;
    if (!plainObject(editData) || !Array.isArray(editData.matches))
        return "matching_edit_data_matches_missing";
    const matched = [];
    for (const match of editData.matches) {
        if (!plainObject(match))
            return "matching_edit_data_matches_mismatch";
        const questionId = asText(match.question_id ?? match.id);
        if (!questionId || matched.includes(questionId))
            return "matching_edit_data_matches_mismatch";
        matched.push(questionId);
    }
    return sameIdSet(matched, ids) ? null : "matching_edit_data_matches_mismatch";
}
function numericReason(interaction, scoring) {
    const value = plainObject(scoring) ? scoring.value : undefined;
    if (Array.isArray(value)) {
        // The public New Quiz item contract uses a list of typed numeric responses.
        const ids = memberIds(value, "numeric_response_invalid", "numeric_response_invalid");
        if (!Array.isArray(ids) || ids.length === 0)
            return "numeric_response_invalid";
        const numeric = (number) => (typeof number === "number" || (typeof number === "string" && number.trim() !== ""))
            && Number.isFinite(Number(number));
        for (const response of value) {
            if (!plainObject(response))
                return "numeric_response_invalid";
            if (response.type === "withinARange") {
                if (!numeric(response.start) || !numeric(response.end) || Number(response.start) > Number(response.end))
                    return "numeric_response_invalid";
            }
            else {
                if (!numeric(response.value))
                    return "numeric_response_invalid";
                if (response.type === "marginOfError") {
                    if (!numeric(response.margin) || Number(response.margin) < 0 || !["percent", "absolute"].includes(asText(response.margin_type)))
                        return "numeric_response_invalid";
                }
                else if (response.type === "preciseResponse") {
                    if (!numeric(response.precision) || !Number.isInteger(Number(response.precision)) || Number(response.precision) < 0
                        || !["decimals", "significantDigits"].includes(asText(response.precision_type)))
                        return "numeric_response_invalid";
                }
                else if (response.type !== "exactResponse")
                    return "numeric_response_invalid";
            }
        }
    }
    else if (value !== undefined && value !== null && (typeof value !== "number" || !Number.isFinite(value)))
        return "numeric_scoring_value_not_a_number";
    if (!plainObject(interaction))
        return null;
    const units = interaction.units;
    if (units !== undefined && units !== null && !(typeof units === "string" && units.trim() !== ""))
        return "numeric_units_blank";
    const dimensions = interaction.dimensions;
    if (dimensions === undefined || dimensions === null)
        return null;
    if (!plainObject(dimensions) || Object.keys(dimensions).length === 0)
        return "numeric_dimensions_invalid";
    for (const bound of ["min", "max", "step"]) {
        const held = dimensions[bound];
        if (held === undefined || held === null)
            continue;
        if (typeof held !== "number" || !Number.isFinite(held))
            return "numeric_dimensions_invalid";
    }
    if (typeof dimensions.min === "number" && typeof dimensions.max === "number" && dimensions.min > dimensions.max)
        return "numeric_dimensions_min_above_max";
    return null;
}
function scoringRow(scoring, blankId) {
    const rows = plainObject(scoring) && Array.isArray(scoring.value) ? scoring.value : [];
    return rows.find((row) => plainObject(row) && asText(row.id) === blankId) ?? null;
}
/** A scoring row holds the answer either under `scoring_data` or on the row. */
function rowAnswer(row) {
    if (row && plainObject(row.scoring_data))
        return row.scoring_data;
    return plainObject(row) ? row : null;
}
function blankKind(blank, row) {
    const named = normalizeSlug(blank.answer_type ?? blank.blank_type ?? blank.type ?? row?.scoring_algorithm);
    return BLANK_KINDS[named.replaceAll("_", "")] ?? "";
}
/** Every string a listed choice can be named by. */
function choiceTokens(choice) {
    if (scalar(choice))
        return [String(choice)];
    if (!plainObject(choice))
        return [];
    return [choice.id, choice.item_body ?? choice.body ?? choice.value ?? choice.text].filter(scalar).map(String);
}
function openEntryReason(blank, row) {
    const answer = blank.answers ?? rowAnswer(row)?.value;
    const answers = Array.isArray(answer) ? answer : answer === undefined || answer === null ? [] : [answer];
    if (answers.length === 0 || !answers.every((value) => scalar(value) && String(value).trim() !== ""))
        return "rich_fill_open_entry_answers_missing";
    return null;
}
function textInChoicesReason(blank, row) {
    const listed = blank.choices ?? rowAnswer(row)?.choices;
    if (!Array.isArray(listed) || listed.length < 2)
        return "rich_fill_text_in_choices_too_few";
    const tokens = listed.flatMap(choiceTokens);
    const correct = asText(blank.value ?? rowAnswer(row)?.value);
    return correct !== "" && tokens.includes(correct) ? null : "rich_fill_text_in_choices_value_not_listed";
}
function wordBankReason(interaction, scoring, itemBody, ids, wordBankIds) {
    if (!Array.isArray(interaction.word_bank_choices) || interaction.word_bank_choices.length < 2)
        return "rich_fill_word_bank_choices_too_few";
    const choiceIds = memberIds(interaction.word_bank_choices, "rich_fill_word_bank_choice_id_invalid", "rich_fill_word_bank_choice_id_duplicate");
    if (!Array.isArray(choiceIds))
        return choiceIds;
    if (!plainObject(scoring) || !Array.isArray(scoring.value))
        return "rich_fill_scoring_ids_mismatch";
    const scoredIds = memberIds(scoring.value, "rich_fill_scoring_ids_mismatch", "rich_fill_scoring_ids_mismatch");
    if (!Array.isArray(scoredIds) || !sameIdSet(scoredIds, ids))
        return "rich_fill_scoring_ids_mismatch";
    const answers = [];
    for (const blankId of ids) {
        const answer = rowAnswer(scoringRow(scoring, blankId));
        const value = asText(answer?.value);
        if (wordBankIds.includes(blankId)) {
            if (value.trim() === "")
                return "rich_fill_blank_answer_missing";
            // A word-bank blank must point at the same answer that it reveals.
            if (asText(answer?.blank_text) !== value)
                return "rich_fill_blank_text_mismatch";
            if (!choiceIds.includes(asText(answer?.choice_id)))
                return "rich_fill_choice_id_unknown";
        }
        answers.push(asText(answer?.blank_text) || value);
    }
    const markers = [...String(itemBody ?? "").matchAll(BLANK_MARKER)].map((match) => match[1] ?? match[2] ?? "");
    if (!sameIdSet([...new Set(markers)], ids))
        return "rich_fill_body_blank_markers_mismatch";
    // The working body is the authoring copy: every answer appears in backticks
    // where its blank sits, so the order carries the pairing.
    const working = typeof scoring.working_item_body === "string" ? scoring.working_item_body : "";
    let cursor = 0;
    for (const answer of answers) {
        const found = working.indexOf(`\`${answer}\``, cursor);
        if (found < 0)
            return "rich_fill_working_item_body_answers_out_of_order";
        cursor = found + answer.length + 2;
    }
    return null;
}
function richFillReason(interaction, scoring, itemBody) {
    const blanks = plainObject(interaction)
        ? Array.isArray(interaction.blanks) ? interaction.blanks : Array.isArray(interaction.entries) ? interaction.entries : null
        : null;
    if (!blanks || blanks.length === 0 || !plainObject(interaction))
        return "rich_fill_blanks_missing";
    const ids = memberIds(blanks, "rich_fill_blank_id_invalid", "rich_fill_blank_id_duplicate");
    if (!Array.isArray(ids))
        return ids;
    const kinds = blanks.map((blank, index) => plainObject(blank) ? blankKind(blank, scoringRow(scoring, ids[index] ?? "")) : "");
    if (kinds.includes(""))
        return "rich_fill_blank_kind_unreadable";
    const wordBankIds = ids.filter((_, index) => kinds[index] === "wordbank");
    if (wordBankIds.length > 0) {
        const reason = wordBankReason(interaction, scoring, itemBody, ids, wordBankIds);
        if (reason)
            return reason;
    }
    for (const [index, blank] of blanks.entries()) {
        if (!plainObject(blank))
            return "rich_fill_blank_id_invalid";
        if (kinds[index] === "wordbank")
            continue;
        const row = scoringRow(scoring, ids[index] ?? "");
        const reason = kinds[index] === "openEntry" ? openEntryReason(blank, row) : textInChoicesReason(blank, row);
        if (reason)
            return reason;
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
 * this file structurally checks, such as a title-only or points-only update,
 * so only the media rules run over it.
 */
export function quizItemPayloadReason(item) {
    if (!plainObject(item))
        return "payload_not_an_object";
    const entry = plainObject(item.entry) ? item.entry : item;
    const media = mediaReason(item, 0);
    if (media)
        return media;
    const kind = interactionKind(entry, item);
    if (!kind)
        return null;
    const interaction = entry.interaction_data;
    const scoring = entry.scoring_data;
    if ((interaction === undefined || interaction === null) && (scoring === undefined || scoring === null))
        return null;
    if (kind === "choice")
        return choiceReason(interaction, scoring);
    if (kind === "matching")
        return matchingReason(interaction, scoring);
    if (kind === "numeric")
        return numericReason(interaction, scoring);
    return richFillReason(interaction, scoring, entry.item_body);
}
const CREATE_ALGORITHMS = Object.freeze({
    "true-false": ["Equivalence"],
    categorization: ["Categorization"],
    matching: ["DeepEquals", "PartialDeep"],
    "file-upload": ["None"],
    formula: ["Numeric"],
    ordering: ["DeepEquals"],
    "rich-fill-blank": ["MultipleMethods"],
    "hot-spot": ["HotSpot"],
    choice: ["Equivalence", "VaryPointsByAnswer"],
    "multi-answer": ["AllOrNothing", "PartialScore"],
    numeric: ["Numeric"],
    essay: ["None"],
});
function nonBlankString(value) {
    return typeof value === "string" && value.trim() !== "";
}
function finiteNumeric(value) {
    return (typeof value === "number" && Number.isFinite(value))
        || (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value)));
}
function keyedMembers(value, minimum, requireUuid = false) {
    if (!plainObject(value))
        return null;
    const entries = Object.entries(value);
    if (entries.length < minimum)
        return null;
    const rows = [];
    for (const [key, row] of entries) {
        if (!INTERACTION_ID.test(key) || (requireUuid && !UUID.test(key)) || !plainObject(row) || asText(row.id) !== key || !hasContent(row.item_body ?? row.itemBody))
            return null;
        rows.push(row);
    }
    return { ids: entries.map(([key]) => key), rows };
}
function exactScalarIds(value, allowed, requireAll) {
    if (!Array.isArray(value) || value.length === 0)
        return false;
    const ids = value.map(asText);
    if (ids.some((id) => !allowed.includes(id)) || new Set(ids).size !== ids.length)
        return false;
    return !requireAll || sameIdSet(ids, allowed);
}
function sequentialPositions(rows) {
    return rows.every((row, index) => plainObject(row) && row.position === index + 1);
}
function onlyKeys(value, keys) {
    return Object.keys(value).every((key) => keys.includes(key));
}
function shuffleGroup(properties, group) {
    const rules = properties.shuffle_rules ?? properties.shuffleRules;
    if (rules === undefined)
        return undefined;
    if (!plainObject(rules) || !onlyKeys(rules, [group]) || !plainObject(rules[group]))
        return null;
    return rules[group];
}
function choicePropertiesReason(properties, interaction, allowVaryPoints, algorithm) {
    if (!onlyKeys(properties, ["shuffle_rules", "shuffleRules", "vary_points_by_answer", "varyPointsByAnswer"]))
        return "create_properties_invalid";
    const group = shuffleGroup(properties, "choices");
    if (group === null)
        return "create_properties_invalid";
    if (group) {
        if (!onlyKeys(group, ["to_lock", "toLock", "shuffled"]) || typeof group.shuffled !== "boolean")
            return "create_properties_invalid";
        const locks = group.to_lock ?? group.toLock;
        const count = Array.isArray(interaction.choices) ? interaction.choices.length : 0;
        if (locks !== undefined && (!Array.isArray(locks) || new Set(locks).size !== locks.length
            || locks.some((index) => !Number.isSafeInteger(index) || Number(index) < 0 || Number(index) >= count)))
            return "create_properties_invalid";
    }
    const vary = properties.vary_points_by_answer ?? properties.varyPointsByAnswer;
    if (!allowVaryPoints && vary !== undefined)
        return "create_properties_invalid";
    if (vary !== undefined && typeof vary !== "boolean")
        return "create_properties_invalid";
    if (allowVaryPoints && vary !== undefined && (vary !== (algorithm === "VaryPointsByAnswer")))
        return "create_properties_invalid";
    return null;
}
function questionShufflePropertiesReason(properties) {
    if (!onlyKeys(properties, ["shuffle_rules", "shuffleRules"]))
        return "create_properties_invalid";
    const group = shuffleGroup(properties, "questions");
    if (group === null)
        return "create_properties_invalid";
    return group && (!onlyKeys(group, ["shuffled"]) || typeof group.shuffled !== "boolean") ? "create_properties_invalid" : null;
}
function orderingPropertiesReason(properties) {
    if (!onlyKeys(properties, ["top_label", "bottom_label", "shuffle_rules", "include_labels", "display_answers_paragraph"]))
        return "create_properties_invalid";
    if (properties.shuffle_rules !== undefined && properties.shuffle_rules !== null)
        return "create_properties_invalid";
    for (const field of ["include_labels", "display_answers_paragraph"]) {
        if (properties[field] !== undefined && typeof properties[field] !== "boolean")
            return "create_properties_invalid";
    }
    for (const field of ["top_label", "bottom_label"]) {
        if (properties[field] !== undefined && typeof properties[field] !== "string")
            return "create_properties_invalid";
    }
    if (properties.include_labels === true && (!nonBlankString(properties.top_label) || !nonBlankString(properties.bottom_label)))
        return "create_properties_invalid";
    return null;
}
function richFillPropertiesReason(properties) {
    if (!onlyKeys(properties, ["shuffle_rules", "shuffleRules"]))
        return "create_properties_invalid";
    const rules = properties.shuffle_rules ?? properties.shuffleRules;
    if (rules === undefined)
        return null;
    if (!plainObject(rules) || !onlyKeys(rules, ["blanks"]) || !plainObject(rules.blanks)
        || !onlyKeys(rules.blanks, ["children"]) || !plainObject(rules.blanks.children))
        return "create_properties_invalid";
    for (const [index, row] of Object.entries(rules.blanks.children)) {
        if (!/^(?:0|[1-9][0-9]*)$/.test(index) || !plainObject(row) || !onlyKeys(row, ["children"]))
            return "create_properties_invalid";
        if (row.children === null)
            continue;
        if (!plainObject(row.children) || !onlyKeys(row.children, ["choices"]) || !plainObject(row.children.choices)
            || !onlyKeys(row.children.choices, ["shuffled"]) || typeof row.children.choices.shuffled !== "boolean")
            return "create_properties_invalid";
    }
    return null;
}
function questionPropertiesReason(slug, properties, interaction, algorithm) {
    if (["true-false", "formula", "hot-spot", "numeric", "essay"].includes(slug)) {
        return Object.keys(properties).length === 0 ? null : "create_properties_invalid";
    }
    if (slug === "categorization") {
        const reason = questionShufflePropertiesReason(properties);
        if (reason)
            return reason;
        const group = shuffleGroup(properties, "questions");
        return group?.shuffled === true ? "create_properties_invalid" : null;
    }
    if (slug === "matching")
        return questionShufflePropertiesReason(properties);
    if (slug === "choice")
        return choicePropertiesReason(properties, interaction, true, algorithm);
    if (slug === "multi-answer")
        return choicePropertiesReason(properties, interaction, false, algorithm);
    if (slug === "ordering")
        return orderingPropertiesReason(properties);
    if (slug === "rich-fill-blank")
        return richFillPropertiesReason(properties);
    return null;
}
// The exact key sets the documented Categorization and Matching appendix blocks publish. An
// unrecognised key is refused rather than passed through, because a create sends the whole object
// and Morrow would otherwise write a structure it never checked. Source:
// https://developerdocs.instructure.com/services/canvas/resources/new_quiz_items
const CATEGORIZATION_INTERACTION_KEYS = ["categories", "distractors", "category_order"];
const CATEGORIZATION_SCORING_KEYS = ["score_method", "value"];
const CATEGORIZATION_SCORING_ROW_KEYS = ["id", "scoring_algorithm", "scoring_data"];
const MATCHING_INTERACTION_KEYS = ["questions", "answers"];
const MATCHING_SCORING_KEYS = ["value", "edit_data"];
const MATCHING_EDIT_DATA_KEYS = ["matches", "distractors"];
const MATCHING_MATCH_KEYS = ["answer_body", "question_id", "question_body", "id"];

function categorizationCreateReason(interaction, scoring) {
    if (!onlyKeys(interaction, CATEGORIZATION_INTERACTION_KEYS))
        return "categorization_structure_invalid";
    if (!onlyKeys(scoring, CATEGORIZATION_SCORING_KEYS))
        return "categorization_scoring_invalid";
    if ((plainObject(interaction.categories) && Object.keys(interaction.categories).some((id) => !UUID.test(id)))
        || (plainObject(interaction.distractors) && Object.keys(interaction.distractors).some((id) => !UUID.test(id))))
        return "create_uuid_invalid";
    const categories = keyedMembers(interaction.categories, 2, true);
    const distractors = keyedMembers(interaction.distractors, 1, true);
    if (!categories || !distractors)
        return "categorization_structure_invalid";
    if (!exactScalarIds(interaction.category_order, categories.ids, true))
        return "categorization_structure_invalid";
    if (scoring.score_method !== "all_or_nothing" || !Array.isArray(scoring.value) || scoring.value.length !== categories.ids.length)
        return "categorization_scoring_invalid";
    const seenCategories = [];
    const assigned = new Set();
    for (const row of scoring.value) {
        if (!plainObject(row) || !onlyKeys(row, CATEGORIZATION_SCORING_ROW_KEYS)
            || !categories.ids.includes(asText(row.id)) || seenCategories.includes(asText(row.id))
            || row.scoring_algorithm !== "AllOrNothing" || !plainObject(row.scoring_data)
            || !onlyKeys(row.scoring_data, ["value"])
            || !Array.isArray(row.scoring_data.value))
            return "categorization_scoring_invalid";
        seenCategories.push(asText(row.id));
        for (const answer of row.scoring_data.value) {
            const id = asText(answer);
            if (!distractors.ids.includes(id) || assigned.has(id))
                return "categorization_scoring_invalid";
            assigned.add(id);
        }
    }
    return sameIdSet(seenCategories, categories.ids) ? null : "categorization_scoring_invalid";
}
function matchingCreateReason(interaction, scoring) {
    const baseReason = matchingReason(interaction, scoring);
    if (baseReason)
        return baseReason;
    if (!onlyKeys(interaction, MATCHING_INTERACTION_KEYS) || !onlyKeys(scoring, MATCHING_SCORING_KEYS)
        || (plainObject(scoring.edit_data) && !onlyKeys(scoring.edit_data, MATCHING_EDIT_DATA_KEYS))
        || (plainObject(scoring.edit_data) && Array.isArray(scoring.edit_data.matches)
            && scoring.edit_data.matches.some((match) => !plainObject(match) || !onlyKeys(match, MATCHING_MATCH_KEYS))))
        return "matching_structure_invalid";
    if (!Array.isArray(interaction.questions) || !Array.isArray(interaction.answers)
        || interaction.answers.length === 0 || interaction.answers.some((answer) => !nonBlankString(answer))
        || new Set(interaction.answers).size !== interaction.answers.length || !plainObject(scoring.value)
        || !plainObject(scoring.edit_data) || !Array.isArray(scoring.edit_data.matches))
        return "matching_structure_invalid";
    const answers = interaction.answers;
    const questionBodies = new Map();
    for (const question of interaction.questions) {
        if (!plainObject(question) || !hasContent(question.item_body))
            return "matching_structure_invalid";
        questionBodies.set(asText(question.id), asText(question.item_body));
    }
    const usedAnswers = new Set();
    for (const [questionId, answer] of Object.entries(scoring.value)) {
        if (!nonBlankString(answer) || !answers.includes(answer) || usedAnswers.has(answer))
            return "matching_scoring_value_invalid";
        usedAnswers.add(answer);
        const match = scoring.edit_data.matches.find((candidate) => plainObject(candidate) && asText(candidate.question_id) === questionId);
        if (!plainObject(match) || match.answer_body !== answer || match.question_body !== questionBodies.get(questionId))
            return "matching_edit_data_values_mismatch";
    }
    const distractors = scoring.edit_data.distractors ?? [];
    if (!Array.isArray(distractors) || distractors.some((answer) => !nonBlankString(answer))
        || new Set(distractors).size !== distractors.length || distractors.some((answer) => usedAnswers.has(answer)))
        return "matching_edit_data_values_mismatch";
    return sameIdSet([...usedAnswers, ...distractors], answers) ? null : "matching_edit_data_values_mismatch";
}
function orderingCreateReason(interaction, scoring) {
    if (plainObject(interaction.choices) && Object.keys(interaction.choices).some((id) => !UUID.test(id)))
        return "create_uuid_invalid";
    const choices = keyedMembers(interaction.choices, 2, true);
    return choices && exactScalarIds(scoring.value, choices.ids, true) ? null : "ordering_structure_invalid";
}
const RICH_FILL_ALGORITHMS = Object.freeze(["TextCloseEnough", "TextContainsAnswer", "TextInChoices", "Equivalence", "TextEquivalence", "TextRegex"]);
function richFillCreateReason(interaction, scoring, itemBody) {
    const baseReason = richFillReason(interaction, scoring, itemBody);
    if (baseReason)
        return baseReason;
    if (!Array.isArray(interaction.blanks) || !Array.isArray(scoring.value) || !nonBlankString(scoring.working_item_body))
        return "rich_fill_structure_invalid";
    if (interaction.reuse_word_bank_choices !== undefined && typeof interaction.reuse_word_bank_choices !== "boolean")
        return "rich_fill_structure_invalid";
    const blankIds = interaction.blanks.map((blank) => plainObject(blank) ? asText(blank.id) : "");
    const markers = [...itemBody.matchAll(BLANK_MARKER)].map((match) => match[1] ?? match[2] ?? "");
    if (markers.length !== blankIds.length || !sameIdSet(markers, blankIds))
        return "rich_fill_body_blank_markers_mismatch";
    for (const blank of interaction.blanks) {
        if (!plainObject(blank))
            return "rich_fill_structure_invalid";
        const row = scoringRow(scoring, asText(blank.id));
        const data = rowAnswer(row);
        const kind = blankKind(blank, row);
        if (!row || !data || !RICH_FILL_ALGORITHMS.includes(asText(row.scoring_algorithm)) || !nonBlankString(data.blank_text))
            return "rich_fill_scoring_row_invalid";
        if (kind === "openEntry") {
            const value = data.value;
            if (row.scoring_algorithm === "TextInChoices") {
                if (!Array.isArray(value) || value.length === 0 || value.some((answer) => !nonBlankString(answer)) || !value.includes(data.blank_text))
                    return "rich_fill_scoring_row_invalid";
            }
            else if (!nonBlankString(value))
                return "rich_fill_scoring_row_invalid";
            if (row.scoring_algorithm === "TextCloseEnough"
                && (typeof data.ignore_case !== "boolean" || !Number.isSafeInteger(data.edit_distance) || Number(data.edit_distance) < 0))
                return "rich_fill_scoring_row_invalid";
        }
        else if (kind === "TextInChoices") {
            if (row.scoring_algorithm !== "Equivalence" || !Array.isArray(blank.choices) || !sequentialPositions(blank.choices))
                return "rich_fill_scoring_row_invalid";
            const choiceIds = blank.choices.map((choice) => plainObject(choice) ? asText(choice.id) : "");
            if (!choiceIds.includes(asText(data.value)))
                return "rich_fill_scoring_row_invalid";
        }
        else if (kind === "wordbank") {
            if (row.scoring_algorithm !== "TextEquivalence" || typeof interaction.reuse_word_bank_choices !== "boolean")
                return "rich_fill_scoring_row_invalid";
        }
    }
    return null;
}
function trueFalseCreateReason(interaction, scoring) {
    return nonBlankString(interaction.true_choice) && nonBlankString(interaction.false_choice)
        && typeof scoring.value === "boolean" ? null : "true_false_structure_invalid";
}
function fileUploadCreateReason(interaction, scoring, properties) {
    const count = Number(interaction.files_count);
    if (!Number.isSafeInteger(count) || count < 1 || typeof interaction.restrict_count !== "boolean" || scoring.value !== "") {
        return "file_upload_structure_invalid";
    }
    if (!onlyKeys(properties, ["allowed_types", "restrict_types"]))
        return "create_properties_invalid";
    if (properties.allowed_types !== undefined && typeof properties.allowed_types !== "string")
        return "create_properties_invalid";
    if (properties.restrict_types !== undefined && typeof properties.restrict_types !== "boolean")
        return "create_properties_invalid";
    if (properties.restrict_types === true && !nonBlankString(properties.allowed_types))
        return "create_properties_invalid";
    return null;
}
function formulaCreateReason(interaction, scoring) {
    if (Object.keys(interaction).length !== 0 || !plainObject(scoring.value))
        return "formula_structure_invalid";
    const value = scoring.value;
    if (!nonBlankString(value.formula) || !plainObject(value.numeric) || !Array.isArray(value.variables)
        || value.variables.length === 0 || !Array.isArray(value.generated_solutions) || value.generated_solutions.length === 0) {
        return "formula_structure_invalid";
    }
    const numeric = value.numeric;
    if (numeric.type !== "marginOfError" || !finiteNumeric(numeric.margin)
        || Number(numeric.margin) < 0 || !["absolute", "percent"].includes(asText(numeric.margin_type)))
        return "formula_structure_invalid";
    const variableNames = new Set();
    for (const variable of value.variables) {
        if (!plainObject(variable) || !nonBlankString(variable.name) || variableNames.has(variable.name)
            || !finiteNumeric(variable.min) || !finiteNumeric(variable.max) || Number(variable.min) > Number(variable.max)
            || !finiteNumeric(variable.precision) || !Number.isInteger(Number(variable.precision)) || Number(variable.precision) < 0)
            return "formula_structure_invalid";
        variableNames.add(variable.name);
    }
    if (!Number.isSafeInteger(Number(value.answer_count)) || Number(value.answer_count) !== value.generated_solutions.length)
        return "formula_structure_invalid";
    for (const solution of value.generated_solutions) {
        if (!plainObject(solution) || !finiteNumeric(solution.output) || !Array.isArray(solution.inputs)
            || solution.inputs.length !== variableNames.size)
            return "formula_structure_invalid";
        const names = new Set();
        for (const input of solution.inputs) {
            if (!plainObject(input) || !variableNames.has(asText(input.name)) || names.has(asText(input.name)) || !finiteNumeric(input.value))
                return "formula_structure_invalid";
            names.add(asText(input.name));
        }
    }
    return null;
}
function hotSpotCreateReason(interaction, scoring) {
    if (!nonBlankString(interaction.image_url) || !plainObject(scoring.value))
        return "hot_spot_structure_invalid";
    try {
        const url = new URL(interaction.image_url);
        if (!["http:", "https:"].includes(url.protocol) || url.search || url.hash)
            return "hot_spot_structure_invalid";
    }
    catch {
        return "hot_spot_structure_invalid";
    }
    const value = scoring.value;
    if (!["oval", "square", "polygon"].includes(asText(value.type)) || !Array.isArray(value.coordinates))
        return "hot_spot_structure_invalid";
    if (value.coordinates.length < (value.type === "polygon" ? 3 : 2))
        return "hot_spot_structure_invalid";
    return value.coordinates.every((point) => plainObject(point) && typeof point.x === "number" && Number.isFinite(point.x)
        && point.x >= 0 && point.x <= 1 && typeof point.y === "number" && Number.isFinite(point.y) && point.y >= 0 && point.y <= 1)
        ? null : "hot_spot_structure_invalid";
}
function essayCreateReason(interaction, scoring) {
    if (!onlyKeys(interaction, ["rce", "essay", "word_count", "file_upload", "spell_check", "word_limit_max", "word_limit_min", "word_limit_enabled"]))
        return "essay_structure_invalid";
    for (const field of ["rce", "word_count", "file_upload", "spell_check", "word_limit_enabled"]) {
        if (typeof interaction[field] !== "boolean")
            return "essay_structure_invalid";
    }
    if (interaction.essay !== null || interaction.file_upload !== false)
        return "essay_structure_invalid";
    if (interaction.word_limit_enabled === true) {
        if (!finiteNumeric(interaction.word_limit_min) || !finiteNumeric(interaction.word_limit_max)
            || Number(interaction.word_limit_min) < 0 || Number(interaction.word_limit_min) > Number(interaction.word_limit_max))
            return "essay_structure_invalid";
    }
    return typeof scoring.value === "string" ? null : "essay_structure_invalid";
}
/**
 * Validate a complete QuestionItem for Canvas's create route.
 *
 * Unlike `quizItemPayloadReason`, this function never passes an unknown or
 * incomplete interaction through. Partial PATCH payloads keep using the
 * permissive function because their omitted fields come from the saved item.
 */
export function completeQuizItemPayloadReason(item) {
    if (!plainObject(item))
        return "payload_not_an_object";
    const media = mediaReason(item, 0);
    if (media)
        return media;
    if (item.entry_type !== "Item" || !plainObject(item.entry))
        return "create_entry_type_invalid";
    if (item.points_possible !== undefined && (typeof item.points_possible !== "number" || !Number.isFinite(item.points_possible) || item.points_possible <= 0)) {
        return "create_points_not_positive";
    }
    if (item.position !== undefined && (!Number.isSafeInteger(item.position) || Number(item.position) < 1))
        return "create_position_invalid";
    const entry = item.entry;
    if (!nonBlankString(entry.item_body))
        return "create_item_body_missing";
    if (entry.calculator_type !== undefined && !["none", "basic", "scientific"].includes(asText(entry.calculator_type)))
        return "create_calculator_type_invalid";
    const slug = entry.interaction_type_slug;
    if (typeof slug !== "string" || !(slug in CREATE_ALGORITHMS))
        return slug === "fill-blank" ? "create_deprecated_question_type" : "create_question_type_unsupported";
    if (!plainObject(entry.interaction_data) || !plainObject(entry.scoring_data))
        return "create_required_data_missing";
    if (!CREATE_ALGORITHMS[slug]?.includes(asText(entry.scoring_algorithm)))
        return "create_scoring_algorithm_invalid";
    if (entry.properties !== undefined && !plainObject(entry.properties))
        return "create_properties_invalid";
    if (entry.answer_feedback !== undefined) {
        if (slug !== "choice" || !plainObject(entry.answer_feedback))
            return "create_answer_feedback_invalid";
    }
    const interaction = entry.interaction_data;
    const scoring = entry.scoring_data;
    const properties = plainObject(entry.properties) ? entry.properties : {};
    const propertiesReason = questionPropertiesReason(slug, properties, interaction, entry.scoring_algorithm);
    if (propertiesReason)
        return propertiesReason;
    if (entry.feedback !== undefined) {
        if (!plainObject(entry.feedback) || !onlyKeys(entry.feedback, ["neutral", "correct", "incorrect"])
            || Object.values(entry.feedback).some((value) => typeof value !== "string"))
            return "create_feedback_invalid";
    }
    if (plainObject(entry.answer_feedback) && Object.values(entry.answer_feedback).some((value) => typeof value !== "string"))
        return "create_answer_feedback_invalid";
    if (slug === "choice" || slug === "multi-answer") {
        const reason = choiceReason(interaction, scoring);
        if (reason)
            return reason;
        const ids = memberIds(interaction.choices, "choice_id_invalid", "choice_id_duplicate");
        if (!Array.isArray(ids))
            return ids;
        if (ids.some((id) => !UUID.test(id)))
            return "create_uuid_invalid";
        if (!sequentialPositions(interaction.choices))
            return "create_choice_position_invalid";
        if (slug === "multi-answer" && !exactScalarIds(scoring.value, ids, false))
            return "multi_answer_scoring_invalid";
        if (slug === "choice" && (Array.isArray(scoring.value) || !ids.includes(asText(scoring.value))))
            return "choice_scoring_value_not_a_choice_id";
        if (slug === "choice" && entry.scoring_algorithm === "VaryPointsByAnswer") {
            if (!Array.isArray(scoring.values) || scoring.values.length !== ids.length)
                return "choice_vary_points_invalid";
            const scored = new Set();
            for (const row of scoring.values) {
                if (!plainObject(row) || !ids.includes(asText(row.value)) || scored.has(asText(row.value))
                    || typeof row.points !== "number" || !Number.isFinite(row.points))
                    return "choice_vary_points_invalid";
                scored.add(asText(row.value));
            }
        }
        if (plainObject(entry.answer_feedback) && Object.keys(entry.answer_feedback).some((id) => !ids.includes(id)))
            return "create_answer_feedback_invalid";
        return null;
    }
    if (slug === "matching")
        return matchingCreateReason(interaction, scoring);
    if (slug === "numeric") {
        if (Object.keys(interaction).length !== 0)
            return "numeric_response_invalid";
        const reason = numericReason(interaction, scoring);
        return reason ?? (Array.isArray(scoring.value) && scoring.value.length > 0 ? null : "numeric_response_invalid");
    }
    if (slug === "rich-fill-blank") {
        const reason = richFillCreateReason(interaction, scoring, entry.item_body);
        if (reason)
            return reason;
        const blanks = Array.isArray(interaction.blanks) ? interaction.blanks : [];
        const blankIds = memberIds(blanks, "rich_fill_blank_id_invalid", "rich_fill_blank_id_duplicate");
        const scoringIds = Array.isArray(scoring.value) ? memberIds(scoring.value, "rich_fill_scoring_ids_mismatch", "rich_fill_scoring_ids_mismatch") : "";
        if (!Array.isArray(blankIds) || blankIds.some((id) => !UUID.test(id)))
            return "create_uuid_invalid";
        const nestedChoiceIds = blanks.flatMap((blank) => plainObject(blank) && Array.isArray(blank.choices)
            ? blank.choices.map((choice) => plainObject(choice) ? asText(choice.id) : "") : []);
        const wordBankIds = Array.isArray(interaction.word_bank_choices)
            ? interaction.word_bank_choices.map((choice) => plainObject(choice) ? asText(choice.id) : "") : [];
        if ([...nestedChoiceIds, ...wordBankIds].some((id) => !UUID.test(id)))
            return "create_uuid_invalid";
        return Array.isArray(scoringIds) && sameIdSet(blankIds, scoringIds) ? null : "rich_fill_scoring_ids_mismatch";
    }
    if (slug === "true-false")
        return trueFalseCreateReason(interaction, scoring);
    if (slug === "categorization")
        return categorizationCreateReason(interaction, scoring);
    if (slug === "file-upload")
        return fileUploadCreateReason(interaction, scoring, properties);
    if (slug === "formula")
        return formulaCreateReason(interaction, scoring);
    if (slug === "ordering")
        return orderingCreateReason(interaction, scoring);
    if (slug === "hot-spot")
        return hotSpotCreateReason(interaction, scoring);
    return essayCreateReason(interaction, scoring);
}
/**
 * The sentence a person reads for one reason token. Each one names the part of
 * the question that is wrong and what to change, because the person who reads
 * it is the person who has to fix the question.
 */
const MESSAGES = {
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
    create_entry_type_invalid: "Canvas can create only a QuestionItem here. Set entry_type to Item and supply the complete entry object.",
    create_points_not_positive: "When points_possible is present, it must be a positive number.",
    create_position_invalid: "When position is present, it must be a positive whole number.",
    create_item_body_missing: "A created question needs a non-empty entry.item_body.",
    create_calculator_type_invalid: "entry.calculator_type must be none, basic, or scientific.",
    create_deprecated_question_type: "Canvas marks fill-blank as deprecated. Create a rich-fill-blank question instead.",
    create_question_type_unsupported: "entry.interaction_type_slug must name one of the 12 question types Canvas supports for create.",
    create_required_data_missing: "A created question needs complete entry.interaction_data and entry.scoring_data objects.",
    create_scoring_algorithm_invalid: "entry.scoring_algorithm does not match this New Quizzes question type.",
    create_properties_invalid: "entry.properties must be an object when it is present.",
    create_answer_feedback_invalid: "Only a choice question may carry answer_feedback, and each feedback key must name one of its choices.",
    create_feedback_invalid: "entry.feedback may contain only text under neutral, correct, and incorrect.",
    create_uuid_invalid: "This question type requires canonical UUID values for its generated category, response, choice, or blank ids.",
    create_choice_position_invalid: "Each listed choice needs a one-based position that matches its order.",
    multi_answer_scoring_invalid: "A multiple-answer key needs a non-empty list of unique choice ids from this question.",
    choice_vary_points_invalid: "VaryPointsByAnswer scoring needs one finite point value for every choice id.",
    true_false_structure_invalid: "A true-false question needs named true and false choices and a boolean correct value.",
    categorization_structure_invalid: "A categorization question needs keyed categories and distractors with matching ids and a complete category order.",
    categorization_scoring_invalid: "Categorization scoring must name every category once and assign each correct distractor id at most once.",
    matching_structure_invalid: "A matching question needs unique answer text and a body for every prompt.",
    matching_scoring_value_invalid: "Each matching answer key value must name one unique answer from interaction_data.answers.",
    matching_edit_data_values_mismatch: "The matching edit data must reproduce each prompt and correct answer, and list every unused answer once as a distractor.",
    file_upload_structure_invalid: "A file-upload question needs a positive file count, restriction flags, and an empty scoring value.",
    formula_structure_invalid: "A formula question needs a formula, valid variables, numeric tolerance, and the declared number of generated solutions.",
    ordering_structure_invalid: "An ordering question needs keyed choices with matching ids and a scoring list that contains every choice once.",
    hot_spot_structure_invalid: "A hot-spot question needs an unsigned http or https image URL and valid normalized coordinates for its shape.",
    rich_fill_structure_invalid: "A rich fill-in-the-blank question needs its complete blank list, working body, and word-bank reuse setting when it uses a word bank.",
    rich_fill_scoring_row_invalid: "Each rich fill-in-the-blank scoring row must use a supported algorithm and complete data for its blank type.",
    essay_structure_invalid: "An essay question has invalid response settings, word limits, or grading notes.",
};
/** Every reason token this file can return, so a test can prove each one has a sentence. */
export const QUIZ_ITEM_PAYLOAD_REASONS = Object.freeze(Object.keys(MESSAGES));
/** The sentence for one reason token. An unmapped token names itself rather than reading as nothing. */
export function quizItemPayloadMessage(reason) {
    return MESSAGES[reason] ?? `Morrow refused this question payload: ${reason}.`;
}

export const validateQuizItemPayload = quizItemPayloadReason;
