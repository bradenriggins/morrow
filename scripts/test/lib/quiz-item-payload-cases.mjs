/**
 * The New Quizzes question payloads three copies of one rule set are checked
 * against, in one place so they cannot drift apart. Section 6 of
 * docs/research/CANVAS-NEW-QUIZZES-ITEM-BANKS-CONTRACT-2026-09-06.md is the
 * source of the bank rules. The public Numeric and mixed-blank shapes follow
 * https://developerdocs.instructure.com/services/canvas/resources/new_quiz_items.
 *
 * The three copies:
 * - `connector/extension/src/quiz-item-payload.js`, the module that holds them;
 * - the copy inside `executeItemBankInPage` in
 *   `connector/extension/src/item-bank-executor.js`, because Chrome injects that
 *   function without its module scope;
 * - `packages/mcp-server/src/quiz-item-payload.ts`, which the New Quiz question
 *   planners use, because the extension module has no declaration file and the
 *   Morrow Bridge release ships an exact file set.
 *
 * `scripts/test/canvas-quiz-item-payload.test.mjs` runs the first two over this
 * list, and `packages/mcp-server/test/quiz-item-payload.test.ts` runs the third
 * over it. This file is not a test: `pnpm scripts:test` globs
 * `scripts/test/*.test.mjs`, so it stays out of that glob by living in `lib/`
 * and by keeping `.test.` out of its name.
 */

// One whole item record, the shape GET /api/banks/{bank}/items/{item} answers
// with. Every case below is written this way and read flat as well, so both
// nestings are proven to reach the same verdict.
export function item(entry) {
  return { id: "501", entry_type: "Item", position: 1, points_possible: 1, entry };
}

export const IMAGE = '<img src="/courses/42/files/9/preview" alt="A mitochondrion">';

export function choice(over = {}) {
  return item({
    interaction_type_slug: "choice",
    item_body: "<p>Which organelle makes most of a cell's ATP?</p>",
    interaction_data: { choices: [{ id: "c1", item_body: "<p>Mitochondrion</p>" }, { id: "c2", item_body: "<p>Ribosome</p>" }] },
    scoring_data: { value: "c1" },
    ...over,
  });
}

export function matching(over = {}) {
  return item({
    interaction_type_slug: "matching",
    item_body: "<p>Match each organelle to its job.</p>",
    interaction_data: {
      questions: [{ id: "q-1", item_body: "Mitochondrion" }, { id: "q-2", item_body: "Ribosome" }],
      answers: ["Makes ATP", "Assembles proteins"],
    },
    scoring_data: {
      value: { "q-1": "Makes ATP", "q-2": "Assembles proteins" },
      edit_data: { matches: [{ question_id: "q-1", answer_body: "Makes ATP" }, { question_id: "q-2", answer_body: "Assembles proteins" }] },
    },
    ...over,
  });
}

export function numeric(over = {}) {
  return item({
    interaction_type_slug: "numeric",
    item_body: "<p>How many ATP does one glucose molecule yield?</p>",
    interaction_data: { units: "ATP", dimensions: { min: 0, max: 40, step: 1 } },
    scoring_data: { value: 32 },
    ...over,
  });
}

export function typedNumeric(over = {}) {
  return numeric({
    interaction_data: {},
    scoring_algorithm: "Numeric",
    scoring_data: { value: [
      { id: "answer-1", type: "exactResponse", value: "32" },
      { id: "answer-2", type: "marginOfError", value: "32", margin: "2", margin_type: "absolute" },
      { id: "answer-3", type: "withinARange", start: "30", end: "34" },
      { id: "answer-4", type: "preciseResponse", value: "32.00", precision: "2", precision_type: "decimals" },
    ] },
    ...over,
  });
}

export const RICH_FILL_BODY = '<p>A cell makes ATP in the <span id="blank_b1"></span> and proteins on the <span id="blank_b2"></span>.</p>';

export function richFill(over = {}) {
  return item({
    interaction_type_slug: "rich-fill-blank",
    item_body: RICH_FILL_BODY,
    interaction_data: {
      blanks: [{ id: "b1", answer_type: "openEntry", answers: ["mitochondrion"] }, { id: "b2", answer_type: "openEntry", answers: ["ribosome"] }],
    },
    ...over,
  });
}

