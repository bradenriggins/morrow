import type { JsonObject } from "@morrow/contracts";
import { describe, expect, it } from "vitest";
import { planNewQuizItemCreate } from "../src/new-quiz-item-lifecycle.js";
import { completeQuizItemPayloadReason, QUIZ_ITEM_PAYLOAD_REASONS, quizItemPayloadMessage, quizItemPayloadReason } from "../src/quiz-item-payload.js";
import type { GatewayRuntime } from "../src/runtime.js";

/**
 * The Morrow Bridge module that holds the same rules. The New Quiz question
 * planners check a payload in TypeScript because the extension module has no
 * declaration file, so these tests run both implementations over the one shared
 * case list and require the same verdict from each.
 */
type BridgePayload = { validateQuizItemPayload(item: unknown): string | null };
type PayloadCase = { readonly name: string; readonly item: unknown; readonly reason: string | null };
type PayloadCases = {
  readonly CASES: readonly PayloadCase[];
  readonly PASS_THROUGH_SLUGS: readonly string[];
  readonly UNCHECKABLE_ENTRY: JsonObject;
  readonly IMAGE: string;
  item(entry: JsonObject): JsonObject;
  typedNumeric(): JsonObject;
  mixedRichFill(): JsonObject;
};

async function bridgePayload(): Promise<BridgePayload> {
  return await import(new URL("../../../connector/extension/src/quiz-item-payload.js", import.meta.url).href) as BridgePayload;
}

async function payloadCases(): Promise<PayloadCases> {
  return await import(new URL("../../../scripts/test/lib/quiz-item-payload-cases.mjs", import.meta.url).href) as PayloadCases;
}

