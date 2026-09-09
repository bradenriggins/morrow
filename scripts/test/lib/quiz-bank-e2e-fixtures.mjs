const a = "11111111-1111-4111-8111-111111111111";
const b = "22222222-2222-4222-8222-222222222222";
const c = "33333333-3333-4333-8333-333333333333";
const d = "44444444-4444-4444-8444-444444444444";
const choices = [
  { id: a, position: 1, item_body: "Alpha" },
  { id: b, position: 2, item_body: "Beta" },
];

function whole(entry) {
  return { entry_type: "Item", points_possible: 1, entry: { title: `Fixture ${entry.interaction_type_slug}`, ...entry } };
}

/** Complete provider payloads for every documented New Quiz question type. */
export function quizBankE2eQuestionPayloads() {
  return {
    "true-false": whole({ interaction_type_slug: "true-false", item_body: "True?", interaction_data: { true_choice: "True", false_choice: "False" }, scoring_data: { value: true }, scoring_algorithm: "Equivalence" }),
    categorization: whole({
      interaction_type_slug: "categorization", item_body: "Sort these.",
      interaction_data: {
        categories: { [a]: { id: a, item_body: "A" }, [b]: { id: b, item_body: "B" } },
        distractors: { [c]: { id: c, item_body: "Alpha" }, [d]: { id: d, item_body: "Beta" } },
        category_order: [a, b],
      },
      properties: { shuffle_rules: { questions: { shuffled: false } } },
      scoring_data: { value: [
        { id: a, scoring_algorithm: "AllOrNothing", scoring_data: { value: [c] } },
        { id: b, scoring_algorithm: "AllOrNothing", scoring_data: { value: [d] } },
      ], score_method: "all_or_nothing" },
      scoring_algorithm: "Categorization",
    }),
    matching: whole({
      interaction_type_slug: "matching", item_body: "Match.",
      interaction_data: { questions: [{ id: "a", item_body: "Alpha" }, { id: "b", item_body: "Beta" }], answers: ["One", "Two"] },
      scoring_data: { value: { a: "One", b: "Two" }, edit_data: { matches: [{ question_id: "a", question_body: "Alpha", answer_body: "One" }, { question_id: "b", question_body: "Beta", answer_body: "Two" }], distractors: [] } },
      properties: { shuffle_rules: { questions: { shuffled: true } } }, scoring_algorithm: "DeepEquals",
    }),
    "file-upload": whole({ interaction_type_slug: "file-upload", item_body: "Upload.", interaction_data: { files_count: "2", restrict_count: true }, properties: { allowed_types: ".pdf", restrict_types: true }, scoring_data: { value: "" }, scoring_algorithm: "None" }),
    formula: whole({
      interaction_type_slug: "formula", item_body: "Calculate.", interaction_data: {},
      scoring_data: { value: {
        formula: "2 + y", numeric: { type: "marginOfError", margin: "0", margin_type: "absolute" },
        variables: [{ name: "y", min: "-10", max: "10", precision: 0 }], answer_count: "1",
        generated_solutions: [{ inputs: [{ name: "y", value: "2" }], output: "4" }],
      } },
      scoring_algorithm: "Numeric",
    }),
    ordering: whole({ interaction_type_slug: "ordering", item_body: "Order.", interaction_data: { choices: { [a]: choices[0], [b]: choices[1] } }, properties: { top_label: "First", bottom_label: "Last", shuffle_rules: null, include_labels: true, display_answers_paragraph: false }, scoring_data: { value: [a, b] }, scoring_algorithm: "DeepEquals" }),
    "rich-fill-blank": whole({ interaction_type_slug: "rich-fill-blank", item_body: `<p><span id="blank_${a}"></span></p>`, interaction_data: { blanks: [{ id: a, answer_type: "openEntry" }] }, properties: { shuffle_rules: { blanks: { children: { 0: { children: null } } } } }, scoring_data: { value: [{ id: a, scoring_algorithm: "TextInChoices", scoring_data: { value: ["Cell"], blank_text: "Cell" } }], working_item_body: "<p>`Cell`</p>" }, scoring_algorithm: "MultipleMethods" }),
    "hot-spot": whole({ interaction_type_slug: "hot-spot", item_body: "Select.", interaction_data: { image_url: "https://school.example/uploads/image.png" }, scoring_data: { value: { type: "oval", coordinates: [{ x: 0.1, y: 0.2 }, { x: 0.5, y: 0.6 }] } }, scoring_algorithm: "HotSpot" }),
    choice: whole({ interaction_type_slug: "choice", item_body: "Choose.", interaction_data: { choices }, properties: { shuffle_rules: { choices: { to_lock: [0], shuffled: true } }, vary_points_by_answer: false }, scoring_data: { value: a }, scoring_algorithm: "Equivalence" }),
    "multi-answer": whole({ interaction_type_slug: "multi-answer", item_body: "Choose all.", interaction_data: { choices }, properties: { shuffle_rules: { choices: { to_lock: [1], shuffled: true } } }, scoring_data: { value: [a, b] }, scoring_algorithm: "AllOrNothing" }),
    numeric: whole({ interaction_type_slug: "numeric", item_body: "How many?", interaction_data: {}, scoring_algorithm: "Numeric", scoring_data: { value: [
      { id: "answer-1", type: "exactResponse", value: "32" },
      { id: "answer-2", type: "marginOfError", value: "32", margin: "2", margin_type: "absolute" },
      { id: "answer-3", type: "withinARange", start: "30", end: "34" },
      { id: "answer-4", type: "preciseResponse", value: "32.00", precision: "2", precision_type: "decimals" },
    ] } }),
    essay: whole({ interaction_type_slug: "essay", item_body: "Explain.", interaction_data: { rce: true, essay: null, word_count: true, file_upload: false, spell_check: true, word_limit_enabled: true, word_limit_min: "0", word_limit_max: "500" }, scoring_data: { value: "Use evidence." }, scoring_algorithm: "None" }),
  };
}

export const QUIZ_BANK_E2E_QUESTION_TYPE_DISPOSITION = Object.freeze({
  "multi-answer": "admitted",
  matching: "admitted",
  categorization: "admitted",
  "file-upload": "admitted",
  formula: "admitted",
  ordering: "admitted",
  "rich-fill-blank": "admitted",
  "hot-spot": "held_media_chain",
  choice: "admitted",
  numeric: "admitted",
  "true-false": "admitted",
  essay: "admitted",
});