export function wordBank(over = {}) {
  const interaction = {
    blanks: [{ id: "b1", answer_type: "wordbank" }, { id: "b2", answer_type: "wordbank" }],
    word_bank_choices: [{ id: "w1", item_body: "mitochondrion" }, { id: "w2", item_body: "ribosome" }],
  };
  const scoring = {
    value: [
      { id: "b1", scoring_algorithm: "TextEquivalence", scoring_data: { value: "mitochondrion", blank_text: "mitochondrion", choice_id: "w1" } },
      { id: "b2", scoring_algorithm: "TextEquivalence", scoring_data: { value: "ribosome", blank_text: "ribosome", choice_id: "w2" } },
    ],
    working_item_body: "A cell makes ATP in the `mitochondrion` and proteins on the `ribosome`.",
  };
  return item({
    interaction_type_slug: "rich-fill-blank",
    item_body: RICH_FILL_BODY,
    interaction_data: { ...interaction, ...(over.interaction_data ?? {}) },
    scoring_data: { ...scoring, ...(over.scoring_data ?? {}) },
    ...Object.fromEntries(Object.entries(over).filter(([key]) => !["interaction_data", "scoring_data"].includes(key))),
  });
}

export function mixedRichFill() {
  return item({
    interaction_type_slug: "rich-fill-blank",
    item_body: '<p><span id="blank_b1"></span> carries <span id="blank_b2"></span> into the <span id="blank_b3"></span>.</p>',
    interaction_data: {
      blanks: [
        { id: "b1", answer_type: "openEntry" },
        { id: "b2", answer_type: "dropdown", choices: [{ id: "d1", item_body: "oxygen" }, { id: "d2", item_body: "water" }] },
        { id: "b3", answer_type: "wordbank", choices: null },
      ],
      word_bank_choices: [{ id: "w1", item_body: "cell" }, { id: "w2", item_body: "nucleus" }],
    },
    scoring_algorithm: "MultipleMethods",
    scoring_data: {
      value: [
        { id: "b1", scoring_algorithm: "TextInChoices", scoring_data: { value: ["Blood", "blood"], blank_text: "Blood" } },
        { id: "b2", scoring_algorithm: "Equivalence", scoring_data: { value: "d1", blank_text: "oxygen" } },
        { id: "b3", scoring_algorithm: "TextEquivalence", scoring_data: { value: "cell", blank_text: "cell", choice_id: "w1" } },
      ],
      working_item_body: "`Blood` carries `oxygen` into the `cell`.",
    },
  });
}

