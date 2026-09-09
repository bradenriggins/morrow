(() => {
  if (globalThis.__morrowCanvasConnectorInstalled) return;
  globalThis.__morrowCanvasConnectorInstalled = true;

  const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
  const MAX_PAGES = 50;
  // Total Canvas pages one resumed list sequence may read across every bounded call.
  const MAX_RESUMED_PAGES = 500;
  const MAX_DISCOVERED_COURSES = 100;
  // Every deliberate error this connector throws leads with a lowercase,
  // underscore-joined token (e.g. "canvas_x_y", optionally followed by free
  // text). A genuine unexpected exception (a browser TypeError, a network
  // failure, a JSON parse error) is an English sentence and never starts that
  // way, so it is safe to replace anything else with a fixed token.
  const MORROW_OWN_ERROR_TOKEN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+/;

  /* BEGIN GENERATED NEW QUIZ ITEM PAYLOAD CONTRACT */
  // Generated from packages/mcp-server/src/quiz-item-payload.ts sha256:20807f46b8e445f6e2486011f575a4638e37227600efa5036afbbf5e6391a10c
  const NEW_QUIZ_ITEM_PAYLOAD_CONTRACT = (() => {
    const MEDIA_ELEMENTS = ["img", "audio", "video"];
    const MEDIA_SRC_PREFIXES = ["https://", "/courses/", "/api/v1/files/"];
    const CHOICE_SLUGS = ["choice", "multiple_choice"];
    const CHOICE_INTERACTION_TYPE_ID = 1;
    const RICH_FILL_SLUGS = ["rich_fill_blank", "rich_fill", "rich_fill_in_the_blank"];
    const BLANK_KINDS = { openentry: "openEntry", dropdown: "TextInChoices", textinchoices: "TextInChoices", wordbank: "wordbank" };
    const INTERACTION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const TAG = /<!--[\s\S]*?-->|<(?:"[^"]*"|'[^']*'|[^'">])*>/g;
    const TAG_NAME = /^<\s*(\/?)\s*([a-zA-Z][^\s/>]*)/;
    const ATTRIBUTE = /^\s+([A-Za-z_:][-A-Za-z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/;
    const RAW_TEXT = ["script", "style", "iframe", "object", "embed", "textarea", "title"];
    const MEDIA_TAG = /<\s*(?:img|audio|video)\b/i;
    const BLANK_MARKER = /id\s*=\s*(?:"blank_([^"]*)"|'blank_([^']*)')/g;
    const MAX_DEPTH = 32;
    function plainObject(value) {
        return Boolean(value) && typeof value === "object" && !Array.isArray(value);
    }
    function scalar(value) {
        return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
    }
    function asText(value) {
        return scalar(value) ? String(value) : "";
    }
    function normalizeSlug(value) {
        return typeof value === "string" ? value.trim().toLowerCase().replaceAll(/[\s-]+/g, "_") : "";
    }
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
            if (element.name === "img" && !attributes.has("alt"))
                return "media_image_alt_missing";
            const source = attributes.get("src");
            if (source !== undefined && !MEDIA_SRC_PREFIXES.some((prefix) => source.startsWith(prefix)))
                return "media_src_unsupported";
        }
        return null;
    }
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
    function hasContent(value) {
        if (!scalar(value))
            return false;
        const text = String(value);
        return text.replaceAll(TAG, "").replaceAll("&nbsp;", " ").trim() !== "" || MEDIA_TAG.test(text);
    }
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
        if (!plainObject(scoring.value))
            return "matching_scoring_value_not_an_object";
        if (!sameIdSet(Object.keys(scoring.value), ids))
            return "matching_scoring_value_keys_mismatch";
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
    function rowAnswer(row) {
        if (row && plainObject(row.scoring_data))
            return row.scoring_data;
        return plainObject(row) ? row : null;
    }
    function blankKind(blank, row) {
        const named = normalizeSlug(blank.answer_type ?? blank.blank_type ?? blank.type ?? row?.scoring_algorithm);
        return BLANK_KINDS[named.replaceAll("_", "")] ?? "";
    }
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
    function quizItemPayloadReason(item) {
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
    function completeQuizItemPayloadReason(item) {
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
    const QUIZ_ITEM_PAYLOAD_REASONS = Object.freeze(Object.keys(MESSAGES));
    function quizItemPayloadMessage(reason) {
        return MESSAGES[reason] ?? `Morrow refused this question payload: ${reason}.`;
    }
    return Object.freeze({ completeQuizItemPayloadReason, quizItemPayloadMessage });
  })();
  /* END GENERATED NEW QUIZ ITEM PAYLOAD CONTRACT */

  /**
   * The relative media rule.
   *
   * A create is judged on its own: every image in it must say what it shows. A
   * change to a question Canvas already holds is judged against that question
   * instead. Adding alternative text to one image must not be refused because a
   * different image in the same question still has none, which is exactly the
   * repair this rule exists to allow.
   *
   * It is relative per element, never per finding code. A change that keeps one
   * undescribed image and adds a second one carries the same code as the
   * question it started from, so a code comparison would let the new one
   * through. Findings are therefore matched by their exact element and counted:
   * a second copy of the same offending element is still refused. A finding
   * that names no element, which is unreadable markup or a payload deeper than
   * this rule reads, matches nothing and is always refused.
   *
   * connector/extension/src/item-bank-guard.js holds the one implementation.
   * Chrome evaluates this content script without module scope, so this copy
   * lives here, and scripts/test/canvas-new-quiz-media-rule.test.mjs runs both
   * over the same fixtures and fails if they disagree.
   */
  const NEW_QUIZ_MEDIA_RULE = (() => {
    const MEDIA_ELEMENTS = ["img", "audio", "video"];
    const MEDIA_SRC_PREFIXES = ["https://", "/courses/", "/api/v1/files/"];
    const MEDIA_TAG = /<\s*(?:img|audio|video)\b/i;
    const TAG = /<!--[\s\S]*?-->|<(?:"[^"]*"|'[^']*'|[^'">])*>/g;
    const TAG_NAME = /^<\s*(\/?)\s*([a-zA-Z][^\s/>]*)/;
    // The rule reads an unquoted attribute value as well, because it only
    // counts elements and never rewrites one.
    const MEDIA_ATTRIBUTE = /^\s+([A-Za-z_:][-A-Za-z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/;
    const RAW_TEXT = ["script", "style", "iframe", "object", "embed", "textarea", "title"];
    const MAX_DEPTH = 32;
    const plain = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

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

    function mediaTagAttributes(tag) {
      const open = TAG_NAME.exec(tag);
      if (!open || open[1] === "/" || !tag.endsWith(">")) return null;
      let rest = tag.slice(open[0].length, tag.length - (tag.endsWith("/>") ? 2 : 1));
      const attributes = new Map();
      while (rest.trim().length > 0) {
        const match = MEDIA_ATTRIBUTE.exec(rest);
        if (!match) return null;
        const name = match[1].toLowerCase();
        if (attributes.has(name)) return null;
        attributes.set(name, match[2] ?? match[3] ?? match[4] ?? "");
        rest = rest.slice(match[0].length);
      }
      return attributes;
    }

    function stringMediaFindings(value, findings) {
      if (!MEDIA_TAG.test(value)) return;
      const scan = mediaElements(value);
      if (scan.open) {
        findings.push({ reason: "media_markup_unreadable", tag: "" });
        return;
      }
      for (const element of scan.elements) {
        const attributes = mediaTagAttributes(element.tag);
        if (!attributes) {
          findings.push({ reason: "media_markup_unreadable", tag: "" });
          continue;
        }
        // Presence, not content: alt="" is how a decorative image is marked, and
        // it is the author's answer rather than a missing one.
        if (element.name === "img" && !attributes.has("alt")) findings.push({ reason: "media_image_alt_missing", tag: element.tag });
        const source = attributes.get("src");
        if (source !== undefined && !MEDIA_SRC_PREFIXES.some((prefix) => source.startsWith(prefix))) {
          findings.push({ reason: "media_src_unsupported", tag: element.tag });
        }
      }
    }

    function mediaFindings(value, depth = 0, findings = []) {
      if (depth > MAX_DEPTH) {
        findings.push({ reason: "payload_too_deep", tag: "" });
        return findings;
      }
      if (typeof value === "string") stringMediaFindings(value, findings);
      else if (Array.isArray(value)) for (const member of value) mediaFindings(member, depth + 1, findings);
      else if (plain(value)) for (const child of Object.values(value)) mediaFindings(child, depth + 1, findings);
      return findings;
    }

    function newMediaReason(proposed, stored) {
      const held = new Map();
      for (const finding of mediaFindings(stored)) {
        if (!finding.tag) continue;
        const key = `${finding.reason} ${finding.tag}`;
        held.set(key, (held.get(key) || 0) + 1);
      }
      for (const finding of mediaFindings(proposed)) {
        const key = `${finding.reason} ${finding.tag}`;
        const count = finding.tag ? held.get(key) || 0 : 0;
        if (count === 0) return finding.reason;
        held.set(key, count - 1);
      }
      return null;
    }

    // The complete payload contract checks media before anything else and stops
    // at the first problem, so a media problem the stored question already
    // carries would hide every rule after it. Once newMediaReason has proved
    // this change adds no media problem, every media problem left in it is one
    // Canvas already holds. Replacing each of those elements with one that
    // carries no problem lets the rest of the contract run unchanged. This copy
    // is only ever validated; the payload sent to Canvas is never rewritten.
    const HELD_MEDIA = '<img alt="" src="https://morrow.invalid/held-media">';

    function withoutHeldMedia(value) {
      const tags = [...new Set(mediaFindings(value).map((finding) => finding.tag).filter(Boolean))];
      if (tags.length === 0) return value;
      const replace = (node, depth) => {
        if (depth > MAX_DEPTH) return node;
        if (typeof node === "string") {
          let text = node;
          for (const tag of tags) text = text.split(tag).join(HELD_MEDIA);
          return text;
        }
        if (Array.isArray(node)) return node.map((member) => replace(member, depth + 1));
        if (plain(node)) return Object.fromEntries(Object.entries(node).map(([key, child]) => [key, replace(child, depth + 1)]));
        return node;
      };
      return replace(value, 0);
    }

    return { mediaFindings, newMediaReason, withoutHeldMedia };
  })();

  function currentCanvasCourseId() {
    const match = location.pathname.match(/(?:^|\/)courses\/([1-9][0-9]*)(?:\/|$)/);
    if (!match) throw new Error("canvas_course_context_missing");
    return match[1];
  }

  function pageId(value) {
    if (typeof value !== "string" && !(typeof value === "number" && Number.isSafeInteger(value))) return null;
    return /^[1-9][0-9]{0,18}$/.test(String(value)) ? String(value) : null;
  }

  async function bodyDigest(body) {
    return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  async function pageJson(url) {
    const response = await fetch(url, { credentials: "include", cache: "no-store", redirect: "error", headers: { Accept: "application/json+canvas-string-ids" } });
    if (!response.ok) throw new Error("page_check_unavailable");
    return JSON.parse(await readBounded(response));
  }

  function courseId(value) {
    return pageId(value);
  }

  function courseSummary(value) {
    const id = courseId(value?.id);
    const name = typeof value?.name === "string" ? value.name.trim().slice(0, 300) : "";
    return id && name ? { id, name } : null;
  }

  async function courseJson(id) {
    const exactId = courseId(id);
    if (!exactId) throw new Error("canvas_course_id_invalid");
    const response = await fetch(new URL(`/api/v1/courses/${exactId}`, location.origin), {
      credentials: "include",
      headers: { Accept: "application/json+canvas-string-ids" },
      cache: "no-store",
      redirect: "error",
    });
    if (!response.ok) throw new Error(`canvas_course_http_${response.status}`);
    const course = JSON.parse(await readBounded(response));
    if (courseId(course?.id) !== exactId) throw new Error("canvas_course_mismatch");
    return course;
  }

  function discoveryPage(value) {
    if (value === undefined) return 1;
    return Number.isSafeInteger(value) && value >= 1 ? value : null;
  }

  function discoveryNextPage(value, currentPage) {
    if (!value) return null;
    const url = new URL(value);
    if (url.origin !== location.origin || url.pathname !== "/api/v1/courses") throw new Error("canvas_courses_next_invalid");
    const allowed = new Set(["enrollment_state", "per_page", "page"]);
    if ([...url.searchParams.keys()].some((key) => !allowed.has(key))
      || url.searchParams.getAll("enrollment_state").length !== 1 || url.searchParams.get("enrollment_state") !== "active"
      || url.searchParams.getAll("per_page").length !== 1 || url.searchParams.get("per_page") !== String(MAX_DISCOVERED_COURSES)
      || url.searchParams.getAll("page").length !== 1) throw new Error("canvas_courses_next_invalid");
    const rawPage = url.searchParams.get("page");
    if (!/^[1-9][0-9]*$/.test(rawPage || "")) throw new Error("canvas_courses_next_invalid");
    const page = discoveryPage(Number(rawPage));
    if (!page || page !== currentPage + 1) throw new Error("canvas_courses_next_invalid");
    return page;
  }

  async function listCourses(pageValue) {
    const page = discoveryPage(pageValue);
    if (!page) throw new Error("canvas_courses_page_invalid");
    const url = new URL(`/api/v1/courses?enrollment_state=active&per_page=${MAX_DISCOVERED_COURSES}&page=${page}`, location.origin);
    const response = await fetch(url, {
      credentials: "include",
      headers: { Accept: "application/json+canvas-string-ids" },
      cache: "no-store",
      redirect: "error",
    });
    if (!response.ok) throw new Error(`canvas_courses_http_${response.status}`);
    const courses = JSON.parse(await readBounded(response));
    if (!Array.isArray(courses) || courses.length > MAX_DISCOVERED_COURSES) throw new Error("canvas_courses_invalid");
    const nextPage = discoveryNextPage(nextLink(response.headers.get("Link"), location.origin, url.pathname), page);
    return { courses: courses.map(courseSummary).filter(Boolean), complete: nextPage === null, nextPage };
  }

  async function checkedCourse(id) {
    const [profile, course] = await Promise.all([canvasProfile(), courseJson(id)]);
    const summary = courseSummary(course);
    if (!summary) throw new Error("canvas_course_invalid");
    return { profile, course: summary };
  }

  function pageTextChange(body, find, replacement) {
    const escape = (text) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    if (typeof body !== "string" || typeof find !== "string" || !find || typeof replacement !== "string" || find === replacement) throw new Error("page_text_invalid");
    const anchor = escape(find);
    const start = body.indexOf(anchor);
    if (start < 0 || body.indexOf(anchor, start + 1) !== -1) throw new Error("page_text_not_unique");
    const end = start + anchor.length;
    for (const entity of body.matchAll(/&(?:#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]+);?/g)) {
      const entityStart = entity.index;
      const entityEnd = entityStart + entity[0].length;
      if ((entityStart < start && start < entityEnd) || (entityStart < end && end < entityEnd)) throw new Error("page_text_inside_entity");
    }
    const tags = /<!--[\s\S]*?-->|<(?:(?:"[^"]*"|'[^']*'|[^'">])*)>/g;
    let blocked = false;
    for (const match of body.matchAll(tags)) {
      const at = match.index;
      if (at >= end) break;
      if (at + match[0].length > start) throw new Error("page_text_inside_markup");
      if (/^<(script|style|iframe|object|embed|textarea|title)\b/i.test(match[0])) blocked = true;
      if (/^<\/(script|style|iframe|object|embed|textarea|title)\s*>/i.test(match[0])) blocked = false;
    }
    if (blocked) throw new Error("page_text_inside_embedded_content");
    return body.slice(0, start) + escape(replacement) + body.slice(end);
  }

  function pageFieldsMatch(page, fields) {
    return fields && typeof fields === "object" && !Array.isArray(fields)
      && Object.keys(fields).length === 6
      && typeof fields.url === "string" && typeof fields.title === "string" && typeof fields.published === "boolean"
      && typeof fields.front_page === "boolean" && typeof fields.editing_roles === "string"
      && (typeof fields.publish_at === "string" || fields.publish_at === null)
      && ["url", "title", "published", "front_page", "editing_roles", "publish_at"].every((field) => Object.hasOwn(fields, field) && page[field] === fields[field]);
  }

  function contentImages(fragment) {
    return [...fragment.querySelectorAll("img")].filter((image) => !image.closest("svg, math"));
  }

  function contentFragment(body) {
    const template = document.createElement("template");
    template.innerHTML = body;
    return template.content;
  }

  function escapeAlt(value) {
    return value.replaceAll("&", "&amp;").replaceAll("\"", "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  }

  async function contentImageAltChange(body, guard) {
    if (!Number.isSafeInteger(guard.image_index) || guard.image_index < 1 || !Number.isSafeInteger(guard.image_start)
      || !Number.isSafeInteger(guard.image_end) || guard.image_start < 0 || guard.image_end < guard.image_start || guard.image_end >= body.length
      || typeof guard.image_tag_sha256 !== "string" || typeof guard.image_src_sha256 !== "string"
      || typeof guard.alt_text !== "string" || guard.alt_text.length > 500 || typeof guard.decorative !== "boolean"
      || (guard.decorative ? guard.alt_text !== "" : guard.alt_text.trim().length === 0)) throw new Error("page_image_alt_guard_invalid");
    const rawTag = body.slice(guard.image_start, guard.image_end + 1);
    if (!rawTag.startsWith("<") || !rawTag.endsWith(">") || await bodyDigest(rawTag) !== guard.image_tag_sha256) {
      throw new Error("page_image_alt_source_changed");
    }
    const rawFragment = contentFragment(rawTag);
    const rawImage = rawFragment.firstElementChild;
    if (rawFragment.childElementCount !== 1 || !(rawImage instanceof HTMLImageElement) || rawImage.hasAttribute("alt")) {
      throw new Error("page_image_alt_source_ambiguous");
    }
    const before = contentFragment(body);
    const beforeImages = contentImages(before);
    const selected = beforeImages[guard.image_index - 1];
    const source = selected?.getAttribute("src");
    if (!(selected instanceof HTMLImageElement) || !source || await bodyDigest(source) !== guard.image_src_sha256
      || selected.outerHTML !== rawImage.outerHTML || rawImage.getAttribute("src") !== source) {
      throw new Error("page_image_alt_target_changed");
    }
    const suffix = rawTag.endsWith("/>") ? "/>" : ">";
    const next = body.slice(0, guard.image_start) + rawTag.slice(0, -suffix.length) + ` alt="${escapeAlt(guard.alt_text)}"${suffix}` + body.slice(guard.image_end + 1);
    const after = contentFragment(next);
    const afterImages = contentImages(after);
    const changed = afterImages[guard.image_index - 1];
    if (!(changed instanceof HTMLImageElement) || afterImages.length !== beforeImages.length || changed.getAttribute("alt") !== guard.alt_text
      || changed.getAttribute("src") !== source) throw new Error("page_image_alt_dom_mismatch");
    const comparable = after.cloneNode(true);
    const comparableImage = contentImages(comparable)[guard.image_index - 1];
    if (!(comparableImage instanceof HTMLImageElement)) throw new Error("page_image_alt_dom_mismatch");
    comparableImage.removeAttribute("alt");
    if (!before.isEqualNode(comparable)) throw new Error("page_image_alt_dom_mismatch");
    return next;
  }

  function validPageGuard(guard) {
    const common = guard && typeof guard === "object" && !Array.isArray(guard) && pageId(guard.page_id)
      && pageId(guard.revision_id) && typeof guard.body_sha256 === "string" && /^[0-9a-f]{64}$/.test(guard.body_sha256)
      && pageFieldsMatch(guard.fields, guard.fields);
    if (!common) return false;
    if (guard.kind === "text") return typeof guard.find_text === "string" && guard.find_text.length > 0 && guard.find_text.length <= 10000
      && typeof guard.replace_text === "string" && guard.replace_text.length <= 10000
      && Object.keys(guard).every((key) => ["kind", "page_id", "revision_id", "body_sha256", "fields", "find_text", "replace_text"].includes(key));
    return guard.kind === "image_alt" && typeof guard.image_index === "number" && typeof guard.image_start === "number"
      && typeof guard.image_end === "number" && typeof guard.image_tag_sha256 === "string" && /^[0-9a-f]{64}$/.test(guard.image_tag_sha256)
      && typeof guard.image_src_sha256 === "string" && /^[0-9a-f]{64}$/.test(guard.image_src_sha256)
      && typeof guard.alt_text === "string" && typeof guard.decorative === "boolean"
      && (guard.decorative ? guard.alt_text === "" : guard.alt_text.trim().length > 0)
      && Object.keys(guard).every((key) => ["kind", "page_id", "revision_id", "body_sha256", "fields", "image_index", "image_start", "image_end", "image_tag_sha256", "image_src_sha256", "alt_text", "decorative"].includes(key));
  }

  async function checkPageSource(operation, args, url, expectedCourseId) {
    const guard = args.morrow_page_guard;
    if (operation.toolName !== "canvas_update_create_page_courses" || String(args.course_id) !== expectedCourseId
      || !validPageGuard(guard) || Object.keys(args).some((key) => key.startsWith("wiki_page_"))) throw new Error("page_check_invalid");
    const [page, revision] = await Promise.all([pageJson(url), pageJson(`${url.href}/revisions/latest`)]);
    if (pageId(page.page_id) !== guard.page_id || typeof page.body !== "string"
      || page.editor === "block_editor" || page.block_editor_attributes != null
      || await bodyDigest(page.body) !== guard.body_sha256
      || pageId(revision.revision_id) !== guard.revision_id || revision.latest !== true
      || revision.body !== page.body || revision.url !== page.url || revision.title !== page.title
      || !pageFieldsMatch(page, guard.fields)) {
      throw new Error("page_changed: This page changed or could not be checked. No change was sent. Create a new review from the current page.");
    }
    return guard.kind === "text"
      ? pageTextChange(page.body, guard.find_text, guard.replace_text)
      : await contentImageAltChange(page.body, guard);
  }

  async function verifyPageChange(args, url) {
    const guard = args.morrow_page_guard;
    const base = { schema: "morrow.browser-verification.v1", status: "unconfirmed", strategy: "lossless-page-revision", priorRevisionId: guard.revision_id };
    try {
      const [page, revision, history] = await Promise.all([pageJson(url), pageJson(`${url.href}/revisions/latest`), pageJson(`${url.href}/revisions?per_page=2`)]);
      const latestId = pageId(revision.revision_id);
      const exactHistory = Array.isArray(history) && history.length === 2
        && history.every((row) => row && pageId(row.revision_id))
        && new Set(history.map((row) => pageId(row.revision_id))).size === 2
        && history.some((row) => pageId(row.revision_id) === guard.revision_id)
        && history.some((row) => pageId(row.revision_id) === latestId && row.latest === true);
      const samePage = pageId(page.page_id) === guard.page_id && page.body === args.wiki_page_body
        && revision.body === args.wiki_page_body && revision.url === guard.fields.url && revision.title === guard.fields.title
        && pageFieldsMatch(page, guard.fields);
      if (!latestId || !exactHistory || latestId === guard.revision_id || revision.latest !== true || !samePage) return { ...base, reason: "page_or_revision_chain_did_not_match" };
      if (guard.kind === "image_alt") {
        const image = contentImages(contentFragment(page.body))[guard.image_index - 1];
        if (!(image instanceof HTMLImageElement) || image.getAttribute("alt") !== guard.alt_text || await bodyDigest(String(image.getAttribute("src") || "")) !== guard.image_src_sha256) {
          return { ...base, reason: "saved_image_alt_reaudit_did_not_match" };
        }
        return { ...base, status: "verified", createdRevisionId: latestId, evidence: "full_page_preserved_and_selected_image_alt_reaudited" };
      }
      return { ...base, status: "verified", createdRevisionId: latestId, evidence: "full_page_preserved_and_one_new_revision" };
    } catch {
      return { ...base, reason: "page_readback_incomplete" };
    }
  }

  function validImageAltGuard(guard, allowed) {
    return Number.isSafeInteger(guard.image_index) && guard.image_index >= 1
      && Number.isSafeInteger(guard.image_start) && guard.image_start >= 0
      && Number.isSafeInteger(guard.image_end) && guard.image_end >= guard.image_start
      && typeof guard.image_tag_sha256 === "string" && /^[0-9a-f]{64}$/.test(guard.image_tag_sha256)
      && typeof guard.image_src_sha256 === "string" && /^[0-9a-f]{64}$/.test(guard.image_src_sha256)
      && typeof guard.alt_text === "string" && guard.alt_text.length <= 500
      && typeof guard.decorative === "boolean" && (guard.decorative ? guard.alt_text === "" : guard.alt_text.trim().length > 0)
      && Object.keys(guard).every((key) => allowed.includes(key));
  }

  function canvasContentTarget(guard) {
    if (guard.kind === "assignment_image_alt") {
      return {
        toolName: "canvas_edit_assignment",
        operationKey: "PUT /v1/courses/{course_id}/assignments/{id}#edit_assignment",
        idField: "id",
        guardIdField: "assignment_id",
        contentField: "description",
        requestField: "assignment_description",
      };
    }
    if (guard.kind === "discussion_image_alt") {
      return {
        toolName: "canvas_update_topic_courses",
        operationKey: "PUT /v1/courses/{course_id}/discussion_topics/{topic_id}#update_topic_courses",
        idField: "topic_id",
        guardIdField: "topic_id",
        contentField: "message",
        requestField: "message",
      };
    }
    if (guard.kind === "classic_quiz_description_image_alt") {
      return {
        toolName: "canvas_edit_quiz",
        operationKey: "PUT /v1/courses/{course_id}/quizzes/{id}#edit_quiz",
        idField: "id",
        guardIdField: "quiz_id",
        contentField: "description",
        requestField: "quiz_description",
      };
    }
    if (guard.kind === "classic_quiz_question_image_alt") {
      return {
        toolName: "canvas_update_existing_quiz_question",
        operationKey: "PUT /v1/courses/{course_id}/quizzes/{quiz_id}/questions/{id}#update_existing_quiz_question",
        idField: "id",
        guardIdField: "question_id",
        quizIdField: "quiz_id",
        guardQuizIdField: "quiz_id",
        contentKind: "classic_quiz_question",
        selectorField: "classic_quiz_answer",
      };
    }
    if (guard.kind === "new_quiz_item_image_alt") {
      return {
        toolName: "canvas_update_quiz_item",
        operationKey: "PATCH /quiz/v1/courses/{course_id}/quizzes/{assignment_id}/items/{item_id}#update_quiz_item",
        idField: "item_id",
        guardIdField: "item_id",
        quizIdField: "assignment_id",
        guardQuizIdField: "assignment_id",
        contentField: "entry.item_body",
        requestField: "item_entry_item_body",
        contentKind: "new_quiz_item_body",
      };
    }
    if (guard.kind === "new_quiz_choice_image_alt") {
      return {
        toolName: "canvas_update_quiz_item",
        operationKey: "PATCH /quiz/v1/courses/{course_id}/quizzes/{assignment_id}/items/{item_id}#update_quiz_item",
        idField: "item_id",
        guardIdField: "item_id",
        quizIdField: "assignment_id",
        guardQuizIdField: "assignment_id",
        requestField: "item_entry_interaction_data",
        contentKind: "new_quiz_choice",
        selectorField: "choice_id",
      };
    }
    if (guard.kind === "new_quiz_answer_feedback_image_alt") {
      return {
        toolName: "canvas_update_quiz_item",
        operationKey: "PATCH /quiz/v1/courses/{course_id}/quizzes/{assignment_id}/items/{item_id}#update_quiz_item",
        idField: "item_id",
        guardIdField: "item_id",
        quizIdField: "assignment_id",
        guardQuizIdField: "assignment_id",
        requestField: "item_entry_answer_feedback",
        contentKind: "new_quiz_answer_feedback",
        selectorField: "choice_id",
      };
    }
    if (guard.kind === "new_quiz_feedback_image_alt") {
      return {
        toolName: "canvas_update_quiz_item",
        operationKey: "PATCH /quiz/v1/courses/{course_id}/quizzes/{assignment_id}/items/{item_id}#update_quiz_item",
        idField: "item_id",
        guardIdField: "item_id",
        quizIdField: "assignment_id",
        guardQuizIdField: "assignment_id",
        requestField: "item_entry_feedback_" + guard.feedback_type,
        contentKind: "new_quiz_feedback",
        selectorField: "feedback_type",
      };
    }
    return null;
  }

  function legacyPageGuardFromCanvasContent(guard) {
    if (guard?.kind !== "page_text" && guard?.kind !== "page_image_alt") return null;
    const { course_id: _courseId, ...pageGuard } = guard;
    return { ...pageGuard, kind: guard.kind === "page_text" ? "text" : "image_alt" };
  }

  function validCanvasContentPageGuard(guard) {
    if (!guard || typeof guard !== "object" || Array.isArray(guard) || !courseId(guard.course_id)
      || typeof guard.body_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(guard.body_sha256)) return false;
    const pageGuard = legacyPageGuardFromCanvasContent(guard);
    return Boolean(pageGuard && validPageGuard(pageGuard));
  }

  function validCanvasContentGuard(guard) {
    if (validCanvasContentPageGuard(guard)) return true;
    if (!guard || typeof guard !== "object" || Array.isArray(guard)
      || typeof guard.kind !== "string" || !courseId(guard.course_id)
      || typeof guard.body_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(guard.body_sha256)
      || typeof guard.protected_state_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(guard.protected_state_sha256)) return false;
    const target = canvasContentTarget(guard);
    const idFields = target?.guardQuizIdField ? [target.guardQuizIdField, target.guardIdField] : target ? [target.guardIdField] : [];
    const selectorValid = target?.selectorField === "choice_id"
      ? typeof guard.choice_id === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(guard.choice_id)
      : target?.selectorField === "feedback_type"
        ? ["correct", "incorrect", "neutral"].includes(guard.feedback_type)
        : target?.selectorField === "classic_quiz_answer"
          ? validClassicQuizAnswerSelector(guard)
          : !target?.selectorField;
    const selectorFields = target?.selectorField === "classic_quiz_answer" ? CLASSIC_QUIZ_ANSWER_SELECTOR_FIELDS
      : target?.selectorField ? [target.selectorField] : [];
    return Boolean(target && selectorValid && idFields.every((field) => pageId(guard[field]))
      && validImageAltGuard(guard, ["kind", "course_id", ...idFields, ...selectorFields, "body_sha256", "protected_state_sha256", "image_index", "image_start", "image_end", "image_tag_sha256", "image_src_sha256", "alt_text", "decorative"]));
  }

  function newQuizEntry(value) {
    if (!value || typeof value !== "object" || Array.isArray(value) || value.entry_type !== "Item"
      || !value.entry || typeof value.entry !== "object" || Array.isArray(value.entry)) throw new Error("canvas_content_target_changed");
    return value.entry;
  }

  function directNewQuizChoices(entry, choiceId) {
    const interaction = entry.interaction_data;
    if (!["choice", "multi-answer", "ordering"].includes(entry.interaction_type_slug)
      || !interaction || typeof interaction !== "object" || Array.isArray(interaction) || !Array.isArray(interaction.choices)
      || !interaction.choices.length || interaction.choices.some((choice) => !choice || typeof choice !== "object" || Array.isArray(choice)
        || typeof choice.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(choice.id) || typeof choice.item_body !== "string")) {
      throw new Error("canvas_content_target_changed");
    }
    const ids = interaction.choices.map((choice) => choice.id);
    if (new Set(ids).size !== ids.length) throw new Error("canvas_content_target_changed");
    const selected = interaction.choices.find((choice) => choice.id === choiceId);
    if (!selected) throw new Error("canvas_content_target_changed");
    return { interaction, selected };
  }

  // A Classic Quiz question repair names one answer field or none: the image is
  // in the question text, or in exactly one field of exactly one answer.
  const CLASSIC_QUIZ_ANSWER_SELECTOR_FIELDS = ["answer_id", "answer_field"];
  const CLASSIC_QUIZ_ANSWER_SELECTOR_HTML_FIELDS = ["answer_text", "answer_html"];

  function validClassicQuizAnswerSelector(guard) {
    if (!Object.hasOwn(guard, "answer_id") && !Object.hasOwn(guard, "answer_field")) return true;
    return Boolean(pageId(guard.answer_id)) && CLASSIC_QUIZ_ANSWER_SELECTOR_HTML_FIELDS.includes(guard.answer_field);
  }

  function classicQuizAnswerSelected(guard) {
    return Object.hasOwn(guard, "answer_id");
  }

  // Canvas rebuilds a Classic Quiz question from the whole request through
  // AssessmentQuestion.parse_question, so a field this write leaves out is
  // rebuilt from a default rather than preserved. Every field below is read
  // fresh and sent back unchanged, and a question whose fresh read cannot
  // supply one of them is refused instead of rebuilt. That round trip is
  // live-unverified: no connected Canvas tenant has proved it.
  const CLASSIC_QUIZ_QUESTION_TEXT_FIELDS = ["question_name", "question_text", "correct_comments", "incorrect_comments", "neutral_comments"];
  // Canvas derives these from the request. The write has no parameter for them,
  // and the protected-state digest still covers them.
  const CLASSIC_QUIZ_QUESTION_DERIVED_FIELDS = ["id", "quiz_id", "quiz_group_id", "assessment_question_id", "correct_comments_html", "incorrect_comments_html", "neutral_comments_html"];
  const CLASSIC_QUIZ_QUESTION_TYPES = ["multiple_choice_question", "true_false_question", "multiple_answers_question", "short_answer_question", "essay_question"];
  const CLASSIC_QUIZ_ANSWERLESS_QUESTION_TYPES = ["essay_question"];
  const CLASSIC_QUIZ_ANSWER_DERIVED_FIELDS = ["answer_comment_html"];
  const MAX_CLASSIC_QUIZ_ANSWERS = 100;

  // A field name Canvas returned is untrusted text, so a refusal repeats it
  // only when it is a plain identifier and says "an unexpected field" otherwise.
  function reportableFieldName(name) {
    return /^[A-Za-z0-9_]{1,60}$/.test(String(name)) ? String(name) : "an unexpected field";
  }

  function classicQuizPoints(value) {
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    return typeof value === "string" && /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value) ? value : null;
  }

  function classicQuizQuestionAnswers(value) {
    const answers = value.answers;
    if (CLASSIC_QUIZ_ANSWERLESS_QUESTION_TYPES.includes(value.question_type)) {
      if (answers !== undefined && (!Array.isArray(answers) || answers.length > 0)) {
        throw new Error("classic_quiz_question_unmodelled_state: Canvas returned answers for this essay question, and this repair cannot send them back. No change was sent.");
      }
      return [];
    }
    if (!Array.isArray(answers) || answers.length < 1 || answers.length > MAX_CLASSIC_QUIZ_ANSWERS) {
      throw new Error("classic_quiz_question_incomplete: Canvas did not return the answers for this question, and Morrow will not rebuild a question without them. No change was sent.");
    }
    const seen = new Set();
    return answers.map((answer) => {
      if (!plainObject(answer)) {
        throw new Error("classic_quiz_question_incomplete: Canvas did not return one of this question's answers as a record, and Morrow will not rebuild a question without it. No change was sent.");
      }
      const unmodelled = Object.keys(answer).find((field) => !CLASSIC_QUIZ_ANSWER_FIELDS.includes(field) && !CLASSIC_QUIZ_ANSWER_DERIVED_FIELDS.includes(field));
      if (unmodelled) {
        throw new Error(`classic_quiz_question_unmodelled_state: Canvas returned ${reportableFieldName(unmodelled)} on an answer of this question, and this repair cannot send it back. No change was sent.`);
      }
      const id = pageId(answer.id);
      if (!id || seen.has(id)) {
        throw new Error("classic_quiz_question_incomplete: Canvas did not return one exact identifier for every answer of this question, and Morrow will not rebuild a question without them. No change was sent.");
      }
      seen.add(id);
      if (typeof answer.answer_text !== "string" || !Number.isInteger(answer.answer_weight) || answer.answer_weight < 0 || answer.answer_weight > 100) {
        throw new Error("classic_quiz_question_incomplete: Canvas did not return answer_text and answer_weight for every answer of this question, and Morrow will not rebuild a question without them. No change was sent.");
      }
      const rebuilt = { id, answer_text: answer.answer_text, answer_weight: answer.answer_weight };
      for (const field of ["answer_comments", "answer_html", "text_after_answers"]) {
        if (!Object.hasOwn(answer, field)) continue;
        if (typeof answer[field] !== "string") {
          throw new Error(`classic_quiz_question_incomplete: Canvas returned ${field} on an answer of this question in a form Morrow cannot send back. No change was sent.`);
        }
        rebuilt[field] = answer[field];
      }
      return rebuilt;
    });
  }

  /** The complete Classic Quiz question payload rebuilt from one fresh read, or a refusal that names what stopped it. */
  function classicQuizQuestion(value, guard) {
    if (!plainObject(value) || pageId(value.quiz_id) !== guard.quiz_id) throw new Error("canvas_content_target_changed");
    if (value.quiz_group_id !== undefined && value.quiz_group_id !== null) {
      throw new Error("classic_quiz_question_group_linked: This question belongs to a question group, so Canvas can rebuild it from a question bank and a change here could reach other quizzes. No change was sent.");
    }
    if (!CLASSIC_QUIZ_QUESTION_TYPES.includes(value.question_type)) {
      throw new Error("classic_quiz_question_type_unsupported: Morrow repairs images only in multiple choice, true or false, multiple answers, short answer, and essay Classic Quiz questions. No change was sent.");
    }
    const unmodelled = Object.keys(value).find((field) => !CLASSIC_QUIZ_QUESTION_TEXT_FIELDS.includes(field)
      && !CLASSIC_QUIZ_QUESTION_DERIVED_FIELDS.includes(field)
      && !["question_type", "points_possible", "position", "text_after_answers", "answers"].includes(field));
    if (unmodelled) {
      throw new Error(`classic_quiz_question_unmodelled_state: Canvas returned ${reportableFieldName(unmodelled)} for this question, and this repair cannot send it back. No change was sent.`);
    }
    for (const field of CLASSIC_QUIZ_QUESTION_TEXT_FIELDS) {
      if (typeof value[field] !== "string") {
        throw new Error(`classic_quiz_question_incomplete: Canvas did not return ${field} for this question, and Morrow will not rebuild a question without it. No change was sent.`);
      }
    }
    const points = classicQuizPoints(value.points_possible);
    if (points === null) {
      throw new Error("classic_quiz_question_incomplete: Canvas did not return points_possible for this question, and Morrow will not rebuild a question without it. No change was sent.");
    }
    if (!Number.isSafeInteger(value.position) || value.position < 1) {
      throw new Error("classic_quiz_question_incomplete: Canvas did not return position for this question, and Morrow will not rebuild a question without it. No change was sent.");
    }
    if (Object.hasOwn(value, "text_after_answers") && typeof value.text_after_answers !== "string") {
      throw new Error("classic_quiz_question_incomplete: Canvas returned text_after_answers for this question in a form Morrow cannot send back. No change was sent.");
    }
    const answers = classicQuizQuestionAnswers(value);
    if (classicQuizAnswerSelected(guard) && answers.filter((answer) => answer.id === guard.answer_id).length !== 1) {
      throw new Error("classic_quiz_question_answer_unavailable: The selected answer is no longer one exact answer of this question. No change was sent.");
    }
    return { points, answers };
  }

  function classicQuizQuestionBody(value, guard) {
    const { answers } = classicQuizQuestion(value, guard);
    if (!classicQuizAnswerSelected(guard)) return value.question_text;
    const selected = answers.find((answer) => answer.id === guard.answer_id);
    if (typeof selected[guard.answer_field] !== "string") {
      throw new Error("classic_quiz_question_answer_unavailable: Canvas did not return the selected answer field of this question. No change was sent.");
    }
    return selected[guard.answer_field];
  }

  function contentBody(value, target, guard) {
    if (target.contentKind === "classic_quiz_question") return classicQuizQuestionBody(value, guard);
    if (target.contentKind === "new_quiz_item_body") return newQuizEntry(value).item_body;
    if (target.contentKind === "new_quiz_choice") return directNewQuizChoices(newQuizEntry(value), guard.choice_id).selected.item_body;
    if (target.contentKind === "new_quiz_answer_feedback") {
      const entry = newQuizEntry(value);
      if (entry.interaction_type_slug !== "choice") throw new Error("canvas_content_target_changed");
      directNewQuizChoices(entry, guard.choice_id);
      if (!entry.answer_feedback || typeof entry.answer_feedback !== "object" || Array.isArray(entry.answer_feedback)
        || Object.entries(entry.answer_feedback).some(([id, content]) => !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(id) || typeof content !== "string")
        || typeof entry.answer_feedback[guard.choice_id] !== "string") throw new Error("canvas_content_target_changed");
      return entry.answer_feedback[guard.choice_id];
    }
    if (target.contentKind === "new_quiz_feedback") {
      const feedback = newQuizEntry(value).feedback;
      if (!feedback || typeof feedback !== "object" || Array.isArray(feedback) || typeof feedback[guard.feedback_type] !== "string") throw new Error("canvas_content_target_changed");
      return feedback[guard.feedback_type];
    }
    return value?.[target.contentField];
  }

  function contentWriteArguments(before, target, guard, body) {
    if (target.contentKind === "classic_quiz_question") {
      const { points, answers } = classicQuizQuestion(before, guard);
      const selected = classicQuizAnswerSelected(guard);
      const rebuilt = selected
        ? answers.map((answer) => answer.id === guard.answer_id ? { ...answer, [guard.answer_field]: body } : answer)
        : answers;
      return {
        question_question_name: before.question_name,
        question_question_text: selected ? before.question_text : body,
        question_question_type: before.question_type,
        question_points_possible: points,
        question_position: String(before.position),
        question_correct_comments: before.correct_comments,
        question_incorrect_comments: before.incorrect_comments,
        question_neutral_comments: before.neutral_comments,
        ...(typeof before.text_after_answers === "string" ? { question_text_after_answers: before.text_after_answers } : {}),
        ...(rebuilt.length ? { question_answers: rebuilt } : {}),
      };
    }
    if (target.contentKind === "new_quiz_choice") {
      const { interaction } = directNewQuizChoices(newQuizEntry(before), guard.choice_id);
      return { item_entry_interaction_data: {
        ...interaction,
        choices: interaction.choices.map((choice) => choice.id === guard.choice_id ? { ...choice, item_body: body } : choice),
      } };
    }
    if (target.contentKind === "new_quiz_answer_feedback") {
      const entry = newQuizEntry(before);
      if (!entry.answer_feedback || typeof entry.answer_feedback !== "object" || Array.isArray(entry.answer_feedback)) throw new Error("canvas_content_target_changed");
      return { item_entry_answer_feedback: { ...entry.answer_feedback, [guard.choice_id]: body } };
    }
    return { [target.requestField]: body };
  }

  function requestedContentBody(args, target, guard) {
    if (target.contentKind === "classic_quiz_question") {
      if (!classicQuizAnswerSelected(guard)) return typeof args.question_question_text === "string" ? args.question_question_text : null;
      const answers = Array.isArray(args.question_answers) ? args.question_answers : [];
      const selected = answers.filter((answer) => plainObject(answer) && answer.id === guard.answer_id);
      return selected.length === 1 && typeof selected[0][guard.answer_field] === "string" ? selected[0][guard.answer_field] : null;
    }
    if (target.contentKind === "new_quiz_choice") {
      const interaction = args.item_entry_interaction_data;
      if (!interaction || typeof interaction !== "object" || Array.isArray(interaction) || !Array.isArray(interaction.choices)) return null;
      const selected = interaction.choices.find((choice) => choice && typeof choice === "object" && !Array.isArray(choice) && choice.id === guard.choice_id);
      return typeof selected?.item_body === "string" ? selected.item_body : null;
    }
    if (target.contentKind === "new_quiz_answer_feedback") {
      const feedback = args.item_entry_answer_feedback;
      return feedback && typeof feedback === "object" && !Array.isArray(feedback) && typeof feedback[guard.choice_id] === "string" ? feedback[guard.choice_id] : null;
    }
    return typeof args[target.requestField] === "string" ? args[target.requestField] : null;
  }

  async function protectedContentState(value, target, expectedCourseId, expectedItemId, guard) {
    if (!value || typeof value !== "object" || Array.isArray(value)
      || pageId(value.id) !== expectedItemId || (Object.hasOwn(value, "course_id") && courseId(value.course_id) !== expectedCourseId)
      || typeof contentBody(value, target, guard) !== "string") throw new Error("canvas_content_target_changed");
    const protectedFields = structuredClone(value);
    if (target.contentKind === "classic_quiz_question") {
      if (!classicQuizAnswerSelected(guard)) delete protectedFields.question_text;
      else {
        const answer = Array.isArray(protectedFields.answers)
          ? protectedFields.answers.filter((candidate) => plainObject(candidate) && pageId(candidate.id) === guard.answer_id)
          : [];
        if (answer.length !== 1) throw new Error("canvas_content_target_changed");
        delete answer[0][guard.answer_field];
      }
    } else if (target.contentKind?.startsWith("new_quiz_")) {
      const entry = newQuizEntry(protectedFields);
      delete entry.updated_at;
      if (target.contentKind === "new_quiz_item_body") delete entry.item_body;
      else if (target.contentKind === "new_quiz_choice") {
        const { selected } = directNewQuizChoices(entry, guard.choice_id);
        delete selected.item_body;
      } else if (target.contentKind === "new_quiz_answer_feedback") {
        if (!entry.answer_feedback || typeof entry.answer_feedback !== "object" || Array.isArray(entry.answer_feedback)) throw new Error("canvas_content_target_changed");
        delete entry.answer_feedback[guard.choice_id];
      } else if (target.contentKind === "new_quiz_feedback") {
        if (!entry.feedback || typeof entry.feedback !== "object" || Array.isArray(entry.feedback)) throw new Error("canvas_content_target_changed");
        delete entry.feedback[guard.feedback_type];
      }
    } else delete protectedFields[target.contentField];
    delete protectedFields.updated_at;
    return await bodyDigest(stable(protectedFields));
  }

  async function checkCanvasContentSource(operation, args, url, expectedCourseId) {
    const guard = args.morrow_canvas_content_guard;
    if (!validCanvasContentGuard(guard) || guard.course_id !== expectedCourseId) throw new Error("canvas_content_guard_invalid");
    if (validCanvasContentPageGuard(guard)) {
      const pageGuard = legacyPageGuardFromCanvasContent(guard);
      if (operation.toolName !== "canvas_update_create_page_courses" || operation.key !== "PUT /v1/courses/{course_id}/pages/{url_or_id}#update_create_page_courses"
        || !pageGuard || !Object.keys(args).every((key) => ["course_id", "url_or_id", "morrow_canvas_content_guard"].includes(key))) {
        throw new Error("canvas_content_check_invalid");
      }
      return {
        target: { requestField: "wiki_page_body", pageGuard },
        writeArguments: { wiki_page_body: await checkPageSource(operation, { ...args, morrow_page_guard: pageGuard }, url, expectedCourseId) },
      };
    }
    const target = canvasContentTarget(guard);
    const idFields = target?.quizIdField ? [target.quizIdField, target.idField] : target ? [target.idField] : [];
    const guardIdFields = target?.guardQuizIdField ? [target.guardQuizIdField, target.guardIdField] : target ? [target.guardIdField] : [];
    if (!target || operation.toolName !== target.toolName || operation.key !== target.operationKey
      || String(args.course_id) !== expectedCourseId || !idFields.every((field, index) => String(args[field]) === guard[guardIdFields[index]])
      || !Object.keys(args).every((key) => ["course_id", ...idFields, "morrow_canvas_content_guard"].includes(key))) {
      throw new Error("canvas_content_check_invalid");
    }
    const before = await pageJson(url);
    const itemId = guard[target.guardIdField];
    const body = contentBody(before, target, guard);
    if (typeof body !== "string" || await bodyDigest(body) !== guard.body_sha256
      || await protectedContentState(before, target, expectedCourseId, itemId, guard) !== guard.protected_state_sha256) {
      throw new Error("canvas_content_changed: This Canvas content changed or could not be checked. No change was sent. Create a new review from the current content.");
    }
    const nextBody = await contentImageAltChange(body, guard);
    return { target, writeArguments: contentWriteArguments(before, target, guard, nextBody) };
  }

  async function verifyCanvasContentChange(args, url, expectedCourseId) {
    const guard = args.morrow_canvas_content_guard;
    if (validCanvasContentPageGuard(guard)) {
      const pageGuard = legacyPageGuardFromCanvasContent(guard);
      return await verifyPageChange({ ...args, morrow_page_guard: pageGuard }, url);
    }
    const target = validCanvasContentGuard(guard) ? canvasContentTarget(guard) : null;
    const base = { schema: "morrow.browser-verification.v1", status: "unconfirmed", strategy: "lossless-canvas-content" };
    if (!target) return { ...base, reason: "canvas_content_guard_missing" };
    try {
      const after = await pageJson(url);
      const itemId = guard[target.guardIdField];
      const body = contentBody(after, target, guard);
      if (typeof body !== "string" || body !== requestedContentBody(args, target, guard)
        || await protectedContentState(after, target, expectedCourseId, itemId, guard) !== guard.protected_state_sha256) {
        return { ...base, status: "mismatch", reason: "saved_canvas_content_did_not_preserve_target_state" };
      }
      const image = contentImages(contentFragment(body))[guard.image_index - 1];
      if (!(image instanceof HTMLImageElement) || image.getAttribute("alt") !== guard.alt_text
        || await bodyDigest(String(image.getAttribute("src") || "")) !== guard.image_src_sha256) {
        return { ...base, status: "mismatch", reason: "saved_canvas_content_image_alt_reaudit_did_not_match" };
      }
      return { ...base, status: "verified", evidence: "full_canvas_content_preserved_and_selected_image_alt_reaudited" };
    } catch {
      return { ...base, reason: "canvas_content_readback_incomplete" };
    }
  }

  async function readBounded(response) {
    if (!response.body) return "";
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("canvas_response_too_large");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(bytes);
  }

  function parsePayload(text, contentType) {
    if (!text) return null;
    if (/application\/(?:json|problem\+json)|text\/json/i.test(contentType || "")) {
      return JSON.parse(text);
    }
    return { text: text.slice(0, MAX_RESPONSE_BYTES) };
  }

  // Canvas answers a list read with a Link header. Only a link on this origin and
  // on the exact path Morrow requested is followed, so a redirected or foreign
  // next link refuses the read instead of silently reading somewhere else. Real
  // Canvas Link header shapes are live-unverified, so a Canvas deployment that
  // paginates onto a different path would stop here rather than be followed.
  function linkHeaderUrls(value, origin, pathname, requested) {
    const links = new Map();
    const raw = String(value || "");
    if (!raw.trim()) return links;
    for (const part of raw.split(",")) {
      const match = /^\s*<([^>]+)>;\s*rel="?([a-z]+)"?\s*$/i.exec(part);
      if (!match) throw new Error("canvas_pagination_header_refused");
      const relation = match[2].toLowerCase();
      const url = new URL(match[1]);
      if (url.origin !== origin || url.pathname !== pathname) {
        if (relation === "next") throw new Error("canvas_pagination_origin_refused");
        continue;
      }
      if (relation === "next" && requested && !sameRequestParameters(url, requested)) {
        throw new Error("canvas_pagination_parameters_refused");
      }
      if (links.has(relation)) throw new Error("canvas_pagination_header_refused");
      links.set(relation, url);
    }
    return links;
  }

  function nextLink(value, origin, pathname) {
    return linkHeaderUrls(value, origin, pathname).get("next")?.href || null;
  }

  function paginationPage(url) {
    const raw = url ? url.searchParams.get("page") : null;
    return /^[1-9][0-9]{0,8}$/.test(raw || "") ? Number(raw) : null;
  }

  // Canvas sends rel="last" with numeric pagination and omits it for bookmark
  // cursors, so the exact unread page count is available only in the numeric
  // case. null means "not stated by Canvas", never zero. Live-unverified.
  function unreadPageCount(links) {
    const next = paginationPage(links.get("next"));
    const last = paginationPage(links.get("last"));
    return next !== null && last !== null && last >= next ? last - next + 1 : null;
  }

  // A later page must preserve every query that defined the first page. Canvas
  // may add one bounded per_page value and one page cursor. It may not remove a
  // filter, change a value, repeat a control, or add a new query that widens the
  // read.
  function sameRequestParameters(resumed, requested) {
    const requestedNames = new Set(requested.searchParams.keys());
    const resumedNames = new Set(resumed.searchParams.keys());
    for (const name of requestedNames) {
      if (name === "page" || name === "per_page") continue;
      const expected = requested.searchParams.getAll(name);
      const observed = resumed.searchParams.getAll(name);
      if (observed.length !== expected.length || expected.some((value, index) => observed[index] !== value)) return false;
    }
    for (const name of resumedNames) if (name !== "page" && name !== "per_page" && !requestedNames.has(name)) return false;
    const pages = resumed.searchParams.getAll("page");
    if (pages.length !== 1 || pages[0].length < 1 || pages[0].length > 1_024) return false;
    const expectedPerPage = requested.searchParams.getAll("per_page");
    const observedPerPage = resumed.searchParams.getAll("per_page");
    if (expectedPerPage.length > 0) {
      if (observedPerPage.length !== expectedPerPage.length
        || expectedPerPage.some((value, index) => observedPerPage[index] !== value)) return false;
    } else if (observedPerPage.length > 1
      || (observedPerPage.length === 1 && !/^(?:[1-9]|[1-9][0-9]|100)$/.test(observedPerPage[0]))) return false;
    return true;
  }

  function encodeResumeToken(href, pagesRead) {
    return btoa(JSON.stringify({ v: 1, p: pagesRead, u: href })).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  }

  // The token is opaque to every caller: it is only ever decoded here, and it is
  // accepted only when it names this origin, the exact path of the request the
  // caller just made, and a page count inside the resumed-sequence cap.
  function decodeResumeToken(value, requested) {
    if (typeof value !== "string" || value.length < 8 || value.length > 4_096 || !/^[A-Za-z0-9_-]+$/.test(value)) {
      throw new Error("canvas_pagination_resume_refused");
    }
    let decoded;
    try {
      decoded = JSON.parse(atob(value.replaceAll("-", "+").replaceAll("_", "/")));
    } catch {
      throw new Error("canvas_pagination_resume_refused");
    }
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded) || decoded.v !== 1
      || !Number.isSafeInteger(decoded.p) || decoded.p < 1 || decoded.p >= MAX_RESUMED_PAGES
      || typeof decoded.u !== "string") {
      throw new Error("canvas_pagination_resume_refused");
    }
    let url;
    try {
      url = new URL(decoded.u);
    } catch {
      throw new Error("canvas_pagination_resume_refused");
    }
    if (url.protocol !== location.protocol || url.origin !== location.origin
      || url.pathname !== requested.pathname || url.hash !== "" || !sameRequestParameters(url, requested)) {
      throw new Error("canvas_pagination_resume_refused");
    }
    return { href: url.href, pagesRead: decoded.p };
  }

  function listResumeRequest(args, isRead) {
    const value = args.morrow_list_resume;
    if (value === undefined) return null;
    if (!isRead || !value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).some((key) => key !== "next_page")) {
      throw new Error("canvas_pagination_resume_refused");
    }
    return value;
  }

  function appendValue(target, name, value) {
    if (Array.isArray(value)) {
      for (const entry of value) target.append(name, typeof entry === "object" ? JSON.stringify(entry) : String(entry));
      return;
    }
    target.append(name, typeof value === "object" ? JSON.stringify(value) : String(value));
  }

  function wirePath(name) {
    return String(name || "").match(/[^\[\]]+/g) || [];
  }

  function assignJsonValue(target, name, value) {
    const path = wirePath(name);
    if (path.length === 0) throw new TypeError("canvas_body_parameter_invalid");
    let current = target;
    for (let index = 0; index < path.length - 1; index += 1) {
      const part = path[index];
      if (!current[part] || typeof current[part] !== "object" || Array.isArray(current[part])) current[part] = {};
      current = current[part];
    }
    current[path[path.length - 1]] = value;
  }

  // The two New Quizzes write rules, copied from
  // src/new-quiz-write-contract.js because Chrome injects this file as a
  // classic script with no module scope.
  // scripts/test/canvas-new-quiz-write-contract.test.mjs executes both copies
  // and fails if one of them disagrees with that file.
  //
  // Every POST and PATCH on /api/quiz/v1 sends a JSON body, not only the two
  // item routes: New Quizzes is a separate service from the Canvas Rails API,
  // and the harvested client sends JSON for all of them. Both encodings are
  // live-unverified against a Morrow-connected tenant.
  function usesJsonBody(operation) {
    return operation?.family === "new-quizzes"
      && typeof operation.path === "string" && operation.path.startsWith("/quiz/v1/")
      && ["POST", "PATCH"].includes(operation.method);
  }

  const NEW_QUIZ_SETTINGS_MERGE_GROUPS = ["filters", "multiple_attempts", "result_view_settings"];
  const NEW_QUIZ_SETTINGS_WIRE_PREFIX = "quiz[quiz_settings]";
  const NEW_QUIZ_SETTINGS_OPERATION_KEY = "PATCH /quiz/v1/courses/{course_id}/quizzes/{assignment_id}#update_single_quiz";

  function plainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function mergeQuizSettings(current, requested) {
    const base = plainObject(current) ? current : {};
    const change = plainObject(requested) ? requested : {};
    const merged = { ...base, ...change };
    const preserved = [];
    for (const key of Object.keys(base)) {
      const grouped = NEW_QUIZ_SETTINGS_MERGE_GROUPS.includes(key) && plainObject(base[key]);
      if (grouped && plainObject(change[key])) {
        merged[key] = { ...base[key], ...change[key] };
        for (const leaf of Object.keys(base[key])) {
          if (!Object.hasOwn(change[key], leaf)) preserved.push(`${key}.${leaf}`);
        }
      } else if (Object.hasOwn(change, key)) {
        // The caller replaced the whole value, group or not, so nothing here was kept.
      } else if (grouped) {
        for (const leaf of Object.keys(base[key])) preserved.push(`${key}.${leaf}`);
      } else {
        preserved.push(key);
      }
    }
    return { merged, preserved: preserved.sort() };
  }

  // The settings leaves this request actually carries, rebuilt as the nested
  // object the New Quizzes service expects. null means the change touches no
  // setting, so the title, instructions, dates and points of a quiz can still
  // be changed without reading its settings first.
  function requestedQuizSettings(operation, args) {
    const requested = {};
    let present = false;
    for (const parameter of operation.parameters || []) {
      const wireName = String(parameter.wireName || "");
      if (parameter.location !== "form" || !wireName.startsWith(NEW_QUIZ_SETTINGS_WIRE_PREFIX)) continue;
      const value = args[parameter.inputName];
      if (value === undefined) continue;
      present = true;
      assignJsonValue(requested, wireName.slice(NEW_QUIZ_SETTINGS_WIRE_PREFIX.length), value);
    }
    return present ? requested : null;
  }

  function validNewQuizSettingsGuard(guard) {
    return plainObject(guard) && Object.keys(guard).length === 1
      && typeof guard.current_quiz_settings_sha256 === "string"
      && /^[0-9a-f]{64}$/.test(guard.current_quiz_settings_sha256);
  }

  // A partial quiz_settings PATCH can replace the whole block, so changing one
  // setting can delete every setting nobody asked about. The merge is the
  // safety property, not an advisory step: a quiz Morrow cannot read is a
  // refusal, never a warning, and the request is not sent.
  async function checkNewQuizSettingsSource(operation, args, url) {
    const guard = args.morrow_new_quiz_settings_guard;
    const settings = operation.key === NEW_QUIZ_SETTINGS_OPERATION_KEY ? requestedQuizSettings(operation, args) : null;
    if (!settings) {
      if (guard !== undefined) {
        throw new Error("new_quiz_settings_guard_refused: This change does not alter New Quiz settings, so it must not carry a settings guard. No change was sent.");
      }
      return null;
    }
    if (!validNewQuizSettingsGuard(guard)) {
      throw new Error("new_quiz_settings_guard_required: This New Quiz settings change needs the current settings from a fresh read of this quiz. No change was sent.");
    }
    let before;
    try {
      before = await pageJson(url);
    } catch {
      throw new Error("new_quiz_settings_read_failed: Morrow could not read this quiz before changing its settings. No change was sent.");
    }
    const quizId = pageId(args.assignment_id);
    if (!quizId || !plainObject(before) || pageId(before.id) !== quizId || !plainObject(before.quiz_settings)
      || (before.course_id !== undefined && pageId(before.course_id) !== pageId(args.course_id))) {
      throw new Error("new_quiz_settings_target_changed: This quiz does not report the settings Morrow has to preserve. No change was sent.");
    }
    if (await bodyDigest(stable(before.quiz_settings)) !== guard.current_quiz_settings_sha256) {
      throw new Error("new_quiz_settings_stale: These New Quiz settings changed in Canvas after they were read. No change was sent. Read the settings again and make a new change.");
    }
    return { ...mergeQuizSettings(before.quiz_settings, settings), before: before.quiz_settings };
  }

  async function verifyNewQuizSettingsChange(args, url, expectedSettings, previousSettings = null) {
    const base = { schema: "morrow.browser-verification.v1", strategy: "new-quiz-settings" };
    let saved;
    try {
      saved = await pageJson(url);
    } catch {
      return { ...base, status: "unconfirmed", reason: "new_quiz_settings_readback_unavailable" };
    }
    if (!plainObject(saved) || pageId(saved.id) !== pageId(args.assignment_id)
      || (saved.course_id !== undefined && pageId(saved.course_id) !== pageId(args.course_id))) {
      return { ...base, status: "mismatch", reason: "new_quiz_settings_readback_target_changed" };
    }
    if (!plainObject(saved.quiz_settings)) {
      return { ...base, status: "unconfirmed", reason: "new_quiz_settings_readback_missing" };
    }
    const savedSettings = stable(saved.quiz_settings);
    if (savedSettings !== stable(expectedSettings)) {
      if (plainObject(previousSettings) && savedSettings === stable(previousSettings)) {
        return { ...base, status: "mismatch", reason: "new_quiz_settings_readback_no_effect" };
      }
      return { ...base, status: "mismatch", reason: "new_quiz_settings_readback_mismatch" };
    }
    return { ...base, status: "verified", evidence: "complete_settings_reread_after_write" };
  }

  // The New Quiz item id rule, copied from src/new-quiz-item-guard.js because
  // Chrome injects this file as a classic script with no module scope.
  // scripts/test/canvas-new-quiz-item-guard.test.mjs executes both copies and
  // fails if one of them disagrees with that file.
  //
  // In-place updates retain every interaction id. Morrow has not verified
  // how structural edits merge on a live tenant, so structural changes use
  // separate reviewed delete and create operations.
  const NEW_QUIZ_INTERACTION_ID_GROUPS = [
    "choices", "questions", "blanks", "entries", "categories", "distractors", "word_bank_choices",
  ];
  const NEW_QUIZ_ITEM_CREATE_KEY = "POST /quiz/v1/courses/{course_id}/quizzes/{assignment_id}/items#create_quiz_item";
  const NEW_QUIZ_ITEM_OPERATION_KEY = "PATCH /quiz/v1/courses/{course_id}/quizzes/{assignment_id}/items/{item_id}#update_quiz_item";
  const NEW_QUIZ_ITEM_DELETE_KEY = "DELETE /quiz/v1/courses/{course_id}/quizzes/{assignment_id}/items/{item_id}#delete_quiz_item";
  const NEW_QUIZ_CREATE_KEY = "POST /quiz/v1/courses/{course_id}/quizzes#create_new_quiz";
  const NEW_QUIZ_DELETE_KEY = "DELETE /quiz/v1/courses/{course_id}/quizzes/{assignment_id}#delete_new_quiz";
  const NEW_QUIZ_COURSE_ACCOMMODATIONS_KEY = "POST /quiz/v1/courses/{course_id}/accommodations#set_course_level_accommodations";
  const NEW_QUIZ_QUIZ_ACCOMMODATIONS_KEY = "POST /quiz/v1/courses/{course_id}/quizzes/{assignment_id}/accommodations#set_quiz_level_accommodations";
  const NEW_QUIZ_REPORT_KEY = "POST /quiz/v1/courses/{course_id}/quizzes/{assignment_id}/reports#create_quiz_report";
  const NEW_QUIZ_ITEM_LIMIT = 10_000;
  const NEW_QUIZ_ITEM_PAGE_LIMIT = 100;

  function newQuizMemberId(member) {
    if (!plainObject(member)) return null;
    if (typeof member.id === "number" && Number.isSafeInteger(member.id)) return String(member.id);
    return typeof member.id === "string" && member.id.trim() !== "" && member.id.length <= 200 ? member.id : null;
  }

  function newQuizInteractionIds(item) {
    const entry = plainObject(item) ? item.entry : null;
    const interaction = plainObject(entry) ? entry.interaction_data : null;
    const ids = {};
    if (!plainObject(interaction)) return ids;
    for (const group of NEW_QUIZ_INTERACTION_ID_GROUPS) {
      const members = interaction[group];
      if (Array.isArray(members)) {
        ids[group] = members.map(newQuizMemberId);
        continue;
      }
      if (plainObject(members)) {
        ids[group] = Object.entries(members).map(([key, member]) => newQuizMemberId(member) === key ? key : null);
      }
    }
    return ids;
  }

  function newQuizIdsPreserved(before, after) {
    const left = newQuizInteractionIds(before);
    const right = newQuizInteractionIds(after);
    for (const group of new Set([...Object.keys(left), ...Object.keys(right)])) {
      const leftIds = left[group];
      const rightIds = right[group];
      if (!leftIds || !rightIds) return false;
      if (leftIds.includes(null) || rightIds.includes(null)) return false;
      const leftSet = new Set(leftIds);
      const rightSet = new Set(rightIds);
      if (leftSet.size !== leftIds.length || rightSet.size !== rightIds.length) return false;
      if (leftSet.size !== rightSet.size || [...leftSet].some((id) => !rightSet.has(id))) return false;
    }
    return true;
  }

  function validNewQuizPositionGuard(guard) {
    return plainObject(guard) && Object.keys(guard).length === 4
      && guard.kind === "new_quiz_item_position"
      && typeof guard.before_item_ids_sha256 === "string" && /^[0-9a-f]{64}$/.test(guard.before_item_ids_sha256)
      && typeof guard.expected_item_ids_sha256 === "string" && /^[0-9a-f]{64}$/.test(guard.expected_item_ids_sha256)
      && Array.isArray(guard.expected_item_ids) && guard.expected_item_ids.length > 0 && guard.expected_item_ids.length <= NEW_QUIZ_ITEM_LIMIT
      && guard.expected_item_ids.every((id) => pageId(id) !== null)
      && new Set(guard.expected_item_ids.map(String)).size === guard.expected_item_ids.length;
  }

  function newQuizItemsListUrl(itemUrl) {
    const listUrl = new URL(itemUrl);
    if (/\/items\/[1-9][0-9]{0,18}$/.test(listUrl.pathname)) {
      listUrl.pathname = listUrl.pathname.replace(/\/[1-9][0-9]{0,18}$/, "");
    } else if (!/\/items$/.test(listUrl.pathname)) {
      throw new Error("new_quiz_item_list_target_invalid");
    }
    listUrl.search = "";
    listUrl.searchParams.set("per_page", String(NEW_QUIZ_ITEM_PAGE_LIMIT));
    return listUrl;
  }

  function newQuizItemPayloadFromArguments(operation, args) {
    const root = {};
    let present = false;
    for (const parameter of operation.parameters || []) {
      const wireName = String(parameter.wireName || "");
      if (parameter.location !== "form" || !wireName.startsWith("item[")) continue;
      const value = args[parameter.inputName];
      if (value === undefined) continue;
      assignJsonValue(root, wireName, value);
      present = true;
    }
    return present && plainObject(root.item) ? root.item : null;
  }

  function validNewQuizLifecycleGuard(guard, kind) {
    if (!plainObject(guard) || guard.kind !== kind
      || typeof guard.before_items_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(guard.before_items_sha256)) return false;
    if (kind === "create") {
      return Object.keys(guard).length === 3
        && typeof guard.payload_sha256 === "string" && /^[0-9a-f]{64}$/.test(guard.payload_sha256);
    }
    return Object.keys(guard).length === 5
      && typeof guard.target_item_sha256 === "string" && /^[0-9a-f]{64}$/.test(guard.target_item_sha256)
      && pageId(guard.item_id) !== null && guard.entry_type === "Item";
  }

  async function checkNewQuizItemLifecycleSource(operation, args, url) {
    const guard = args.morrow_new_quiz_item_lifecycle_guard;
    const kind = operation.key === NEW_QUIZ_ITEM_CREATE_KEY ? "create"
      : operation.key === NEW_QUIZ_ITEM_DELETE_KEY ? "delete" : "";
    if (!kind) {
      if (guard !== undefined) throw new Error("new_quiz_item_lifecycle_guard_refused: This operation is not a New Quiz item create or delete. No change was sent.");
      return null;
    }
    if (!validNewQuizLifecycleGuard(guard, kind)) {
      throw new Error(`new_quiz_item_lifecycle_guard_required: A New Quiz item ${kind} needs one complete fresh item list from the lifecycle planner. No change was sent.`);
    }
    const beforeItems = await newQuizItemMembership(url);
    const before = beforeItems.map((item) => item.id);
    if (await bodyDigest(stable(beforeItems)) !== guard.before_items_sha256) {
      throw new Error("new_quiz_item_lifecycle_stale: The saved New Quiz item list changed after this operation was planned. No change was sent.");
    }
    const listUrl = newQuizItemsListUrl(url);
    if (kind === "create") {
      const payload = newQuizItemPayloadFromArguments(operation, args);
      const reason = NEW_QUIZ_ITEM_PAYLOAD_CONTRACT.completeQuizItemPayloadReason(payload);
      if (reason) throw new Error(`new_quiz_item_payload_invalid: ${NEW_QUIZ_ITEM_PAYLOAD_CONTRACT.quizItemPayloadMessage(reason)} No change was sent.`);
      if (await bodyDigest(stable(payload)) !== guard.payload_sha256) {
        throw new Error("new_quiz_item_lifecycle_guard_invalid: The reviewed question payload does not match this create. No change was sent.");
      }
      return { kind, before, listUrl, payload };
    }
    const itemId = pageId(args.item_id);
    if (!itemId || itemId !== pageId(guard.item_id) || !before.includes(itemId)) {
      throw new Error("new_quiz_item_lifecycle_guard_invalid: The reviewed item is not in the complete saved New Quiz item list. No change was sent.");
    }
    let item;
    try {
      item = await pageJson(url);
    } catch {
      throw new Error("new_quiz_item_read_failed: Morrow could not read the item before deleting it. No change was sent.");
    }
    if (await bodyDigest(stable(item)) !== guard.target_item_sha256) {
      throw new Error("new_quiz_item_lifecycle_stale: The target New Quiz item changed after this operation was planned. No change was sent.");
    }
    if (!plainObject(item) || pageId(item.id) !== itemId || item.entry_type !== "Item"
      || pageId(item.stimulus_quiz_entry_id) || item.entry_editable === false || item.immutable === true
      || item.status !== "mutable") {
      throw new Error("new_quiz_item_delete_dependency_unverified: This item is not an editable standalone question. No change was sent.");
    }
    return { kind, before, listUrl, itemId };
  }

  function requestedNewQuizItemShapeMatches(actual, expected) {
    if (Array.isArray(expected)) {
      return Array.isArray(actual) && actual.length === expected.length
        && expected.every((value, index) => requestedNewQuizItemShapeMatches(actual[index], value));
    }
    if (plainObject(expected)) {
      return plainObject(actual) && Object.entries(expected)
        .every(([key, value]) => Object.hasOwn(actual, key) && requestedNewQuizItemShapeMatches(actual[key], value));
    }
    if (expected === null || typeof expected === "boolean") return actual === expected;
    if ((typeof expected === "string" || typeof expected === "number")
      && (typeof actual === "string" || typeof actual === "number")) return String(actual) === String(expected);
    return actual === expected;
  }

  async function verifyNewQuizItemLifecycleChange(change, writeData) {
    const base = { schema: "morrow.browser-verification.v1", strategy: "new-quiz-item-lifecycle" };
    try {
      const after = (await newQuizItemMembership(change.listUrl)).map((item) => item.id);
      if (change.kind === "delete") {
        const expected = change.before.filter((id) => id !== change.itemId);
        return after.length === expected.length && after.every((id, index) => id === expected[index])
          ? { ...base, status: "verified", evidence: "complete_item_list_reread_after_delete" }
          : { ...base, status: "mismatch", reason: "new_quiz_item_delete_readback_mismatch" };
      }
      const additions = after.filter((id) => !change.before.includes(id));
      const removed = change.before.filter((id) => !after.includes(id));
      if (after.length !== change.before.length + 1 || additions.length !== 1 || removed.length !== 0) {
        return { ...base, status: "mismatch", reason: "new_quiz_item_create_membership_mismatch" };
      }
      const responseId = pageId(writeData?.id ?? writeData?.item?.id);
      const itemId = additions[0];
      if (responseId && responseId !== itemId) return { ...base, status: "mismatch", reason: "new_quiz_item_create_id_mismatch" };
      const itemUrl = new URL(change.listUrl);
      itemUrl.pathname = `${itemUrl.pathname}/${itemId}`;
      itemUrl.search = "";
      const saved = await pageJson(itemUrl);
      if (!plainObject(saved) || pageId(saved.id) !== itemId || !requestedNewQuizItemShapeMatches(saved, change.payload)) {
        return { ...base, status: "mismatch", reason: "new_quiz_item_create_readback_mismatch" };
      }
      return { ...base, status: "verified", evidence: "complete_item_list_and_created_item_reread" };
    } catch {
      return { ...base, status: "unconfirmed", reason: "new_quiz_item_lifecycle_readback_unavailable" };
    }
  }

  function newQuizListUrl(url) {
    const listUrl = new URL(url);
    if (/\/quizzes\/[1-9][0-9]{0,18}$/.test(listUrl.pathname)) {
      listUrl.pathname = listUrl.pathname.replace(/\/[1-9][0-9]{0,18}$/, "");
    } else if (!/\/quizzes$/.test(listUrl.pathname)) {
      throw new Error("new_quiz_list_target_invalid");
    }
    listUrl.search = "";
    listUrl.searchParams.set("per_page", String(NEW_QUIZ_ITEM_PAGE_LIMIT));
    return listUrl;
  }

  async function newQuizMembership(url) {
    const requested = newQuizListUrl(url);
    const ids = [];
    let next = requested.href;
    let pages = 0;
    while (next && pages < Math.ceil(NEW_QUIZ_ITEM_LIMIT / NEW_QUIZ_ITEM_PAGE_LIMIT)) {
      const response = await fetch(next, { credentials: "include", cache: "no-store", redirect: "error", headers: { Accept: "application/json+canvas-string-ids" } });
      if (!response.ok) throw new Error("new_quiz_list_read_failed");
      const rows = JSON.parse(await readBounded(response));
      if (!Array.isArray(rows) || rows.length > NEW_QUIZ_ITEM_PAGE_LIMIT || ids.length + rows.length > NEW_QUIZ_ITEM_LIMIT) {
        throw new Error("new_quiz_list_incomplete");
      }
      for (const row of rows) {
        const id = plainObject(row) ? pageId(row.id) : null;
        if (!id || ids.includes(id)) throw new Error("new_quiz_list_invalid");
        ids.push(id);
      }
      pages += 1;
      const links = linkHeaderUrls(response.headers.get("Link"), location.origin, requested.pathname, requested);
      next = links.get("next")?.href || null;
    }
    if (next) throw new Error("new_quiz_list_incomplete");
    return ids.sort((left, right) => left.length - right.length || (left < right ? -1 : left > right ? 1 : 0));
  }

  function newQuizPayloadFromArguments(operation, args) {
    const root = {};
    let present = false;
    for (const parameter of operation.parameters || []) {
      const wireName = String(parameter.wireName || "");
      if (parameter.location !== "form" || !wireName.startsWith("quiz[")) continue;
      const value = args[parameter.inputName];
      if (value === undefined) continue;
      assignJsonValue(root, wireName, value);
      present = true;
    }
    return present && plainObject(root.quiz) ? root.quiz : {};
  }

  function validNewQuizGuard(guard, kind) {
    if (!plainObject(guard) || guard.kind !== kind
      || !Array.isArray(guard.before_quiz_ids) || guard.before_quiz_ids.length > NEW_QUIZ_ITEM_LIMIT
      || guard.before_quiz_ids.some((id) => pageId(id) === null)
      || new Set(guard.before_quiz_ids.map(String)).size !== guard.before_quiz_ids.length
      || typeof guard.before_quiz_ids_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(guard.before_quiz_ids_sha256)) return false;
    if (kind === "create") return Object.keys(guard).length === 4
      && typeof guard.payload_sha256 === "string" && /^[0-9a-f]{64}$/.test(guard.payload_sha256);
    return Object.keys(guard).length === 7
      && typeof guard.target_quiz_sha256 === "string" && /^[0-9a-f]{64}$/.test(guard.target_quiz_sha256)
      && typeof guard.target_items_sha256 === "string" && /^[0-9a-f]{64}$/.test(guard.target_items_sha256)
      && typeof guard.target_assignment_sha256 === "string" && /^[0-9a-f]{64}$/.test(guard.target_assignment_sha256)
      && pageId(guard.quiz_id) !== null;
  }

  async function checkNewQuizLifecycleSource(operation, args, url) {
    const guard = args.morrow_new_quiz_lifecycle_guard;
    const kind = operation.key === NEW_QUIZ_CREATE_KEY ? "create" : operation.key === NEW_QUIZ_DELETE_KEY ? "delete" : "";
    if (!kind) {
      if (guard !== undefined) throw new Error("new_quiz_lifecycle_guard_refused: This is not a New Quiz create or delete. No change was sent.");
      return null;
    }
    if (!validNewQuizGuard(guard, kind)) throw new Error(`new_quiz_lifecycle_guard_required: A New Quiz ${kind} needs a reviewed complete course quiz list. No change was sent.`);
    const before = await newQuizMembership(url);
    if (await bodyDigest(stable(guard.before_quiz_ids.map(String))) !== guard.before_quiz_ids_sha256
      || before.length !== guard.before_quiz_ids.length || before.some((id, index) => id !== String(guard.before_quiz_ids[index]))) {
      throw new Error("new_quiz_lifecycle_stale: The course New Quiz list changed after review. No change was sent.");
    }
    const listUrl = newQuizListUrl(url);
    if (kind === "create") {
      const payload = newQuizPayloadFromArguments(operation, args);
      if (await bodyDigest(stable(payload)) !== guard.payload_sha256) throw new Error("new_quiz_lifecycle_guard_invalid: The reviewed New Quiz payload changed. No change was sent.");
      return { kind, before, listUrl, payload };
    }
    const quizId = pageId(args.assignment_id);
    if (!quizId || quizId !== pageId(guard.quiz_id) || !before.includes(quizId)) throw new Error("new_quiz_lifecycle_target_changed: The reviewed New Quiz is not in the course list. No change was sent.");
    const quiz = await pageJson(url);
    if (!plainObject(quiz) || pageId(quiz.id) !== quizId || await bodyDigest(stable(quiz)) !== guard.target_quiz_sha256) {
      throw new Error("new_quiz_lifecycle_stale: The New Quiz changed after review. No change was sent.");
    }
    const itemsUrl = new URL(`${url.pathname}/items`, url.origin);
    const items = await completeNewQuizItemRecords(itemsUrl);
    if (await bodyDigest(stable(items)) !== guard.target_items_sha256) {
      throw new Error("new_quiz_lifecycle_stale: The New Quiz item list changed after review. No change was sent.");
    }
    const assignmentUrl = new URL(`/api/v1/courses/${args.course_id}/assignments/${quizId}`, url.origin);
    const assignment = await pageJson(assignmentUrl);
    if (!plainObject(assignment) || pageId(assignment.id) !== quizId
      || (assignment.course_id !== undefined && pageId(assignment.course_id) !== pageId(args.course_id))
      || assignment.has_submitted_submissions !== false || assignment.graded_submissions_exist !== false
      || await bodyDigest(stable(assignment)) !== guard.target_assignment_sha256) {
      throw new Error("new_quiz_lifecycle_stale: The linked Assignment changed or has student work. No change was sent.");
    }
    return { kind, before, listUrl, quizId };
  }

  async function verifyNewQuizLifecycleChange(change, writeData) {
    const base = { schema: "morrow.browser-verification.v1", strategy: "new-quiz-lifecycle" };
    try {
      const after = await newQuizMembership(change.listUrl);
      if (change.kind === "delete") {
        const expected = change.before.filter((id) => id !== change.quizId);
        return after.length === expected.length && after.every((id, index) => id === expected[index])
          ? { ...base, status: "verified", evidence: "complete_course_new_quiz_list_reread_after_delete" }
          : { ...base, status: "mismatch", reason: "new_quiz_delete_readback_mismatch" };
      }
      const additions = after.filter((id) => !change.before.includes(id));
      const removed = change.before.filter((id) => !after.includes(id));
      if (after.length !== change.before.length + 1 || additions.length !== 1 || removed.length !== 0) {
        return { ...base, status: "mismatch", reason: "new_quiz_create_membership_mismatch" };
      }
      const responseId = pageId(writeData?.id ?? writeData?.quiz?.id);
      const quizId = additions[0];
      if (responseId && responseId !== quizId) return { ...base, status: "mismatch", reason: "new_quiz_create_id_mismatch" };
      const quizUrl = new URL(change.listUrl);
      quizUrl.pathname = `${quizUrl.pathname}/${quizId}`;
      quizUrl.search = "";
      const saved = await pageJson(quizUrl);
      if (!plainObject(saved) || pageId(saved.id) !== quizId || !requestedNewQuizItemShapeMatches(saved, change.payload)) {
        return { ...base, status: "mismatch", reason: "new_quiz_create_readback_mismatch" };
      }
      return { ...base, status: "verified", evidence: "complete_course_quiz_list_and_created_quiz_reread" };
    } catch {
      return { ...base, status: "unconfirmed", reason: "new_quiz_lifecycle_readback_unavailable" };
    }
  }

  function newQuizAccommodationRequest(operation, args) {
    if (![NEW_QUIZ_COURSE_ACCOMMODATIONS_KEY, NEW_QUIZ_QUIZ_ACCOMMODATIONS_KEY].includes(operation.key)) return null;
    const allowed = operation.key === NEW_QUIZ_COURSE_ACCOMMODATIONS_KEY
      ? ["user_id", "extra_time", "apply_to_in_progress_quiz_sessions", "reduce_choices_enabled"]
      : ["user_id", "extra_time", "extra_attempts", "reduce_choices_enabled"];
    const value = {};
    for (const name of allowed) if (args[name] !== undefined) value[name] = args[name];
    const userId = pageId(value.user_id);
    if (!userId) throw new Error("new_quiz_accommodation_user_invalid");
    value.user_id = userId;
    for (const name of ["extra_time", "extra_attempts"]) {
      if (value[name] === undefined) continue;
      const number = Number(value[name]);
      if (!Number.isSafeInteger(number) || number < 0 || (name === "extra_time" && number > 10_080)) {
        throw new Error("new_quiz_accommodation_value_invalid");
      }
      value[name] = number;
    }
    for (const name of ["apply_to_in_progress_quiz_sessions", "reduce_choices_enabled"]) {
      if (value[name] !== undefined && typeof value[name] !== "boolean") throw new Error("new_quiz_accommodation_value_invalid");
    }
    return value;
  }

  function verifyNewQuizAccommodation(data, request) {
    const base = { schema: "morrow.browser-verification.v1", strategy: "new-quiz-accommodation-response" };
    if (!plainObject(data) || !Array.isArray(data.successful) || !Array.isArray(data.failed)) {
      return { ...base, status: "mismatch", reason: "new_quiz_accommodation_response_invalid" };
    }
    const successful = data.successful.filter((row) => plainObject(row) && pageId(row.user_id) === request.user_id);
    const failed = data.failed.filter((row) => plainObject(row) && pageId(row.user_id) === request.user_id);
    if (successful.length === 1 && failed.length === 0) {
      return { ...base, status: "verified", evidence: "authoritative_per_user_accommodation_success" };
    }
    return { ...base, status: "mismatch", reason: failed.length > 0 ? "new_quiz_accommodation_provider_failed" : "new_quiz_accommodation_user_result_missing" };
  }

  function verifyNewQuizReport(data, args) {
    const base = { schema: "morrow.browser-verification.v1", strategy: "new-quiz-report-progress" };
    const id = plainObject(data) ? pageId(data.id) : null;
    const contextId = plainObject(data) ? pageId(data.context_id) : null;
    let progressUrl;
    try { progressUrl = new URL(String(data?.url || ""), location.origin); } catch { progressUrl = null; }
    if (!id || contextId !== pageId(args.assignment_id) || data.context_type !== "Assignment"
      || !["queued", "running", "completed", "failed"].includes(String(data.workflow_state))
      || !progressUrl || progressUrl.origin !== location.origin || progressUrl.pathname !== `/api/v1/progress/${id}`) {
      return { ...base, status: "mismatch", reason: "new_quiz_report_progress_invalid" };
    }
    if (data.workflow_state === "failed") return { ...base, status: "mismatch", reason: "new_quiz_report_failed" };
    if (data.workflow_state === "completed") {
      let artifact;
      try { artifact = new URL(String(data.results?.url || ""), location.origin); } catch { artifact = null; }
      if (!artifact || artifact.origin !== location.origin || !/^\/api\//.test(artifact.pathname)) {
        return { ...base, status: "mismatch", reason: "new_quiz_report_artifact_invalid" };
      }
      return { ...base, status: "verified", evidence: "completed_progress_and_same_origin_report_artifact" };
    }
    return { ...base, status: "verified", evidence: "authoritative_assignment_bound_progress_receipt" };
  }

  async function checkNewQuizEffectGuard(operation, args, accommodation) {
    const isAccommodation = [NEW_QUIZ_COURSE_ACCOMMODATIONS_KEY, NEW_QUIZ_QUIZ_ACCOMMODATIONS_KEY].includes(operation.key);
    const isReport = operation.key === NEW_QUIZ_REPORT_KEY;
    const guard = args.morrow_new_quiz_effect_guard;
    if (!isAccommodation && !isReport) {
      if (guard !== undefined) throw new Error("new_quiz_effect_guard_refused: This is not a New Quiz accommodation or report request. No change was sent.");
      return null;
    }
    const kind = isReport ? "report" : "accommodation";
    if (!plainObject(guard) || Object.keys(guard).length !== 2 || guard.kind !== kind
      || typeof guard.payload_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(guard.payload_sha256)) {
      throw new Error(`new_quiz_effect_guard_required: This New Quiz ${kind} request needs an exact reviewed payload. No change was sent.`);
    }
    const payload = isReport
      ? { report_type: args.quiz_report_report_type, format: args.quiz_report_format }
      : accommodation;
    if (!plainObject(payload) || await bodyDigest(stable(payload)) !== guard.payload_sha256) {
      throw new Error("new_quiz_effect_guard_invalid: The New Quiz request changed after review. No change was sent.");
    }
    return { kind };
  }

  async function readNewQuizItemMembership(itemUrl, requireItemOnly) {
    const requested = newQuizItemsListUrl(itemUrl);
    const rows = [];
    let next = requested.href;
    let pages = 0;
    while (next && pages < Math.ceil(NEW_QUIZ_ITEM_LIMIT / NEW_QUIZ_ITEM_PAGE_LIMIT)) {
      const response = await fetch(next, { credentials: "include", cache: "no-store", redirect: "error", headers: { Accept: "application/json+canvas-string-ids" } });
      if (!response.ok) throw new Error("new_quiz_item_position_list_read_failed");
      const page = JSON.parse(await readBounded(response));
      if (!Array.isArray(page) || page.length > NEW_QUIZ_ITEM_PAGE_LIMIT || rows.length + page.length > NEW_QUIZ_ITEM_LIMIT) {
        throw new Error("new_quiz_item_position_list_incomplete");
      }
      rows.push(...page);
      pages += 1;
      const links = linkHeaderUrls(response.headers.get("Link"), location.origin, requested.pathname, requested);
      next = links.get("next")?.href || null;
    }
    if (next) throw new Error("new_quiz_item_position_list_incomplete");
    const positions = new Set();
    const ids = new Set();
    const positioned = [];
    for (const row of rows) {
      const id = plainObject(row) ? pageId(row.id) : null;
      const position = plainObject(row) && Number.isSafeInteger(row.position) && row.position >= 1 ? row.position : null;
      const entryType = plainObject(row) && typeof row.entry_type === "string" && row.entry_type.length <= 100
        && row.entry_type.trim() === row.entry_type ? row.entry_type : "";
      if (!id || !entryType || (requireItemOnly && entryType !== "Item") || position === null || ids.has(id) || positions.has(position)) {
        throw new Error("new_quiz_item_position_list_invalid");
      }
      ids.add(id);
      positions.add(position);
      positioned.push({ id, position, entry_type: entryType });
    }
    return positioned.sort((left, right) => left.position - right.position);
  }

  async function newQuizItemMembership(itemUrl) {
    return readNewQuizItemMembership(itemUrl, false);
  }

  async function completeNewQuizItemRecords(itemUrl) {
    const requested = newQuizItemsListUrl(itemUrl);
    const rows = [];
    let next = requested.href;
    let pages = 0;
    while (next && pages < Math.ceil(NEW_QUIZ_ITEM_LIMIT / NEW_QUIZ_ITEM_PAGE_LIMIT)) {
      const response = await fetch(next, { credentials: "include", cache: "no-store", redirect: "error", headers: { Accept: "application/json+canvas-string-ids" } });
      if (!response.ok) throw new Error("new_quiz_item_list_read_failed");
      const page = JSON.parse(await readBounded(response));
      if (!Array.isArray(page) || page.length > NEW_QUIZ_ITEM_PAGE_LIMIT || rows.length + page.length > NEW_QUIZ_ITEM_LIMIT) {
        throw new Error("new_quiz_item_list_incomplete");
      }
      rows.push(...page);
      pages += 1;
      const links = linkHeaderUrls(response.headers.get("Link"), location.origin, requested.pathname, requested);
      next = links.get("next")?.href || null;
    }
    if (next) throw new Error("new_quiz_item_list_incomplete");
    const ids = new Set();
    for (const row of rows) {
      const id = plainObject(row) ? pageId(row.id) : null;
      if (!id || ids.has(id) || !Number.isSafeInteger(row.position) || row.position < 1) throw new Error("new_quiz_item_list_invalid");
      ids.add(id);
    }
    return rows.sort((left, right) => left.position - right.position);
  }

  async function newQuizItemOrder(itemUrl) {
    return (await readNewQuizItemMembership(itemUrl, true)).map((row) => row.id);
  }

  async function checkNewQuizItemPositionSource(operation, args, url) {
    const guard = args.morrow_new_quiz_item_position_guard;
    const changesPosition = operation.key === NEW_QUIZ_ITEM_OPERATION_KEY && args.item_position !== undefined;
    if (!changesPosition) {
      if (guard !== undefined) throw new Error("new_quiz_item_position_guard_refused: This change does not move a New Quiz item. No change was sent.");
      return null;
    }
    if (!validNewQuizPositionGuard(guard)) throw new Error("new_quiz_item_position_guard_required: A New Quiz item move needs one complete current order and one exact expected order. No change was sent.");
    const before = await newQuizItemOrder(url);
    if (await bodyDigest(stable(before)) !== guard.before_item_ids_sha256) {
      throw new Error("new_quiz_item_position_stale: The saved New Quiz item order changed after this move was planned. No change was sent.");
    }
    const expected = guard.expected_item_ids.map(String);
    if (before.length !== expected.length || new Set(before).size !== new Set(expected).size || before.some((id) => !expected.includes(id))
      || await bodyDigest(stable(expected)) !== guard.expected_item_ids_sha256) {
      throw new Error("new_quiz_item_position_guard_invalid: The expected order is not an exact permutation of the current saved items. No change was sent.");
    }
    const itemId = pageId(args.item_id);
    const requestedPosition = Number(args.item_position);
    if (!itemId || !Number.isSafeInteger(requestedPosition) || requestedPosition < 1 || requestedPosition > expected.length
      || expected[requestedPosition - 1] !== itemId) {
      throw new Error("new_quiz_item_position_guard_invalid: The requested item position does not match the expected saved order. No change was sent.");
    }
    const item = await readEditableStandaloneNewQuizItem(args, url);
    return { expected, url, item };
  }

  async function verifyNewQuizItemPositionChange(change) {
    try {
      const saved = await newQuizItemOrder(change.url);
      if (saved.length !== change.expected.length || saved.some((id, index) => id !== change.expected[index])) {
        return { schema: "morrow.browser-verification.v1", status: "mismatch", reason: "new_quiz_item_position_readback_mismatch" };
      }
      return { schema: "morrow.browser-verification.v1", status: "verified", evidence: "complete_new_quiz_item_order_reread_after_write" };
    } catch {
      return { schema: "morrow.browser-verification.v1", status: "unconfirmed", reason: "new_quiz_item_position_readback_unavailable" };
    }
  }

  // Every in-place change to a New Quiz item's answer structure is checked
  // against the item Canvas holds now, whether a content guard prepared it or
  // not. A change to `scoring_data` takes the same read because that block is
  // the answer key, and it names the very ids this check protects.
  function mergeNewQuizItemPatch(before, patch) {
    const merged = { ...before, ...patch };
    if (plainObject(patch.entry)) {
      merged.entry = { ...(plainObject(before.entry) ? before.entry : {}), ...patch.entry };
      if (plainObject(patch.entry.feedback)) {
        merged.entry.feedback = { ...(plainObject(before.entry?.feedback) ? before.entry.feedback : {}), ...patch.entry.feedback };
      }
    }
    return merged;
  }

  async function readEditableStandaloneNewQuizItem(args, url, current = null) {
    let item = current;
    if (!item) {
      try {
        item = await pageJson(url);
      } catch {
        throw new Error("new_quiz_item_read_failed: Morrow could not read this quiz question before changing it. No change was sent.");
      }
    }
    const itemId = pageId(args.item_id);
    if (!itemId || !plainObject(item) || pageId(item.id) !== itemId || item.entry_type !== "Item") {
      throw new Error("new_quiz_item_target_changed: This quiz question is not the standalone item Morrow expected. No change was sent.");
    }
    if (pageId(item.stimulus_quiz_entry_id) || item.entry_editable === false || item.immutable === true
      || item.status !== "mutable") {
      throw new Error("new_quiz_item_edit_dependency_unverified: This item is not an editable standalone question. No change was sent.");
    }
    return item;
  }

  async function checkNewQuizItemIds(operation, args, url, current = null) {
    if (operation.key !== NEW_QUIZ_ITEM_OPERATION_KEY) return false;
    const patch = newQuizItemPayloadFromArguments(operation, args);
    if (!patch || Object.keys(patch).every((key) => key === "position")) return false;
    const before = await readEditableStandaloneNewQuizItem(args, url, current);
    const itemId = pageId(args.item_id);
    if (!itemId || !plainObject(before.entry)) {
      throw new Error("new_quiz_item_target_changed: This quiz question does not report the answer structure Morrow has to preserve. No change was sent.");
    }
    const after = mergeNewQuizItemPatch(before, patch);
    // This is a change to a question Canvas already holds, so its media is
    // judged against that question. Every media problem this change would add
    // is refused, counted per element. Every rule that is not about media stays
    // absolute, so the media problems this question arrived with cannot hide
    // one of them.
    const newMedia = NEW_QUIZ_MEDIA_RULE.newMediaReason(after, before);
    if (newMedia) {
      throw new Error(`new_quiz_item_payload_invalid: ${NEW_QUIZ_ITEM_PAYLOAD_CONTRACT.quizItemPayloadMessage(newMedia)} No change was sent.`);
    }
    const reason = NEW_QUIZ_ITEM_PAYLOAD_CONTRACT.completeQuizItemPayloadReason(NEW_QUIZ_MEDIA_RULE.withoutHeldMedia(after));
    if (reason) {
      throw new Error(`new_quiz_item_payload_invalid: ${NEW_QUIZ_ITEM_PAYLOAD_CONTRACT.quizItemPayloadMessage(reason)} No change was sent.`);
    }
    if (!newQuizIdsPreserved(before, after)) {
      throw new Error("new_quiz_interaction_ids_changed: This change would give the answers in this quiz question new ids, and New Quizzes would keep the old ones as blank answers. No change was sent. Delete this question and add the replacement instead.");
    }
    return true;
  }

  function bulkAssignmentDatesBody(operation, args) {
    if (operation.toolName !== "canvas_bulk_update_assignment_dates"
      || operation.key !== "PUT /v1/courses/{course_id}/assignments/bulk_update#bulk_update_assignment_dates") return undefined;
    const dates = args.assignment_dates;
    if (!Array.isArray(dates) || dates.length < 1 || dates.length > 100) {
      throw new TypeError("canvas_bulk_assignment_dates_invalid");
    }
    const assignmentIds = new Set();
    for (const assignment of dates) {
      const assignmentId = pageId(assignment?.id);
      if (!assignmentId || assignmentIds.has(assignmentId) || !Array.isArray(assignment.all_dates)
        || assignment.all_dates.length < 1 || assignment.all_dates.length > 200) {
        throw new TypeError("canvas_bulk_assignment_dates_invalid");
      }
      assignmentIds.add(assignmentId);
      const selectors = new Set();
      for (const date of assignment.all_dates) {
        if (!date || typeof date !== "object" || Array.isArray(date)
          || Object.keys(date).some((key) => !["id", "base", "due_at", "unlock_at", "lock_at"].includes(key))) {
          throw new TypeError("canvas_bulk_assignment_dates_invalid");
        }
        const overrideId = pageId(date.id);
        if ((date.base === true) === Boolean(overrideId)) throw new TypeError("canvas_bulk_assignment_dates_invalid");
        const selector = date.base === true ? "base" : `override:${overrideId}`;
        if (selectors.has(selector)) throw new TypeError("canvas_bulk_assignment_dates_invalid");
        selectors.add(selector);
        const fields = ["due_at", "unlock_at", "lock_at"].filter((field) => Object.hasOwn(date, field));
        if (fields.length === 0 || fields.some((field) => date[field] !== null
          && (typeof date[field] !== "string" || date[field] !== date[field].trim() || !Number.isFinite(Date.parse(date[field]))))) {
          throw new TypeError("canvas_bulk_assignment_dates_invalid");
        }
      }
    }
    return dates;
  }

  // The Canvas Classic Quiz question routes are form-encoded, and Canvas reads the
  // answer array as indexed form fields, so one answer becomes
  // question[answers][0][answer_text] and its siblings. The catalog schema in
  // scripts/generate-canvas-api-catalog.mjs bounds the same fields.
  const CLASSIC_QUIZ_ANSWER_OPERATIONS = new Set([
    "POST /v1/courses/{course_id}/quizzes/{quiz_id}/questions#create_single_quiz_question",
    "PUT /v1/courses/{course_id}/quizzes/{quiz_id}/questions/{id}#update_existing_quiz_question",
  ]);
  const CLASSIC_QUIZ_ANSWER_FIELDS = ["id", "answer_text", "answer_weight", "answer_comments", "answer_html", "text_after_answers"];

  function classicQuizAnswerEntries(operation, parameter, value) {
    if (!CLASSIC_QUIZ_ANSWER_OPERATIONS.has(operation.key) || parameter.location !== "form"
      || parameter.wireName !== "question[answers]") return undefined;
    if (!Array.isArray(value) || value.length < 1 || value.length > 100) throw new TypeError("canvas_classic_quiz_answers_invalid");
    const entries = [];
    value.forEach((answer, index) => {
      if (!answer || typeof answer !== "object" || Array.isArray(answer)
        || Object.keys(answer).some((key) => !CLASSIC_QUIZ_ANSWER_FIELDS.includes(key))
        || typeof answer.answer_text !== "string"
        || !Number.isInteger(answer.answer_weight) || answer.answer_weight < 0 || answer.answer_weight > 100
        || (Object.hasOwn(answer, "id") && !pageId(answer.id))) {
        throw new TypeError("canvas_classic_quiz_answers_invalid");
      }
      for (const field of CLASSIC_QUIZ_ANSWER_FIELDS) {
        if (!Object.hasOwn(answer, field)) continue;
        const text = field === "answer_weight" ? String(answer.answer_weight)
          : field === "id" ? pageId(answer.id)
          : answer[field];
        if (typeof text !== "string" || text.length > 16_384) throw new TypeError("canvas_classic_quiz_answers_invalid");
        entries.push([{ ...parameter, wireName: `question[answers][${index}][${field}]`, schema: { type: "string" } }, text]);
      }
    });
    return entries;
  }

  function decodeFile(value) {
    if (!value || typeof value !== "object" || typeof value.name !== "string" || typeof value.base64 !== "string") {
      throw new TypeError("file parameters require name and base64");
    }
    const binary = atob(value.base64);
    if (binary.length > 20 * 1024 * 1024) throw new RangeError("file parameter exceeds 20 MiB");
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new File([bytes], value.name, { type: typeof value.type === "string" ? value.type : "application/octet-stream" });
  }

  function requestParts(operation, args) {
    if (operation.toolName === "canvas_create_module_item") {
      const type = args.module_item_type;
      const required = type === "Page" ? ["module_item_page_url"]
        : type === "SubHeader" ? []
        : type === "ExternalUrl" ? ["module_item_external_url"]
        : type === "ExternalTool" ? ["module_item_content_id", "module_item_external_url"]
        : ["module_item_content_id"];
      for (const name of required) {
        if (args[name] === undefined || args[name] === null || args[name] === "") throw new TypeError(`${name} is required`);
      }
    }
    let path = operation.path;
    const query = new URLSearchParams();
    const body = [];
    for (const parameter of operation.parameters) {
      const value = args[parameter.inputName];
      const preserveGuardedEmptyPageBody = operation.toolName === "canvas_update_create_page_courses"
        && Boolean(args.morrow_page_guard || args.morrow_canvas_content_guard) && parameter.inputName === "wiki_page_body";
      const preserveNewQuizValue = usesJsonBody(operation) && operation.path.startsWith("/quiz/v1/")
        && parameter.location === "form";
      if (value === undefined || (value === null && !preserveNewQuizValue)
        || (value === "" && !preserveGuardedEmptyPageBody && !preserveNewQuizValue)) {
        if (parameter.required) throw new TypeError(`${parameter.inputName} is required`);
        continue;
      }
      if (parameter.location === "path") {
        path = path.replace(`{${parameter.wireName}}`, encodeURIComponent(String(value)));
      } else if (parameter.location === "query") {
        appendValue(query, parameter.wireName, value);
      } else {
        const answers = classicQuizAnswerEntries(operation, parameter, value);
        if (answers) body.push(...answers);
        else body.push([parameter, value]);
      }
    }
    if (/\{[^}]+\}/.test(path) || path.includes("://") || path.split("/").includes("..")) {
      throw new TypeError("canvas_operation_path_refused");
    }
    const url = new URL(`/api${path}`, location.origin);
    for (const [name, value] of query) url.searchParams.append(name, value);
    return { url, body };
  }

  function courseScope(operation, url) {
    const target = operation?.morrowCourseTarget;
    if (!target || target.kind !== "course_path" || !["course_id", "id"].includes(target.argument)) return null;
    const match = url.pathname.match(/\/courses\/([1-9][0-9]*)(?:\/|$)/);
    if (!match) throw new Error("canvas_course_target_invalid");
    return match[1];
  }

  // The one course-ownership rule from generated/canvas-semantic-target.js, applied here to the
  // exact request this page is about to send. It is written out rather than imported because Chrome
  // injects this file as a classic script with no module scope. Both limits match
  // CANVAS_SEMANTIC_RESOLUTION_MAX_AGE_MS and its clock tolerance in that module.
  const SEMANTIC_RESOLUTION_MAX_AGE_MS = 60_000;
  const SEMANTIC_RESOLUTION_CLOCK_TOLERANCE_MS = 1_000;

  function checkSemanticTargetScope(operation, url, args, exactCourseId) {
    const target = operation?.morrowCourseTarget?.kind === "semantic_course_object"
      ? operation.morrowCourseTarget.target
      : null;
    if (!target) return false;
    const named = (name) => {
      const value = args?.[name];
      return value !== undefined && value !== null && value !== "" && !(Array.isArray(value) && value.length === 0);
    };
    const accepted = new Set((operation.parameters || []).map((parameter) => parameter.inputName));
    // The inputs Morrow will not send at all, and the ones it sends only with one value: a second
    // place for the object, a repeat or series that reaches events this request cannot read back,
    // and the instruction that keeps a file Canvas would otherwise replace.
    const inputRefused = () => (target.refusedParameters || []).some((name) => named(name))
      || (target.seriesParameters || []).some((name) => named(name))
      || Object.entries(target.requiredInputs || {})
        .some(([name, value]) => accepted.has(name) && String(args?.[name] ?? "") !== value);
    // The same context rule as generated/canvas-semantic-target.js, written out because Chrome
    // injects this file as a classic script with no module scope. Canvas names a calendar with a
    // context code, and one object can carry a list of them: Morrow sends a change only to the
    // selected course's own calendar, and never to an object that serves several courses at once.
    const contextValue = target.courseCodeParameter && named(target.courseCodeParameter)
      ? args[target.courseCodeParameter]
      : undefined;
    if (Array.isArray(contextValue) && contextValue.length > 1) throw new Error("multi_context_object_not_supported");
    if (contextValue !== undefined
      && (Array.isArray(contextValue) ? contextValue[0] : contextValue) !== `course_${exactCourseId}`) {
      throw new Error("canvas_semantic_target_course_mismatch");
    }
    // A route that creates the object names no object to read first: the context code is the whole
    // binding, and the change is read back afterwards through the new object's own route.
    if (target.createsObject) {
      if (contextValue === undefined) throw new Error("canvas_semantic_target_course_mismatch");
      if (inputRefused()) throw new Error("canvas_semantic_target_input_refused");
      return true;
    }
    const proof = operation.morrowSemanticResolution;
    if (!proof || typeof proof !== "object" || Array.isArray(proof)) throw new Error("canvas_semantic_target_course_mismatch");
    const objectId = pageId(proof.objectId);
    const wireName = (operation.parameters || [])
      .find((parameter) => parameter.inputName === target.objectParameter && parameter.location === "path")?.wireName;
    // The route names the proved object and then whatever this change is about inside it, so the
    // part of the address up to and including that object has to be the object that was read.
    const placeholder = wireName ? `{${wireName}}` : "";
    const objectEnd = placeholder ? operation.path.indexOf(placeholder) + placeholder.length : -1;
    const provedPath = objectEnd > 0
      ? `/api${operation.path.slice(0, objectEnd).replace(placeholder, encodeURIComponent(objectId))}`
      : "";
    if (!objectId || !provedPath || proof.resolverTool !== target.resolverRead
      || courseId(proof.courseId) !== exactCourseId
      || typeof proof.snapshotDigest !== "string" || !/^[0-9a-f]{64}$/.test(proof.snapshotDigest)
      || (url.pathname !== provedPath && !url.pathname.startsWith(`${provedPath}/`))) {
      throw new Error("canvas_semantic_target_course_mismatch");
    }
    // Where the change lands is part of the change: the reading has to name that exact destination,
    // and name none when the change names none. Both are read from this request's own arguments.
    const destination = target.destinationParameter && named(target.destinationParameter)
      ? pageId(args[target.destinationParameter])
      : "";
    if ((destination || "") !== (pageId(proof.destinationId) || "")) throw new Error("canvas_semantic_target_course_mismatch");
    if (inputRefused()) throw new Error("canvas_semantic_target_input_refused");
    const resolvedAt = Date.parse(String(proof.resolvedAt));
    const now = Date.now();
    if (!Number.isFinite(resolvedAt) || resolvedAt > now + SEMANTIC_RESOLUTION_CLOCK_TOLERANCE_MS
      || now - resolvedAt > SEMANTIC_RESOLUTION_MAX_AGE_MS) {
      throw new Error("canvas_semantic_target_resolution_stale");
    }
    return true;
  }

  function checkCourseScope(operation, url, args, expectedCourseId) {
    const exactId = courseId(expectedCourseId);
    if (!exactId) throw new Error("canvas_course_binding_missing");
    const targetId = courseScope(operation, url);
    if (targetId && targetId !== exactId) throw new Error("canvas_course_target_mismatch");
    if (checkSemanticTargetScope(operation, url, args, exactId)) return exactId;
    if (!targetId && operation.method !== "GET") throw new Error("canvas_course_scope_required");
    return exactId;
  }

  function sameInstant(left, right) {
    if (left === right) return true;
    const leftTime = Date.parse(String(left));
    const rightTime = Date.parse(String(right));
    return Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime === rightTime;
  }

  function stable(value) {
    if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
    if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
    return JSON.stringify(value === undefined ? null : value);
  }

  function isoInstant(value) {
    if (typeof value !== "string" || value !== value.trim()) return null;
    const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.\d{1,3})?)?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/);
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const days = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1] && Number.isFinite(Date.parse(value))
      ? value
      : null;
  }

  function assignmentDueDateChange(operation, args) {
    if (operation.toolName !== "canvas_edit_assignment"
      || operation.key !== "PUT /v1/courses/{course_id}/assignments/{id}#edit_assignment") return null;
    if (!Object.hasOwn(args, "assignment_due_at") || !Object.keys(args).every((key) => ["course_id", "id", "assignment_due_at"].includes(key))) return null;
    const id = pageId(args.id);
    const dueAt = isoInstant(args.assignment_due_at);
    if (!id || !dueAt) throw new Error("assignment_due_date_invalid");
    return { id, dueAt };
  }

  function assignmentDueDateState(value, expectedCourseId, expectedId) {
    if (!value || typeof value !== "object" || Array.isArray(value)
      || pageId(value.id) !== expectedId || courseId(value.course_id) !== expectedCourseId) {
      throw new Error("assignment_due_date_target_changed");
    }
    const protectedFields = { ...value };
    delete protectedFields.due_at;
    delete protectedFields.updated_at;
    return stable(protectedFields);
  }

  async function checkAssignmentDueDateSource(operation, args, url, expectedCourseId) {
    const change = assignmentDueDateChange(operation, args);
    if (!change) return null;
    const before = await pageJson(url);
    return { ...change, protectedState: assignmentDueDateState(before, expectedCourseId, change.id) };
  }

  async function verifyAssignmentDueDateChange(change, url, expectedCourseId) {
    const base = { schema: "morrow.browser-verification.v1", status: "unconfirmed", strategy: "assignment-due-date" };
    try {
      const after = await pageJson(url);
      if (assignmentDueDateState(after, expectedCourseId, change.id) !== change.protectedState) {
        return { ...base, status: "mismatch", reason: "assignment_fields_changed" };
      }
      if (!sameInstant(after.due_at, change.dueAt)) return { ...base, status: "mismatch", reason: "assignment_due_date_did_not_match" };
      return { ...base, status: "verified", evidence: "fresh_assignment_readback_preserves_other_fields" };
    } catch {
      return { ...base, reason: "assignment_readback_incomplete" };
    }
  }

  async function canvasProfile(includeCourseName = false) {
    const currentCourseId = currentCanvasCourseId();
    const response = await fetch(new URL("/api/v1/users/self/profile", location.origin), {
      credentials: "include",
      headers: { Accept: "application/json+canvas-string-ids" },
      cache: "no-store",
      redirect: "error",
    });
    if (!response.ok) throw new Error(`canvas_profile_http_${response.status}`);
    const profile = JSON.parse(await readBounded(response));
    const id = String(profile?.id || "").trim();
    if (!/^[1-9][0-9]*$/.test(id)) throw new Error("canvas_profile_id_invalid");
    let courseName;
    if (includeCourseName) {
      courseName = String((await courseJson(currentCourseId)).name || "").trim().slice(0, 300);
    }
    return { id, name: String(profile?.name || profile?.short_name || "Canvas user").slice(0, 200), origin: location.origin, courseId: currentCourseId, ...(courseName ? { courseName } : {}) };
  }

  async function executeCanvas(operation, args, expectedPrincipalId, expiresAt, expectedCourseId) {
    const profile = await canvasProfile();
    if (profile.id !== expectedPrincipalId) throw new Error("canvas_principal_changed");
    let { url, body } = requestParts(operation, args);
    const exactCourseId = checkCourseScope(operation, url, args, expectedCourseId);
    await courseJson(exactCourseId);
    const assignmentDueDate = await checkAssignmentDueDateSource(operation, args, url, exactCourseId);
    let canvasContentChange = null;
    let newQuizLifecycle = null;
    let newQuizItemLifecycle = null;
    let newQuizItemPosition = null;
    const newQuizAccommodation = newQuizAccommodationRequest(operation, args);
    const newQuizReport = operation.key === NEW_QUIZ_REPORT_KEY;
    const newQuizEffect = await checkNewQuizEffectGuard(operation, args, newQuizAccommodation);
    if (assignmentDueDate) {
      const currentProfile = await canvasProfile();
      if (currentProfile.id !== expectedPrincipalId) throw new Error("canvas_principal_changed");
      await courseJson(exactCourseId);
    }
    if (args.morrow_page_guard) {
      args = { ...args, wiki_page_body: await checkPageSource(operation, args, url, exactCourseId) };
      ({ url, body } = requestParts(operation, args));
      checkCourseScope(operation, url, args, exactCourseId);
      const currentProfile = await canvasProfile();
      if (currentProfile.id !== expectedPrincipalId) throw new Error("canvas_principal_changed");
      await courseJson(exactCourseId);
    }
    if (args.morrow_canvas_content_guard) {
      canvasContentChange = await checkCanvasContentSource(operation, args, url, exactCourseId);
      args = { ...args, ...canvasContentChange.writeArguments };
      ({ url, body } = requestParts(operation, args));
      checkCourseScope(operation, url, args, exactCourseId);
      const currentProfile = await canvasProfile();
      if (currentProfile.id !== expectedPrincipalId) throw new Error("canvas_principal_changed");
      await courseJson(exactCourseId);
    }
    newQuizLifecycle = await checkNewQuizLifecycleSource(operation, args, url);
    if (newQuizLifecycle) {
      const currentProfile = await canvasProfile();
      if (currentProfile.id !== expectedPrincipalId) throw new Error("canvas_principal_changed");
      await courseJson(exactCourseId);
    }
    newQuizItemLifecycle = await checkNewQuizItemLifecycleSource(operation, args, url);
    if (newQuizItemLifecycle) {
      const currentProfile = await canvasProfile();
      if (currentProfile.id !== expectedPrincipalId) throw new Error("canvas_principal_changed");
      await courseJson(exactCourseId);
    }
    newQuizItemPosition = await checkNewQuizItemPositionSource(operation, args, url);
    if (newQuizItemPosition) {
      const currentProfile = await canvasProfile();
      if (currentProfile.id !== expectedPrincipalId) throw new Error("canvas_principal_changed");
      await courseJson(exactCourseId);
    }
    if (await checkNewQuizItemIds(operation, args, url, newQuizItemPosition?.item || null)) {
      const currentProfile = await canvasProfile();
      if (currentProfile.id !== expectedPrincipalId) throw new Error("canvas_principal_changed");
      await courseJson(exactCourseId);
    }
    const newQuizSettings = await checkNewQuizSettingsSource(operation, args, url);
    if (newQuizSettings) {
      const currentProfile = await canvasProfile();
      if (currentProfile.id !== expectedPrincipalId) throw new Error("canvas_principal_changed");
      await courseJson(exactCourseId);
    }
    const isRead = operation.method === "GET";
    const headers = new Headers({ Accept: "application/json+canvas-string-ids" });
    const options = { method: operation.method, credentials: "include", headers, cache: "no-store", redirect: "error" };
    if (!isRead) {
      const csrfCookie = document.cookie.split(";").map((entry) => entry.trim()).find((entry) => entry.startsWith("_csrf_token="));
      const csrf = csrfCookie ? decodeURIComponent(csrfCookie.slice("_csrf_token=".length)) : "";
      if (!csrf) throw new Error("canvas_csrf_context_missing");
      headers.set("X-CSRF-Token", csrf);
      headers.set("X-Requested-With", "XMLHttpRequest");
      const bulkDates = bulkAssignmentDatesBody(operation, args);
      const containsFile = body.some(([parameter]) => String(parameter.schema?.format || "") === "binary");
      if (newQuizAccommodation) {
        headers.set("Content-Type", "application/json;charset=UTF-8");
        options.body = JSON.stringify([newQuizAccommodation]);
      } else if (bulkDates !== undefined) {
        headers.set("Content-Type", "application/json;charset=UTF-8");
        options.body = JSON.stringify(bulkDates);
      } else if (containsFile) {
        const form = new FormData();
        for (const [parameter, value] of body) {
          if (String(parameter.schema?.format || "") === "binary") form.append(parameter.wireName, decodeFile(value));
          else appendValue(form, parameter.wireName, value);
        }
        options.body = form;
      } else if (body.length > 0 && usesJsonBody(operation)) {
        const json = {};
        for (const [parameter, value] of body) assignJsonValue(json, parameter.wireName, value);
        // The complete merged block replaces the leaves the caller supplied, so
        // a partial quiz_settings PATCH is never sent.
        if (newQuizSettings) json.quiz = { ...json.quiz, quiz_settings: newQuizSettings.merged };
        headers.set("Content-Type", "application/json;charset=UTF-8");
        options.body = JSON.stringify(json);
      } else if (body.length > 0) {
        const encoded = new URLSearchParams();
        for (const [parameter, value] of body) appendValue(encoded, parameter.wireName, value);
        headers.set("Content-Type", "application/x-www-form-urlencoded;charset=UTF-8");
        options.body = encoded.toString();
      }
    }
    const listResume = listResumeRequest(args, isRead);
    const resumed = listResume && listResume.next_page !== undefined ? decodeResumeToken(listResume.next_page, url) : null;
    const pagesBefore = resumed ? resumed.pagesRead : 0;
    const maxPages = Math.max(1, Math.min(Number(args.morrow_max_pages || 25), MAX_PAGES, MAX_RESUMED_PAGES - pagesBefore));
    if (!isRead && (!Number.isFinite(expiresAt) || Date.now() >= expiresAt)) throw new Error("canvas_request_expired_before_send");
    const pages = [];
    let next = resumed ? resumed.href : url.href;
    let links = new Map();
    let lastResponse = null;
    for (let page = 0; next && page < maxPages; page += 1) {
      let response;
      let payload;
      try {
        for (let attempt = 0; attempt < (isRead ? 3 : 1); attempt += 1) {
          response = await fetch(next, options);
          if (response.status !== 429 || !isRead || attempt === 2) break;
          const seconds = Math.min(30, Math.max(1, Number(response.headers.get("Retry-After") || 1)));
          await new Promise((resolve) => setTimeout(resolve, seconds * 1_000));
        }
        payload = parsePayload(await readBounded(response), response.headers.get("Content-Type"));
      } catch {
        if (!isRead && newQuizEffect) {
          return {
            ok: false, sent: true, outcomeUnknown: true, error: "canvas_write_response_unknown",
            verification: { schema: "morrow.browser-verification.v1", status: "unconfirmed", strategy: newQuizReport ? "new-quiz-report-progress" : "new-quiz-accommodation-response", reason: newQuizReport ? "progress_id_response_lost" : "provider_has_no_accommodation_read_route" },
          };
        }
        if (!isRead && newQuizLifecycle) {
          const verification = await verifyNewQuizLifecycleChange(newQuizLifecycle, null);
          if (verification.status === "verified") {
            return { ok: true, sent: true, outcomeUnknown: false, recovered: true, status: 0, data: null, verification };
          }
          return { ok: false, sent: true, outcomeUnknown: true, error: "canvas_write_response_unknown", verification };
        }
        if (!isRead && newQuizItemLifecycle) {
          const verification = await verifyNewQuizItemLifecycleChange(newQuizItemLifecycle, null);
          if (verification.status === "verified") {
            return { ok: true, sent: true, outcomeUnknown: false, recovered: true, status: 0, data: null, verification };
          }
          return { ok: false, sent: true, outcomeUnknown: true, error: "canvas_write_response_unknown", verification };
        }
        if (!isRead && newQuizItemPosition) {
          const verification = await verifyNewQuizItemPositionChange(newQuizItemPosition);
          if (verification.status === "verified") {
            return { ok: true, sent: true, outcomeUnknown: false, recovered: true, status: 0, data: null, verification };
          }
          return { ok: false, sent: true, outcomeUnknown: true, error: "canvas_write_response_unknown", verification };
        }
        if (!isRead && newQuizSettings) {
          const verification = await verifyNewQuizSettingsChange(args, url, newQuizSettings.merged, newQuizSettings.before);
          if (verification.status === "verified") {
            return {
              ok: true,
              sent: true,
              outcomeUnknown: false,
              recovered: true,
              status: 0,
              data: null,
              newQuizSettingsPreserved: newQuizSettings.preserved,
              verification,
            };
          }
          return {
            ok: false,
            sent: true,
            outcomeUnknown: true,
            error: "canvas_write_response_unknown",
            newQuizSettingsPreserved: newQuizSettings.preserved,
            verification,
          };
        }
        return { ok: false, sent: true, outcomeUnknown: !isRead, error: isRead ? "canvas_read_failed" : "canvas_write_response_unknown" };
      }
      lastResponse = response;
      if (!response.ok) {
        // The one Canvas write-outcome rule, copied from
        // src/canvas-write-outcome.js because Chrome injects this file as a
        // classic script with no module scope. A read has no effect to be
        // uncertain about, so its shape does not change.
        const outcomeUnknown = !(
          Number.isInteger(response.status) && response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429
        );
        if (outcomeUnknown && newQuizEffect) {
          return {
            ok: false, sent: true, status: response.status, outcomeUnknown: true, error: payload, requestUrl: url.pathname,
            verification: { schema: "morrow.browser-verification.v1", status: "unconfirmed", strategy: newQuizReport ? "new-quiz-report-progress" : "new-quiz-accommodation-response", reason: newQuizReport ? "progress_id_response_lost" : "provider_has_no_accommodation_read_route" },
          };
        }
        if (outcomeUnknown && newQuizLifecycle) {
          const verification = await verifyNewQuizLifecycleChange(newQuizLifecycle, payload);
          if (verification.status === "verified") {
            return { ok: true, sent: true, outcomeUnknown: false, recovered: true, status: response.status, data: payload, verification };
          }
          return { ok: false, sent: true, status: response.status, outcomeUnknown: true, error: payload, requestUrl: url.pathname, verification };
        }
        if (outcomeUnknown && newQuizItemLifecycle) {
          const verification = await verifyNewQuizItemLifecycleChange(newQuizItemLifecycle, payload);
          if (verification.status === "verified") {
            return { ok: true, sent: true, outcomeUnknown: false, recovered: true, status: response.status, data: payload, verification };
          }
          return { ok: false, sent: true, status: response.status, outcomeUnknown: true, error: payload, requestUrl: url.pathname, verification };
        }
        if (outcomeUnknown && newQuizItemPosition) {
          const verification = await verifyNewQuizItemPositionChange(newQuizItemPosition);
          if (verification.status === "verified") {
            return { ok: true, sent: true, outcomeUnknown: false, recovered: true, status: response.status, data: payload, verification };
          }
          return { ok: false, sent: true, status: response.status, outcomeUnknown: true, error: payload, requestUrl: url.pathname, verification };
        }
        if (outcomeUnknown && newQuizSettings) {
          const verification = await verifyNewQuizSettingsChange(args, url, newQuizSettings.merged, newQuizSettings.before);
          if (verification.status === "verified") {
            return {
              ok: true,
              sent: true,
              outcomeUnknown: false,
              recovered: true,
              status: response.status,
              data: payload,
              newQuizSettingsPreserved: newQuizSettings.preserved,
              verification,
            };
          }
          return {
            ok: false,
            sent: true,
            status: response.status,
            outcomeUnknown: true,
            error: payload,
            requestUrl: url.pathname,
            newQuizSettingsPreserved: newQuizSettings.preserved,
            verification,
          };
        }
        return { ok: false, sent: true, status: response.status, ...(isRead ? {} : { outcomeUnknown }), error: payload, requestUrl: url.pathname };
      }
      pages.push(payload);
      links = isRead ? linkHeaderUrls(response.headers.get("Link"), location.origin, url.pathname, url) : new Map();
      next = isRead ? links.get("next")?.href || null : null;
    }
    const pagesRead = pagesBefore + pages.length;
    const data = pages.length === 1 ? pages[0] : pages.flatMap((page) => Array.isArray(page) ? page : [page]);
    const pageRead = isRead && /^\/api\/v1\/courses\/[1-9][0-9]*\/pages\/[^/]+$/.test(url.pathname) && typeof data?.body === "string";
    return {
      ok: true,
      sent: true,
      status: lastResponse?.status || 0,
      data,
      ...(pageRead ? { pageBodySha256: await bodyDigest(data.body) } : {}),
      // Every settings change reports the keys it carried over from the quiz's
      // current settings, so the person reads what was kept rather than trusting it.
      ...(newQuizSettings ? {
        newQuizSettingsPreserved: newQuizSettings.preserved,
        verification: await verifyNewQuizSettingsChange(args, url, newQuizSettings.merged, newQuizSettings.before),
      } : {}),
      ...(args.morrow_page_guard ? { verification: await verifyPageChange(args, url) } : {}),
      ...(canvasContentChange ? { verification: await verifyCanvasContentChange(args, url, exactCourseId) } : {}),
      ...(assignmentDueDate ? { verification: await verifyAssignmentDueDateChange(assignmentDueDate, url, exactCourseId) } : {}),
      ...(newQuizAccommodation ? { verification: verifyNewQuizAccommodation(data, newQuizAccommodation) } : {}),
      ...(newQuizReport ? { verification: verifyNewQuizReport(data, args) } : {}),
      ...(newQuizLifecycle ? { verification: await verifyNewQuizLifecycleChange(newQuizLifecycle, data) } : {}),
      ...(newQuizItemLifecycle ? { verification: await verifyNewQuizItemLifecycleChange(newQuizItemLifecycle, data) } : {}),
      ...(newQuizItemPosition ? { verification: await verifyNewQuizItemPositionChange(newQuizItemPosition) } : {}),
      pageCount: pages.length,
      truncated: Boolean(next),
      // The resume envelope is returned only to a caller that asked to continue
      // this list. morrow_next_page is opaque and is only ever read back here.
      ...(listResume ? {
        morrow_pages_read: pagesRead,
        ...(next ? { morrow_unread_pages: unreadPageCount(links) } : {}),
        ...(next && pagesRead < MAX_RESUMED_PAGES ? { morrow_next_page: encodeResumeToken(next, pagesRead) } : {}),
      } : {}),
      requestCost: lastResponse?.headers.get("X-Request-Cost") || null,
      rateLimitRemaining: lastResponse?.headers.get("X-Rate-Limit-Remaining") || null,
    };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "morrow_canvas_probe") {
      canvasProfile(true).then((profile) => sendResponse({ ok: true, profile }), (error) => {
        const text = String(error?.message || error);
        sendResponse({ ok: false, error: MORROW_OWN_ERROR_TOKEN.test(text) ? text : "canvas_probe_execution_failed" });
      });
      return true;
    }
    if (message?.type === "morrow_canvas_execute") {
      if (message.privateAttachment !== undefined) {
        sendResponse({ ok: false, sent: false, error: "canvas_private_attachment_refused" });
        return false;
      }
      executeCanvas(message.operation, message.arguments || {}, message.principalId, message.expiresAt, message.courseId)
        .then((result) => sendResponse(result), (error) => {
          const text = String(error?.message || error);
          sendResponse({ ok: false, sent: false, error: MORROW_OWN_ERROR_TOKEN.test(text) ? text : "canvas_operation_execution_failed" });
        });
      return true;
    }
    if (message?.type === "morrow_canvas_list_courses") {
      Promise.all([canvasProfile(), listCourses(message.page)])
        .then(([profile, result]) => sendResponse({ ok: true, profile, ...result }), (error) => {
          const text = String(error?.message || error);
          sendResponse({ ok: false, error: MORROW_OWN_ERROR_TOKEN.test(text) ? text : "canvas_list_courses_execution_failed" });
        });
      return true;
    }
    if (message?.type === "morrow_canvas_check_course") {
      checkedCourse(message.courseId)
        .then((result) => sendResponse({ ok: true, ...result }), (error) => {
          const text = String(error?.message || error);
          sendResponse({ ok: false, error: MORROW_OWN_ERROR_TOKEN.test(text) ? text : "canvas_check_course_execution_failed" });
        });
      return true;
    }
    return false;
  });
})();