describe("New Quiz question payload rules", () => {
  it("reaches the same verdict as the Morrow Bridge module for every case", async () => {
    const bridge = await bridgePayload();
    const { CASES } = await payloadCases();
    expect(CASES.length).toBeGreaterThanOrEqual(40);
    for (const { name, item, reason } of CASES) {
      expect(quizItemPayloadReason(item), name).toBe(reason);
      expect(quizItemPayloadReason(item), name).toBe(bridge.validateQuizItemPayload(item));
    }
  });

  it("reads a question written flat exactly as one wrapped in its item record", async () => {
    const { CASES } = await payloadCases();
    for (const { name, item, reason } of CASES) {
      const entry = (item as JsonObject | null)?.entry;
      if (!entry || typeof entry !== "object") continue;
      expect(quizItemPayloadReason(entry), name).toBe(reason);
    }
  });

  it("sends every interaction type it cannot read, and checks the media of all of them", async () => {
    const cases = await payloadCases();
    // The same payload, refused as a choice question, is accepted under every
    // one of the eight types an earlier hard allowlist refused before Canvas
    // ever saw them.
    expect(quizItemPayloadReason(cases.item({ interaction_type_slug: "choice", ...cases.UNCHECKABLE_ENTRY }))).toBe("choice_too_few");
    for (const slug of cases.PASS_THROUGH_SLUGS) {
      const passed = cases.item({ interaction_type_slug: slug, ...cases.UNCHECKABLE_ENTRY });
      expect(quizItemPayloadReason(passed), slug).toBeNull();
      const described = cases.item({ interaction_type_slug: slug, ...cases.UNCHECKABLE_ENTRY, item_body: `<p>Sort these.</p>${cases.IMAGE}` });
      const undescribed = cases.item({ interaction_type_slug: slug, ...cases.UNCHECKABLE_ENTRY, item_body: '<p>Sort these.</p><img src="/courses/42/files/9">' });
      expect(quizItemPayloadReason(described), slug).toBeNull();
      expect(quizItemPayloadReason(undescribed), slug).toBe("media_image_alt_missing");
    }
  });

  it("has one plain sentence for every reason it can return", async () => {
    const { CASES } = await payloadCases();
    const returned = new Set(CASES.map((entry) => entry.reason).filter((reason): reason is string => reason !== null));
    expect(returned.size).toBeGreaterThanOrEqual(20);
    for (const reason of returned) {
      expect(QUIZ_ITEM_PAYLOAD_REASONS, reason).toContain(reason);
    }
    for (const reason of QUIZ_ITEM_PAYLOAD_REASONS) {
      const message = quizItemPayloadMessage(reason);
      expect(message, reason).not.toContain(reason);
      expect(message.endsWith("."), reason).toBe(true);
      expect(message.length, reason).toBeGreaterThan(30);
    }
    // A reason with no sentence names itself rather than reading as nothing.
    expect(quizItemPayloadMessage("not_a_reason")).toBe("Morrow refused this question payload: not_a_reason.");
  });

  it("checks a complete create for each of Canvas's 12 creatable question types", async () => {
    const cases = await payloadCases();
    const whole = (entry: JsonObject): JsonObject => ({ entry_type: "Item", points_possible: 1, entry });
    const a = "11111111-1111-4111-8111-111111111111";
    const b = "22222222-2222-4222-8222-222222222222";
    const c = "33333333-3333-4333-8333-333333333333";
    const d = "44444444-4444-4444-8444-444444444444";
    const choices = [
      { id: a, position: 1, item_body: "Alpha" },
      { id: b, position: 2, item_body: "Beta" },
    ];
    const creates: Record<string, JsonObject> = {
      "true-false": whole({ interaction_type_slug: "true-false", item_body: "True?", interaction_data: { true_choice: "True", false_choice: "False" }, scoring_data: { value: true }, scoring_algorithm: "Equivalence" }),
      categorization: whole({ interaction_type_slug: "categorization", item_body: "Sort these.", interaction_data: {
        categories: { [a]: { id: a, item_body: "A" }, [b]: { id: b, item_body: "B" } },
        distractors: { [c]: { id: c, item_body: "Alpha" }, [d]: { id: d, item_body: "Beta" } },
        category_order: [a, b],
      }, properties: { shuffle_rules: { questions: { shuffled: false } } }, scoring_data: { value: [
        { id: a, scoring_algorithm: "AllOrNothing", scoring_data: { value: [c] } },
        { id: b, scoring_algorithm: "AllOrNothing", scoring_data: { value: [d] } },
      ], score_method: "all_or_nothing" }, scoring_algorithm: "Categorization" }),
      matching: whole({ interaction_type_slug: "matching", item_body: "Match.", interaction_data: { questions: [{ id: "a", item_body: "Alpha" }, { id: "b", item_body: "Beta" }], answers: ["One", "Two"] }, scoring_data: {
        value: { a: "One", b: "Two" }, edit_data: { matches: [{ question_id: "a", question_body: "Alpha", answer_body: "One" }, { question_id: "b", question_body: "Beta", answer_body: "Two" }], distractors: [] },
      }, properties: { shuffle_rules: { questions: { shuffled: true } } }, scoring_algorithm: "DeepEquals" }),
      "file-upload": whole({ interaction_type_slug: "file-upload", item_body: "Upload.", interaction_data: { files_count: "2", restrict_count: true }, properties: { allowed_types: ".pdf", restrict_types: true }, scoring_data: { value: "" }, scoring_algorithm: "None" }),
      formula: whole({ interaction_type_slug: "formula", item_body: "Calculate.", interaction_data: {}, scoring_data: { value: {
        formula: "2 + y", numeric: { type: "marginOfError", margin: "0", margin_type: "absolute" },
        variables: [{ name: "y", min: "-10", max: "10", precision: 0 }], answer_count: "1",
        generated_solutions: [{ inputs: [{ name: "y", value: "2" }], output: "4" }],
      } }, scoring_algorithm: "Numeric" }),
      ordering: whole({ interaction_type_slug: "ordering", item_body: "Order.", interaction_data: { choices: { [a]: choices[0], [b]: choices[1] } }, properties: { top_label: "First", bottom_label: "Last", shuffle_rules: null, include_labels: true, display_answers_paragraph: false }, scoring_data: { value: [a, b] }, scoring_algorithm: "DeepEquals" }),
      "rich-fill-blank": whole({ interaction_type_slug: "rich-fill-blank", item_body: `<p><span id="blank_${a}"></span></p>`, interaction_data: { blanks: [{ id: a, answer_type: "openEntry" }] }, properties: { shuffle_rules: { blanks: { children: { 0: { children: null } } } } }, scoring_data: { value: [{ id: a, scoring_algorithm: "TextInChoices", scoring_data: { value: ["Cell"], blank_text: "Cell" } }], working_item_body: "<p>`Cell`</p>" }, scoring_algorithm: "MultipleMethods" }),
      "hot-spot": whole({ interaction_type_slug: "hot-spot", item_body: "Select.", interaction_data: { image_url: "https://school.example/uploads/image.png" }, scoring_data: { value: { type: "oval", coordinates: [{ x: 0.1, y: 0.2 }, { x: 0.5, y: 0.6 }] } }, scoring_algorithm: "HotSpot" }),
      choice: whole({ interaction_type_slug: "choice", item_body: "Choose.", interaction_data: { choices }, properties: { shuffle_rules: { choices: { to_lock: [0], shuffled: true } }, vary_points_by_answer: false }, scoring_data: { value: a }, scoring_algorithm: "Equivalence" }),
      "multi-answer": whole({ interaction_type_slug: "multi-answer", item_body: "Choose all.", interaction_data: { choices }, properties: { shuffle_rules: { choices: { to_lock: [1], shuffled: true } } }, scoring_data: { value: [a, b] }, scoring_algorithm: "AllOrNothing" }),
      numeric: whole(cases.typedNumeric().entry as JsonObject),
      essay: whole({ interaction_type_slug: "essay", item_body: "Explain.", interaction_data: { rce: true, essay: null, word_count: true, file_upload: false, spell_check: true, word_limit_enabled: true, word_limit_min: "0", word_limit_max: "500" }, scoring_data: { value: "Use evidence." }, scoring_algorithm: "None" }),
    };
    expect(Object.keys(creates)).toHaveLength(12);
    for (const [slug, payload] of Object.entries(creates)) {
      expect(completeQuizItemPayloadReason(payload), slug).toBeNull();
      expect(completeQuizItemPayloadReason({ ...payload, entry: { ...(payload.entry as JsonObject), scoring_algorithm: "Wrong" } }), slug)
        .toBe("create_scoring_algorithm_invalid");
    }
    const invalidProperties: Record<string, JsonObject> = {
      categorization: { shuffle_rules: { questions: { shuffled: "yes" } } },
      matching: { shuffle_rules: { questions: { shuffled: "yes" } } },
      choice: { shuffle_rules: { choices: { to_lock: [2], shuffled: true } } },
      "multi-answer": { vary_points_by_answer: true },
      ordering: { shuffle_rules: {} },
      "rich-fill-blank": { shuffle_rules: { blanks: { children: { first: { children: null } } } } },
      "file-upload": { allowed_types: [".pdf"], restrict_types: true },
    };
    for (const [slug, properties] of Object.entries(invalidProperties)) {
      const payload = creates[slug] as JsonObject;
      expect(completeQuizItemPayloadReason({ ...payload, entry: { ...(payload.entry as JsonObject), properties } }), slug)
        .toBe("create_properties_invalid");
    }
    for (const slug of ["true-false", "formula", "hot-spot", "numeric", "essay"]) {
      const payload = creates[slug] as JsonObject;
      expect(completeQuizItemPayloadReason({ ...payload, entry: { ...(payload.entry as JsonObject), properties: { unexpected: true } } }), slug)
        .toBe("create_properties_invalid");
    }
    expect(completeQuizItemPayloadReason(whole({ interaction_type_slug: "fill-blank", item_body: "Deprecated.", interaction_data: {}, scoring_data: {}, scoring_algorithm: "MultipleMethods" })))
      .toBe("create_deprecated_question_type");

    const e = "55555555-5555-4555-8555-555555555555";
    const f = "66666666-6666-4666-8666-666666666666";
    const g = "77777777-7777-4777-8777-777777777777";
    const mixedRichFill = whole({
      interaction_type_slug: "rich-fill-blank",
      item_body: `<p><span id="blank_${a}"></span><span id="blank_${b}"></span><span id="blank_${c}"></span></p>`,
      interaction_data: {
        blanks: [
          { id: a, answer_type: "openEntry" },
          { id: b, answer_type: "dropdown", choices: [{ id: d, position: 1, item_body: "Delta" }, { id: e, position: 2, item_body: "Echo" }] },
          { id: c, answer_type: "wordbank", choices: null },
        ],
        word_bank_choices: [{ id: f, item_body: "Word" }, { id: g, item_body: "Bank" }],
        reuse_word_bank_choices: true,
      },
      properties: { shuffle_rules: { blanks: { children: { 0: { children: null }, 1: { children: { choices: { shuffled: true } } }, 2: { children: { choices: { shuffled: true } } } } } } },
      scoring_data: {
        value: [
          { id: a, scoring_algorithm: "TextContainsAnswer", scoring_data: { value: "Alpha", blank_text: "Alpha" } },
          { id: b, scoring_algorithm: "Equivalence", scoring_data: { value: d, blank_text: "Delta" } },
          { id: c, scoring_algorithm: "TextEquivalence", scoring_data: { value: "Word", choice_id: f, blank_text: "Word" } },
        ],
        working_item_body: "<p>`Alpha` `Delta` `Word`</p>",
      },
      scoring_algorithm: "MultipleMethods",
    });
    expect(completeQuizItemPayloadReason(mixedRichFill)).toBeNull();

    const changedEntry = (payload: JsonObject, change: JsonObject): JsonObject => ({
      ...payload,
      entry: { ...(payload.entry as JsonObject), ...change },
    });
    expect(completeQuizItemPayloadReason({ ...creates.choice, position: 0 })).toBe("create_position_invalid");
    expect(completeQuizItemPayloadReason(changedEntry(creates.choice as JsonObject, {
      interaction_data: { choices: [{ id: a, position: 2, item_body: "Alpha" }, { id: b, position: 1, item_body: "Beta" }] },
    }))).toBe("create_choice_position_invalid");
    expect(completeQuizItemPayloadReason(changedEntry(creates.categorization as JsonObject, {
      scoring_data: { ...((creates.categorization as JsonObject).entry as JsonObject).scoring_data as JsonObject, score_method: "partial" },
    }))).toBe("categorization_scoring_invalid");
    expect(completeQuizItemPayloadReason(changedEntry(creates.categorization as JsonObject, {
      properties: { shuffle_rules: { questions: { shuffled: true } } },
    }))).toBe("create_properties_invalid");
    expect(completeQuizItemPayloadReason(changedEntry(creates.matching as JsonObject, {
      scoring_data: {
        value: { a: "One", b: "Absent" },
        edit_data: { matches: [{ question_id: "a", question_body: "Alpha", answer_body: "One" }, { question_id: "b", question_body: "Beta", answer_body: "Absent" }], distractors: [] },
      },
    }))).toBe("matching_scoring_value_invalid");
    // An unrecognised key in a matching or categorization structure is refused rather than sent:
    // a create writes the whole object, so a key Morrow never checked must never reach Canvas.
    const categorizationEntry = (creates.categorization as JsonObject).entry as JsonObject;
    const categorizationScoring = categorizationEntry.scoring_data as JsonObject;
    expect(completeQuizItemPayloadReason(changedEntry(creates.categorization as JsonObject, {
      interaction_data: { ...(categorizationEntry.interaction_data as JsonObject), unexpected: true },
    }))).toBe("categorization_structure_invalid");
    expect(completeQuizItemPayloadReason(changedEntry(creates.categorization as JsonObject, {
      scoring_data: { ...categorizationScoring, unexpected: true },
    }))).toBe("categorization_scoring_invalid");
    expect(completeQuizItemPayloadReason(changedEntry(creates.categorization as JsonObject, {
      scoring_data: {
        ...categorizationScoring,
        value: (categorizationScoring.value as JsonObject[]).map((row, index) => index === 0 ? { ...row, unexpected: true } : row),
      },
    }))).toBe("categorization_scoring_invalid");
    expect(completeQuizItemPayloadReason(changedEntry(creates.categorization as JsonObject, {
      scoring_data: {
        ...categorizationScoring,
        value: (categorizationScoring.value as JsonObject[]).map((row, index) => index === 0
          ? { ...row, scoring_data: { ...(row.scoring_data as JsonObject), unexpected: true } } : row),
      },
    }))).toBe("categorization_scoring_invalid");
    const matchingEntry = (creates.matching as JsonObject).entry as JsonObject;
    const matchingScoring = matchingEntry.scoring_data as JsonObject;
    const matchingEditData = matchingScoring.edit_data as JsonObject;
    expect(completeQuizItemPayloadReason(changedEntry(creates.matching as JsonObject, {
      interaction_data: { ...(matchingEntry.interaction_data as JsonObject), unexpected: true },
    }))).toBe("matching_structure_invalid");
    expect(completeQuizItemPayloadReason(changedEntry(creates.matching as JsonObject, {
      scoring_data: { ...matchingScoring, unexpected: true },
    }))).toBe("matching_structure_invalid");
    expect(completeQuizItemPayloadReason(changedEntry(creates.matching as JsonObject, {
      scoring_data: { ...matchingScoring, edit_data: { ...matchingEditData, unexpected: true } },
    }))).toBe("matching_structure_invalid");
    expect(completeQuizItemPayloadReason(changedEntry(creates.matching as JsonObject, {
      scoring_data: {
        ...matchingScoring,
        edit_data: {
          ...matchingEditData,
          matches: (matchingEditData.matches as JsonObject[]).map((match, index) => index === 0 ? { ...match, unexpected: true } : match),
        },
      },
    }))).toBe("matching_structure_invalid");
    // Canvas documents the categorization questions shuffle as "currently always false", and
    // documents the matching one as a real setting, so only the first is pinned.
    expect(completeQuizItemPayloadReason(changedEntry(creates.matching as JsonObject, {
      properties: { shuffle_rules: { questions: { shuffled: false } } },
    }))).toBeNull();
    expect(completeQuizItemPayloadReason(changedEntry(creates.numeric as JsonObject, { interaction_data: { units: "kg" } }))).toBe("numeric_response_invalid");
    expect(completeQuizItemPayloadReason(changedEntry(creates["file-upload"] as JsonObject, {
      properties: { allowed_types: "", restrict_types: true },
    }))).toBe("create_properties_invalid");
    expect(completeQuizItemPayloadReason(changedEntry(creates.essay as JsonObject, {
      interaction_data: { ...(((creates.essay as JsonObject).entry as JsonObject).interaction_data as JsonObject), file_upload: true },
    }))).toBe("essay_structure_invalid");
    expect(completeQuizItemPayloadReason(changedEntry(mixedRichFill, { item_body: "<p>No blank marker</p>" }))).toBe("rich_fill_body_blank_markers_mismatch");
    const mixedEntry = mixedRichFill.entry as JsonObject;
    const mixedScoring = mixedEntry.scoring_data as JsonObject;
    expect(completeQuizItemPayloadReason(changedEntry(mixedRichFill, {
      scoring_data: { ...mixedScoring, working_item_body: "" },
    }))).toBe("rich_fill_working_item_body_answers_out_of_order");
  });
});