// Every case names one payload and the one reason token both copies of the rule
// have to reach for it: the module, and the copy inside item-bank-executor.js.
// `null` means Morrow has nothing to object to and the request is sent.
export const CASES = [
  // --- media, for every interaction type -----------------------------------
  { name: "a question image that names its alternative text", item: choice({ item_body: `<p>${IMAGE}</p>` }), reason: null },
  { name: "a question image with no alt attribute", item: choice({ item_body: '<p><img src="/courses/42/files/9"></p>' }), reason: "media_image_alt_missing" },
  { name: "an answer image with no alt attribute", item: choice({ interaction_data: { choices: [{ id: "c1", item_body: '<img src="/courses/42/files/9">' }, { id: "c2", item_body: "<p>Ribosome</p>" }] } }), reason: "media_image_alt_missing" },
  { name: "a decorative image marked with an empty alt", item: choice({ item_body: '<p>Which organelle?</p><img src="https://school.instructure.com/files/9/preview" alt="">' }), reason: null },
  { name: "a matching question with an audio file Canvas serves", item: matching({ item_body: '<p>Listen.</p><audio src="/api/v1/files/512" controls></audio>' }), reason: null },
  { name: "a matching question with audio from an unencrypted host", item: matching({ item_body: '<p>Listen.</p><audio src="http://media.example.edu/clip.mp3"></audio>' }), reason: "media_src_unsupported" },
  { name: "a numeric question with a Canvas video", item: numeric({ item_body: '<p>Count them.</p><video src="/courses/42/files/77"></video>' }), reason: null },
  { name: "a numeric question with an inline data video", item: numeric({ item_body: '<p>Count them.</p><video src="data:video/mp4;base64,AAAA"></video>' }), reason: "media_src_unsupported" },
  { name: "a rich fill question whose image is described", item: richFill({ item_body: `${RICH_FILL_BODY}${IMAGE}` }), reason: null },
  { name: "a rich fill question whose image is not described", item: richFill({ item_body: `${RICH_FILL_BODY}<img src="/courses/42/files/9">` }), reason: "media_image_alt_missing" },
  { name: "an essay question whose image is not described", item: item({ interaction_type_slug: "essay", item_body: '<p>Explain this.</p><img src="/courses/42/files/9">' }), reason: "media_image_alt_missing" },
  { name: "an essay question whose image is described", item: item({ interaction_type_slug: "essay", item_body: `<p>Explain this.</p>${IMAGE}` }), reason: null },
  { name: "an image source Morrow cannot read because the markup does not close", item: choice({ item_body: '<p>Look</p><script>write("<img src=\'x\'>")' }), reason: "media_markup_unreadable" },
  { name: "an image tag written inside a closed script block", item: choice({ item_body: '<p>Look</p><script>write("<img src=\'x\'>")</script>' }), reason: null },
  { name: "an image whose source is written without quotes", item: choice({ item_body: "<p><img alt=A src=/courses/42/files/9></p>" }), reason: null },
  { name: "a payload nested deeper than Morrow reads", item: choice({ deep: Array.from({ length: 40 }).reduce((held) => ({ nested: held }), "<p>x</p>") }), reason: "payload_too_deep" },

  // --- choice --------------------------------------------------------------
  { name: "two choices with one correct id", item: choice(), reason: null },
  {
    name: "three choices, a list answer key, and an image-only answer",
    item: choice({
      interaction_data: { choices: [{ id: "c1", item_body: `<p>${IMAGE}</p>` }, { id: "c2", item_body: "<p>Ribosome</p>" }, { id: "c3", item_body: "<p>Golgi apparatus</p>" }] },
      scoring_data: { value: ["c1", "c3"] },
    }),
    reason: null,
  },
  { name: "a choice question with one choice", item: choice({ interaction_data: { choices: [{ id: "c1", item_body: "<p>Mitochondrion</p>" }] } }), reason: "choice_too_few" },
  { name: "a choice question with no choices at all", item: choice({ interaction_data: { answers: ["Mitochondrion"] } }), reason: "choice_list_missing" },
  { name: "two choices under one id", item: choice({ interaction_data: { choices: [{ id: "c1", item_body: "<p>Mitochondrion</p>" }, { id: "c1", item_body: "<p>Ribosome</p>" }] } }), reason: "choice_id_duplicate" },
  { name: "a choice with no id", item: choice({ interaction_data: { choices: [{ item_body: "<p>Mitochondrion</p>" }, { id: "c2", item_body: "<p>Ribosome</p>" }] } }), reason: "choice_id_invalid" },
  { name: "a choice whose body is only a non-breaking space", item: choice({ interaction_data: { choices: [{ id: "c1", item_body: "<p>&nbsp;</p>" }, { id: "c2", item_body: "<p>Ribosome</p>" }] } }), reason: "choice_body_blank" },
  { name: "an answer key naming a choice that is not there", item: choice({ scoring_data: { value: "c9" } }), reason: "choice_scoring_value_not_a_choice_id" },
  { name: "an answer key list holding one id that is not there", item: choice({ scoring_data: { value: ["c1", "c9"] } }), reason: "choice_scoring_value_not_a_choice_id" },
  { name: "a choice question named by interaction type id 1", item: item({ interaction_type_id: 1, interaction_data: { choices: [{ id: "c1", item_body: "A" }] }, scoring_data: { value: "c1" } }), reason: "choice_too_few" },

  // --- matching ------------------------------------------------------------
  { name: "a matching question whose keys and matches cover every question", item: matching(), reason: null },
  {
    name: "matching ids that are not q-1 and q-2, which is not a rule for a bank payload",
    item: matching({
      interaction_data: { questions: [{ id: "organelle_alpha", item_body: "Mitochondrion" }, { id: "organelle_beta", item_body: "Ribosome" }] },
      scoring_data: {
        value: { organelle_alpha: "Makes ATP", organelle_beta: "Assembles proteins" },
        edit_data: { matches: [{ question_id: "organelle_beta" }, { question_id: "organelle_alpha" }] },
      },
    }),
    reason: null,
  },
  { name: "a matching question with no questions", item: matching({ interaction_data: { questions: [], answers: [] } }), reason: "matching_questions_missing" },
  { name: "two matching questions under one id", item: matching({ interaction_data: { questions: [{ id: "q-1" }, { id: "q-1" }] }, scoring_data: { value: { "q-1": "Makes ATP" }, edit_data: { matches: [{ question_id: "q-1" }] } } }), reason: "matching_question_id_duplicate" },
  { name: "a matching question with no id", item: matching({ interaction_data: { questions: [{ item_body: "Mitochondrion" }, { id: "q-2" }] } }), reason: "matching_question_id_invalid" },
  { name: "an answer key that is not keyed by question", item: matching({ scoring_data: { value: ["Makes ATP", "Assembles proteins"] } }), reason: "matching_scoring_value_not_an_object" },
  { name: "an answer key missing one question", item: matching({ scoring_data: { value: { "q-1": "Makes ATP" }, edit_data: { matches: [{ question_id: "q-1" }, { question_id: "q-2" }] } } }), reason: "matching_scoring_value_keys_mismatch" },
  { name: "an answer key with no match list", item: matching({ scoring_data: { value: { "q-1": "Makes ATP", "q-2": "Assembles proteins" } } }), reason: "matching_edit_data_matches_missing" },
  { name: "a match list that misses one question", item: matching({ scoring_data: { value: { "q-1": "Makes ATP", "q-2": "Assembles proteins" }, edit_data: { matches: [{ question_id: "q-1" }] } } }), reason: "matching_edit_data_matches_mismatch" },
  { name: "a match list naming one question twice", item: matching({ scoring_data: { value: { "q-1": "Makes ATP", "q-2": "Assembles proteins" }, edit_data: { matches: [{ question_id: "q-1" }, { question_id: "q-1" }] } } }), reason: "matching_edit_data_matches_mismatch" },
  { name: "a matching question sent without its answer key", item: item({ interaction_type_slug: "matching", item_body: "<p>Match each organelle to its job.</p>", interaction_data: { questions: [{ id: "q-1", item_body: "Mitochondrion" }, { id: "q-2", item_body: "Ribosome" }] } }), reason: null },

  // --- numeric -------------------------------------------------------------
  { name: "a numeric answer with units and bounds", item: numeric(), reason: null },
  { name: "a numeric answer of zero with no interaction data", item: item({ interaction_type_slug: "numeric", item_body: "<p>How many ATP does one glucose molecule yield?</p>", scoring_data: { value: 0 } }), reason: null },
  { name: "a numeric answer that is true", item: numeric({ scoring_data: { value: true } }), reason: "numeric_scoring_value_not_a_number" },
  { name: "a numeric answer written as text", item: numeric({ scoring_data: { value: "32" } }), reason: "numeric_scoring_value_not_a_number" },
  { name: "units that are only whitespace", item: numeric({ interaction_data: { units: "   " } }), reason: "numeric_units_blank" },
  { name: "bounds whose minimum is above their maximum", item: numeric({ interaction_data: { dimensions: { min: 40, max: 0, step: 1 } } }), reason: "numeric_dimensions_min_above_max" },
  { name: "bounds written as text", item: numeric({ interaction_data: { dimensions: { min: "0", max: 40 } } }), reason: "numeric_dimensions_invalid" },
  { name: "bounds with nothing in them", item: numeric({ interaction_data: { dimensions: {} } }), reason: "numeric_dimensions_invalid" },

  // --- rich fill in the blank ----------------------------------------------
  { name: "a public Numeric question with all four typed response forms", item: typedNumeric(), reason: null },
  { name: "a typed numeric response with a boolean answer", item: typedNumeric({ scoring_data: { value: [{ id: "answer-1", type: "exactResponse", value: true }] } }), reason: "numeric_response_invalid" },
  { name: "a typed numeric range with reversed bounds", item: typedNumeric({ scoring_data: { value: [{ id: "answer-1", type: "withinARange", start: "34", end: "30" }] } }), reason: "numeric_response_invalid" },
  { name: "a public rich-fill question with typed, dropdown and word-bank blanks", item: mixedRichFill(), reason: null },
  { name: "two typed blanks with their answers", item: richFill(), reason: null },
  {
    name: "a typed blank whose answer is on its scoring row",
    item: richFill({
      interaction_data: { blanks: [{ id: "b1", answer_type: "openEntry" }, { id: "b2", answer_type: "openEntry" }] },
      scoring_data: { value: [{ id: "b1", scoring_data: { value: "mitochondrion" } }, { id: "b2", scoring_data: { value: "ribosome" } }] },
    }),
    reason: null,
  },
  {
    name: "a listed-choice blank whose correct value is one of its choices",
    item: richFill({
      interaction_data: { blanks: [{ id: "b1", answer_type: "TextInChoices", choices: ["mitochondrion", "ribosome"], value: "mitochondrion" }, { id: "b2", answer_type: "openEntry", answers: ["ribosome"] }] },
    }),
    reason: null,
  },
  { name: "a word bank question with two choices, matching scoring, and ordered answers", item: wordBank(), reason: null },
  { name: "a rich fill question with no blanks", item: richFill({ interaction_data: { blanks: [] } }), reason: "rich_fill_blanks_missing" },
  { name: "two blanks under one id", item: richFill({ interaction_data: { blanks: [{ id: "b1", answer_type: "openEntry", answers: ["a"] }, { id: "b1", answer_type: "openEntry", answers: ["b"] }] } }), reason: "rich_fill_blank_id_duplicate" },
  { name: "a blank with no id", item: richFill({ interaction_data: { blanks: [{ answer_type: "openEntry", answers: ["a"] }] } }), reason: "rich_fill_blank_id_invalid" },
  { name: "a blank that names no kind Morrow reads", item: richFill({ interaction_data: { blanks: [{ id: "b1", blank_text: "mitochondrion" }] } }), reason: "rich_fill_blank_kind_unreadable" },
  { name: "a typed blank with no answer", item: richFill({ interaction_data: { blanks: [{ id: "b1", answer_type: "openEntry", answers: [] }] } }), reason: "rich_fill_open_entry_answers_missing" },
  { name: "a typed blank whose answer is an empty string", item: richFill({ interaction_data: { blanks: [{ id: "b1", answer_type: "openEntry", answers: ["   "] }] } }), reason: "rich_fill_open_entry_answers_missing" },
  { name: "a listed-choice blank with one choice", item: richFill({ interaction_data: { blanks: [{ id: "b1", answer_type: "TextInChoices", choices: ["mitochondrion"], value: "mitochondrion" }] } }), reason: "rich_fill_text_in_choices_too_few" },
  { name: "a listed-choice blank whose correct value is not listed", item: richFill({ interaction_data: { blanks: [{ id: "b1", answer_type: "TextInChoices", choices: ["mitochondrion", "ribosome"], value: "lysosome" }] } }), reason: "rich_fill_text_in_choices_value_not_listed" },
  {
    name: "a word bank blank beside a typed blank",
    item: wordBank({ interaction_data: { blanks: [{ id: "b1", answer_type: "wordbank" }, { id: "b2", answer_type: "openEntry", answers: ["ribosome"] }] } }),
    reason: null,
  },
  { name: "a word bank holding one choice", item: wordBank({ interaction_data: { word_bank_choices: [{ id: "w1", item_body: "mitochondrion" }] } }), reason: "rich_fill_word_bank_choices_too_few" },
  { name: "two word bank choices under one id", item: wordBank({ interaction_data: { word_bank_choices: [{ id: "w1", item_body: "mitochondrion" }, { id: "w1", item_body: "ribosome" }] } }), reason: "rich_fill_word_bank_choice_id_duplicate" },
  {
    name: "word bank scoring that names a blank the question does not have",
    item: wordBank({ scoring_data: { value: [{ id: "b1", scoring_data: { value: "mitochondrion", blank_text: "mitochondrion", choice_id: "w1" } }, { id: "b9", scoring_data: { value: "ribosome", blank_text: "ribosome", choice_id: "w2" } }] } }),
    reason: "rich_fill_scoring_ids_mismatch",
  },
  {
    name: "a word bank blank whose revealed text is not its answer",
    item: wordBank({ scoring_data: { value: [{ id: "b1", scoring_data: { value: "mitochondrion", blank_text: "the powerhouse", choice_id: "w1" } }, { id: "b2", scoring_data: { value: "ribosome", blank_text: "ribosome", choice_id: "w2" } }] } }),
    reason: "rich_fill_blank_text_mismatch",
  },
  {
    name: "a word bank blank with no answer",
    item: wordBank({ scoring_data: { value: [{ id: "b1", scoring_data: { value: "", blank_text: "", choice_id: "w1" } }, { id: "b2", scoring_data: { value: "ribosome", blank_text: "ribosome", choice_id: "w2" } }] } }),
    reason: "rich_fill_blank_answer_missing",
  },
  {
    name: "a word bank blank pointing at a choice that is not in the bank",
    item: wordBank({ scoring_data: { value: [{ id: "b1", scoring_data: { value: "mitochondrion", blank_text: "mitochondrion", choice_id: "w9" } }, { id: "b2", scoring_data: { value: "ribosome", blank_text: "ribosome", choice_id: "w2" } }] } }),
    reason: "rich_fill_choice_id_unknown",
  },
  { name: "a word bank body that marks only one of its two blanks", item: wordBank({ item_body: '<p>A cell makes ATP in the <span id="blank_b1"></span> and proteins on the ribosome.</p>' }), reason: "rich_fill_body_blank_markers_mismatch" },
  { name: "a word bank working body whose answers are in the wrong order", item: wordBank({ scoring_data: { working_item_body: "A cell makes ATP in the `ribosome` and proteins on the `mitochondrion`." } }), reason: "rich_fill_working_item_body_answers_out_of_order" },
  { name: "a word bank working body that leaves one answer out of backticks", item: wordBank({ scoring_data: { working_item_body: "A cell makes ATP in the `mitochondrion` and proteins on the ribosome." } }), reason: "rich_fill_working_item_body_answers_out_of_order" },

  // --- payloads with nothing structural in them ----------------------------
  { name: "a title-only update", item: { title: "Revised question" }, reason: null },
  { name: "a points-only update to a choice question", item: item({ interaction_type_slug: "choice", points_possible: 2 }), reason: null },
  { name: "a payload that is not an object", item: "a question", reason: "payload_not_an_object" },
  { name: "a payload that is a list", item: [{ title: "Revised question" }], reason: "payload_not_an_object" },
];

// The eight interaction types an earlier hard allowlist refused before Canvas
// saw them. Section 6 of the contract document, and the 29 August 2026
// correction, make this the rule: a validator that cannot check a shape must
// not forbid it.
export const PASS_THROUGH_SLUGS = ["categorization", "multi-answer", "essay", "true-false", "ordering", "file-upload", "formula", "hot-spot"];

// A question body that breaks every structural rule this file knows: one
// choice, an answer key naming nothing, two blanks under one id, and no
// matching questions. As a choice question it is refused. As any of the eight
// it is sent to Canvas, which is the authority on its own schema.
export const UNCHECKABLE_ENTRY = {
  item_body: "<p>Sort these.</p>",
  interaction_data: { choices: [{ id: "c1", item_body: "" }], questions: [], blanks: [{ id: "b1" }, { id: "b1" }] },
  scoring_data: { value: "not-an-id" },
};