const sourceBindingId = "canvas:instructor";
const writeTools = new Set(["canvas_create_quiz_item", "canvas_delete_quiz_item", "canvas_update_quiz_item"]);
const payloadChoiceA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const payloadChoiceB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function readResult(data: unknown): JsonObject {
  return {
    structuredContent: {
      schema: "morrow.canvas-connector.result.v1",
      ok: true,
      commandKind: "invoke_read",
      result: { ok: true, sent: true, truncated: false, data },
    },
  };
}

function fixture() {
  const calls: { tool: string }[] = [];
  const runtime = {
    searchCatalog: ({ query }: { query: string }) => ({
      tools: [{ publicName: query, upstreamName: query, upstreamId: "canvas-session", annotations: { readOnlyHint: !writeTools.has(query) } }],
    }),
    capabilityGet: () => ({ descriptor: { route: { backend: "canvas-connector" } } }),
    callSourceOwned: async (tool: string) => {
      calls.push({ tool });
      if (tool === "canvas_get_single_course_courses") return readResult({ id: "42", name: "Biology" });
      if (tool === "canvas_get_new_quiz") return readResult({ id: "77", course_id: "42", title: "Cell Structure Check" });
      if (tool === "canvas_list_quiz_items") return readResult([]);
      throw new Error(`unexpected tool ${tool}`);
    },
    resultPage: () => { throw new Error("unexpected artifact page"); },
  } as unknown as GatewayRuntime;
  return { runtime, calls };
}

function question(entry: JsonObject): JsonObject {
  return { entry_type: "Item", points_possible: 1, entry: { title: "Organelles", scoring_algorithm: "Equivalence", ...entry } };
}

const readableQuestion: JsonObject = question({
  item_body: '<p>Which organelle makes most of a cell\'s ATP?</p><img src="/courses/42/files/9" alt="A cell diagram">',
  interaction_type_slug: "choice",
  interaction_data: { choices: [{ id: payloadChoiceA, position: 1, item_body: "Mitochondrion" }, { id: payloadChoiceB, position: 2, item_body: "Ribosome" }] },
  scoring_data: { value: payloadChoiceA },
});

describe("New Quiz question create planning checks the payload", () => {
  it("plans the documented Numeric and mixed fill-in-the-blank question shapes", async () => {
    const cases = await payloadCases();
    const blankId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const richFill = {
      entry: {
        interaction_type_slug: "rich-fill-blank", item_body: `<p><span id="blank_${blankId}"></span></p>`,
        interaction_data: { blanks: [{ id: blankId, answer_type: "openEntry" }] },
        scoring_data: { value: [{ id: blankId, scoring_algorithm: "TextInChoices", scoring_data: { value: ["Cell"], blank_text: "Cell" } }], working_item_body: "<p>`Cell`</p>" },
        scoring_algorithm: "MultipleMethods",
      },
    };
    for (const supplied of [cases.typedNumeric(), richFill]) {
      const { runtime } = fixture();
      const item = question(supplied.entry as JsonObject);
      const result = await planNewQuizItemCreate(runtime, { source_binding_id: sourceBindingId, course_id: "42", quiz_id: "77", item });
      expect(result.isError).toBeUndefined();
      expect((result.structuredContent as JsonObject).status).toBe("planned");
    }
  });

  it("plans a question whose images name their alternative text", async () => {
    const { runtime, calls } = fixture();
    const result = await planNewQuizItemCreate(runtime, { source_binding_id: sourceBindingId, course_id: "42", quiz_id: "77", item: readableQuestion });
    expect(result.isError).toBeUndefined();
    expect((result.structuredContent as JsonObject).status).toBe("planned");
  });

  it("refuses an image with no alternative text and reads no Canvas route", async () => {
    const { runtime, calls } = fixture();
    const item = question({
      item_body: '<p>Which organelle makes most of a cell\'s ATP?</p><img src="/courses/42/files/9">',
      interaction_type_slug: "choice",
      interaction_data: { choices: [{ id: payloadChoiceA, item_body: "Mitochondrion" }, { id: payloadChoiceB, item_body: "Ribosome" }] },
      scoring_data: { value: payloadChoiceA },
    });
    const result = await planNewQuizItemCreate(runtime, { source_binding_id: sourceBindingId, course_id: "42", quiz_id: "77", item });
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining("no alt attribute") as unknown as string });
    // The payload is checked before anything is read, so a question a person has
    // to fix costs no Canvas request.
    expect(calls).toEqual([]);
  });

  it("refuses an answer key that names a choice the question does not have", async () => {
    const { runtime, calls } = fixture();
    const item = question({
      item_body: "<p>Which organelle makes most of a cell's ATP?</p>",
      interaction_type_slug: "choice",
      interaction_data: { choices: [{ id: payloadChoiceA, item_body: "Mitochondrion" }, { id: payloadChoiceB, item_body: "Ribosome" }] },
      scoring_data: { value: "99999999-9999-4999-8999-999999999999" },
    });
    const result = await planNewQuizItemCreate(runtime, { source_binding_id: sourceBindingId, course_id: "42", quiz_id: "77", item });
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining("names a choice this question does not have") as unknown as string });
    expect(calls).toEqual([]);
  });

  it("refuses a malformed create instead of passing its interaction type through", async () => {
    const { runtime, calls } = fixture();
    const item = question({
      item_body: "<p>Sort these organelles by size.</p>",
      interaction_type_slug: "ordering",
      interaction_data: { choices: [{ id: "c1", item_body: "Mitochondrion" }] },
      scoring_data: { value: ["c1"] },
      scoring_algorithm: "DeepEquals",
    });
    const result = await planNewQuizItemCreate(runtime, { source_binding_id: sourceBindingId, course_id: "42", quiz_id: "77", item });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("ordering question needs keyed choices");
    expect(calls).toEqual([]);
  });
});
