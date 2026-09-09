import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInThisContext } from "node:vm";
import { canvasOperationAdmission } from "../../connector/extension/generated/canvas-operation-admission.js";
import { categoriesForBinding } from "../../connector/extension/src/edit-policy.js";
import { newQuizIdsPreserved, newQuizInteractionIds } from "../../connector/extension/src/new-quiz-item-guard.js";

const ORIGIN = "https://school.instructure.com";
const COURSE_ID = "42";
const QUIZ_ID = "77";
const ITEM_ID = "88";
const ITEM_PATH = `/api/quiz/v1/courses/${COURSE_ID}/quizzes/${QUIZ_ID}/items/${ITEM_ID}`;
const ITEMS_PATH = `/api/quiz/v1/courses/${COURSE_ID}/quizzes/${QUIZ_ID}/items`;
const CONTENT_SOURCE = readFileSync(new URL("../../connector/extension/src/canvas-content.js", import.meta.url), "utf8");
const CATALOG = JSON.parse(readFileSync(new URL("../../artifacts/canvas-api/canvas-api-catalog.json", import.meta.url), "utf8"));

function catalogOperation(toolName) {
  const operation = CATALOG.operations.find((entry) => entry.toolName === toolName);
  assert.ok(operation, `missing Canvas operation ${toolName}`);
  // Exactly what connector/extension/src/service-worker.js sends to the page.
  return { ...operation, morrowCourseTarget: canvasOperationAdmission(operation).courseTarget };
}

function jsonResponse(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } });
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/**
 * Runs the real content script the way Chrome runs it: the file is evaluated as
 * a classic script against these page globals, so the request the test reads is
 * the request Canvas would receive. `item` answers the New Quiz item read this
 * guard makes, and `itemStatus` makes that read fail.
 */
async function sendQuizItem(args, {
  item = ESSAY_ITEM,
  itemStatus = 200,
  listReads = [],
  patchStatus = 200,
  patchThrows = false,
} = {}) {
  const keys = ["location", "document", "fetch", "chrome", "__morrowCanvasConnectorInstalled"];
  const descriptors = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const operation = catalogOperation("canvas_update_quiz_item");
  const requests = [];
  const listeners = [];
  const values = {
    location: { origin: ORIGIN, protocol: "https:", pathname: `/courses/${COURSE_ID}/quizzes` },
    document: { cookie: "_csrf_token=csrf-value; _legacy_normandy_session=session" },
    fetch: async (input, options = {}) => {
      const url = new URL(String(input?.href ?? input), ORIGIN);
      if (url.pathname === "/api/v1/users/self/profile") return jsonResponse({ id: "7", name: "Teacher" });
      if (url.pathname === `/api/v1/courses/${COURSE_ID}`) return jsonResponse({ id: COURSE_ID, name: "Biology" });
      const method = options.method || "GET";
      requests.push({ method, pathname: url.pathname, body: options.body ?? null });
      if (method === "GET") {
        if (url.pathname === ITEMS_PATH) {
          const read = listReads.shift();
          if (!read) return jsonResponse({ errors: [{ message: "unexpected list read" }] }, 500);
          if (read.throws) throw new TypeError("connection closed");
          return jsonResponse(read.value, read.status ?? 200, read.link ? { Link: read.link } : {});
        }
        return itemStatus === 200 ? jsonResponse(item) : jsonResponse({ errors: [{ message: "no" }] }, itemStatus);
      }
      if (patchThrows) throw new TypeError("connection closed");
      return jsonResponse(item, patchStatus);
    },
    chrome: { runtime: { onMessage: { addListener: (listener) => listeners.push(listener) } } },
    __morrowCanvasConnectorInstalled: undefined,
  };
  try {
    for (const [key, value] of Object.entries(values)) {
      Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    }
    delete globalThis.__morrowCanvasConnectorInstalled;
    runInThisContext(CONTENT_SOURCE, { filename: "canvas-content.js" });
    assert.equal(listeners.length, 1, "the content script registered no message listener");
    const result = await new Promise((resolve, reject) => {
      const handled = listeners[0]({
        type: "morrow_canvas_execute",
        operation,
        arguments: { course_id: COURSE_ID, assignment_id: QUIZ_ID, item_id: ITEM_ID, ...args },
        principalId: "7",
        expiresAt: Date.now() + 60_000,
        courseId: COURSE_ID,
      }, null, resolve);
      if (handled !== true) reject(new Error("the content script did not accept the execute message"));
    });
    return { result, requests, sent: requests.filter((request) => request.method === "PATCH") };
  } finally {
    for (const key of keys) {
      const descriptor = descriptors.get(key);
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
}

function orderRows(ids) {
  return ids.map((id, index) => ({ id, position: index + 1, entry_type: "Item" }));
}

function positionGuard(before, expected) {
  return {
    kind: "new_quiz_item_position",
    before_item_ids_sha256: digest(before),
    expected_item_ids: expected,
    expected_item_ids_sha256: digest(expected),
  };
}

function item(entry) {
  return { id: ITEM_ID, entry_type: "Item", status: "mutable", position: 1, points_possible: 1, entry };
}

const CHOICE_A = "11111111-1111-4111-8111-111111111111";
const CHOICE_B = "22222222-2222-4222-8222-222222222222";
const CHOICE_C = "33333333-3333-4333-8333-333333333333";
const CHOICE_D = "44444444-4444-4444-8444-444444444444";
const CHOICE_E = "55555555-5555-4555-8555-555555555555";
const BLANK_A = "66666666-6666-4666-8666-666666666666";
const BLANK_B = "77777777-7777-4777-8777-777777777777";

const CHOICE_ITEM = item({
  interaction_type_slug: "choice",
  item_body: "<p>Which organelle makes most of a cell's ATP?</p>",
  interaction_data: {
    choices: [
      { id: CHOICE_A, position: 1, item_body: "<p>Mitochondrion</p>" },
      { id: CHOICE_B, position: 2, item_body: "<p>Ribosome</p>" },
      { id: CHOICE_C, position: 3, item_body: "<p>Golgi apparatus</p>" },
    ],
  },
  scoring_data: { value: CHOICE_A },
  scoring_algorithm: "Equivalence",
});

const MATCHING_ITEM = item({
  interaction_type_slug: "matching",
  item_body: "<p>Match each organelle to its job.</p>",
  interaction_data: {
    questions: [
      { id: "q-1", item_body: "Mitochondrion" },
      { id: "q-2", item_body: "Ribosome" },
    ],
    answers: ["Makes ATP", "Assembles proteins"],
  },
  properties: { shuffle_rules: { questions: { shuffled: true } } },
  scoring_data: {
    value: { "q-1": "Makes ATP", "q-2": "Assembles proteins" },
    edit_data: { matches: [
      { question_id: "q-1", question_body: "Mitochondrion", answer_body: "Makes ATP" },
      { question_id: "q-2", question_body: "Ribosome", answer_body: "Assembles proteins" },
    ], distractors: [] },
  },
  scoring_algorithm: "DeepEquals",
});

const RICH_FILL_ITEM = item({
  interaction_type_slug: "rich-fill-blank",
  item_body: `<p>A cell makes ATP in the <span id="blank_${BLANK_A}"></span> and proteins on the <span id="blank_${BLANK_B}"></span>.</p>`,
  interaction_data: {
    blanks: [
      { id: BLANK_A, answer_type: "openEntry" },
      { id: BLANK_B, answer_type: "openEntry" },
    ],
  },
  scoring_data: {
    value: [
      { id: BLANK_A, scoring_algorithm: "TextContainsAnswer", scoring_data: { value: "mitochondrion", blank_text: "mitochondrion" } },
      { id: BLANK_B, scoring_algorithm: "TextContainsAnswer", scoring_data: { value: "ribosome", blank_text: "ribosome" } },
    ],
    working_item_body: "A cell makes ATP in the `mitochondrion` and proteins on the `ribosome`.",
  },
  scoring_algorithm: "MultipleMethods",
});

const ESSAY_ITEM = item({
  interaction_type_slug: "essay",
  item_body: "<p>Explain how a cell makes ATP.</p>",
  interaction_data: { rce: true, essay: null, word_count: true, file_upload: false, spell_check: true, word_limit_enabled: false },
  scoring_data: { value: "" },
  scoring_algorithm: "None",
});

function withChoices(choices) {
  return { ...CHOICE_ITEM.entry.interaction_data, choices };
}

const CHOICES = CHOICE_ITEM.entry.interaction_data.choices;

// Every case names the item Canvas holds now and the interaction_data one PATCH
// would send for it. `allowed` is the verdict both copies of the rule have to
// reach: the module below and the copy inside canvas-content.js.
const CASES = [
  { name: "the same ids in the same order", current: CHOICE_ITEM, interaction: withChoices(CHOICES), allowed: true },
  {
    name: "the same ids in a different order",
    current: CHOICE_ITEM,
    interaction: withChoices([CHOICES[2], CHOICES[0], CHOICES[1]]),
    allowed: true,
  },
  {
    name: "one answer rewritten under its own id",
    current: CHOICE_ITEM,
    interaction: withChoices(CHOICES.map((choice) => choice.id === CHOICE_B ? { ...choice, item_body: '<p><img src="/courses/42/files/9" alt="A ribosome"></p>' } : choice)),
    allowed: true,
  },
  {
    name: "a renamed choice id",
    current: CHOICE_ITEM,
    interaction: withChoices(CHOICES.map((choice) => choice.id === CHOICE_B ? { ...choice, id: CHOICE_D } : choice)),
    allowed: false,
  },
  {
    name: "an added choice",
    current: CHOICE_ITEM,
    interaction: withChoices([...CHOICES, { id: CHOICE_D, position: 4, item_body: "<p>Lysosome</p>" }]),
    allowed: false,
  },
  {
    name: "a removed choice",
    current: CHOICE_ITEM,
    interaction: withChoices(CHOICES.filter((choice) => choice.id !== CHOICE_C)),
    allowed: false,
  },
  {
    name: "a whole set of regenerated choice ids",
    current: CHOICE_ITEM,
    interaction: withChoices(CHOICES.map((choice, index) => ({ ...choice, id: [CHOICE_A, CHOICE_D, CHOICE_E][index] }))),
    allowed: false,
  },
  {
    name: "a choice with no id at all",
    current: CHOICE_ITEM,
    interaction: withChoices(CHOICES.map((choice) => choice.id === CHOICE_C ? { position: 3, item_body: choice.item_body } : choice)),
    allowed: false,
  },
  {
    name: "an answer list the question did not have",
    current: ESSAY_ITEM,
    interaction: withChoices(CHOICES),
    allowed: false,
  },
  {
    name: "a matching question rewritten under its own id",
    current: MATCHING_ITEM,
    interaction: {
      ...MATCHING_ITEM.entry.interaction_data,
      questions: [{ id: "q-1", item_body: "Mitochondria" }, { id: "q-2", item_body: "Ribosome" }],
    },
    allowed: true,
  },
  {
    name: "a matching question id change",
    current: MATCHING_ITEM,
    interaction: {
      ...MATCHING_ITEM.entry.interaction_data,
      questions: [{ id: "q-1", item_body: "Mitochondrion" }, { id: "q-3", item_body: "Ribosome" }],
    },
    allowed: false,
  },
  {
    name: "a rich fill in the blank id change",
    current: RICH_FILL_ITEM,
    interaction: {
      ...RICH_FILL_ITEM.entry.interaction_data,
      blanks: [{ id: BLANK_A, answer_type: "openEntry" }, { id: CHOICE_D, answer_type: "openEntry" }],
    },
    allowed: false,
  },
  {
    name: "a rich fill in the blank text change under the same ids",
    current: RICH_FILL_ITEM,
    interaction: {
      ...RICH_FILL_ITEM.entry.interaction_data,
      blanks: [{ id: BLANK_A, answer_type: "openEntry" }, { id: BLANK_B, answer_type: "openEntry", blank_text: "ribosomes" }],
    },
    allowed: true,
  },
];

function proposed(current, interaction) {
  return { ...current, entry: { ...current.entry, interaction_data: interaction } };
}

test("the interaction ids of an item are the ordered member ids of every list it carries", () => {
  assert.deepEqual(newQuizInteractionIds(CHOICE_ITEM), { choices: [CHOICE_A, CHOICE_B, CHOICE_C] });
  assert.deepEqual(newQuizInteractionIds(MATCHING_ITEM), { questions: ["q-1", "q-2"] });
  assert.deepEqual(newQuizInteractionIds(RICH_FILL_ITEM), { blanks: [BLANK_A, BLANK_B] });
  assert.deepEqual(newQuizInteractionIds(item({ interaction_data: { entries: [{ id: 1 }, { id: 2 }] } })), { entries: ["1", "2"] });
  assert.deepEqual(newQuizInteractionIds(item({ interaction_data: {
    categories: { cat_a: { id: "cat_a", item_body: "Cells" }, cat_b: { id: "cat_b", item_body: "Tissues" } },
    distractors: { answer_a: { id: "answer_a", item_body: "Mitochondrion" } },
  } })), { categories: ["cat_a", "cat_b"], distractors: ["answer_a"] });
  assert.deepEqual(newQuizInteractionIds(item({ interaction_data: {
    choices: { first: { id: "first", item_body: "Prophase" }, second: { id: "second", item_body: "Metaphase" } },
  } })), { choices: ["first", "second"] });

  // A question with no interaction_data holds no interaction ids, so nothing
  // about it can change one.
  assert.deepEqual(newQuizInteractionIds(ESSAY_ITEM), {});
  assert.deepEqual(newQuizInteractionIds(item({})), {});
  assert.deepEqual(newQuizInteractionIds(null), {});
  assert.equal(newQuizIdsPreserved(ESSAY_ITEM, ESSAY_ITEM), true);
  assert.equal(newQuizIdsPreserved(ESSAY_ITEM, { ...ESSAY_ITEM, entry: { ...ESSAY_ITEM.entry, item_body: "<p>Rewritten.</p>" } }), true);
});

test("id preservation is decided by the set of ids, not by their order", () => {
  for (const entry of CASES) {
    assert.equal(newQuizIdsPreserved(entry.current, proposed(entry.current, entry.interaction)), entry.allowed, entry.name);
  }

  // A duplicate id cannot be matched to the one element it is meant to replace.
  assert.equal(newQuizIdsPreserved(CHOICE_ITEM, proposed(CHOICE_ITEM, withChoices([CHOICES[0], CHOICES[1], { ...CHOICES[2], id: CHOICE_B }]))), false);

  // Dropping the whole list is a structural change, not a preserved id set.
  assert.equal(newQuizIdsPreserved(CHOICE_ITEM, proposed(CHOICE_ITEM, { shuffle: false })), false);

  const ordering = item({ interaction_data: { choices: {
    first: { id: "first", item_body: "Prophase" }, second: { id: "second", item_body: "Metaphase" },
  } } });
  assert.equal(newQuizIdsPreserved(ordering, proposed(ordering, { choices: {
    first: { id: "first", item_body: "Prophase I" }, second: { id: "second", item_body: "Metaphase" },
  } })), true);
  assert.equal(newQuizIdsPreserved(ordering, proposed(ordering, { choices: {
    first: { id: "renamed", item_body: "Prophase" }, second: { id: "second", item_body: "Metaphase" },
  } })), false);
  assert.equal(newQuizIdsPreserved(ordering, proposed(ordering, { choices: {
    first: { id: "first", item_body: "Prophase" }, third: { id: "third", item_body: "Anaphase" },
  } })), false);
});

test("the connector refuses every invalid structure or id change before it sends anything", async () => {
  const payloadInvalid = new Set([
    "the same ids in a different order",
    "a choice with no id at all",
    "an answer list the question did not have",
    "a matching question rewritten under its own id",
    "a matching question id change",
    "a rich fill in the blank id change",
  ]);
  for (const entry of CASES) {
    const { result, requests, sent } = await sendQuizItem({ item_entry_interaction_data: entry.interaction }, { item: entry.current });
    const sendable = entry.allowed && !payloadInvalid.has(entry.name);
    assert.equal(result.ok, sendable, `${entry.name}: ${JSON.stringify(result)}`);
    if (sendable) {
      assert.deepEqual(sent.map((request) => request.pathname), [ITEM_PATH], entry.name);
      assert.deepEqual(JSON.parse(sent[0].body), { item: { entry: { interaction_data: entry.interaction } } }, entry.name);
      continue;
    }
    assert.equal(result.sent, false, entry.name);
    assert.match(result.error, payloadInvalid.has(entry.name) ? /^new_quiz_item_payload_invalid: / : /^new_quiz_interaction_ids_changed: /, entry.name);
    assert.deepEqual(sent, [], entry.name);
    assert.deepEqual(requests.map((request) => `${request.method} ${request.pathname}`), [`GET ${ITEM_PATH}`], entry.name);
  }
});

test("the guarded answer repair keeps every id, so it is still sent", async () => {
  // The shape connector/extension/src/canvas-content.js builds for the
  // canvas_new_quiz_choice_image_alt repair: the current interaction data with
  // one existing answer's body rewritten and every id left alone.
  const repaired = withChoices(CHOICES.map((choice) => choice.id === CHOICE_A
    ? { ...choice, item_body: '<p><img src="/courses/42/files/12" alt="Mitochondrion diagram"></p>' }
    : choice));
  const { result, sent } = await sendQuizItem({ item_entry_interaction_data: repaired }, { item: CHOICE_ITEM });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(sent.length, 1);
  assert.deepEqual(JSON.parse(sent[0].body), { item: { entry: { interaction_data: repaired } } });
});

test("an answer key change is read against the question that holds those ids", async () => {
  const scoring = { value: CHOICE_B };
  const { result, requests, sent } = await sendQuizItem({ item_entry_scoring_data: scoring }, { item: CHOICE_ITEM });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(requests.map((request) => `${request.method} ${request.pathname}`), [`GET ${ITEM_PATH}`, `PATCH ${ITEM_PATH}`]);
  assert.deepEqual(JSON.parse(sent[0].body), { item: { entry: { scoring_data: scoring } } });

  // The same change against a question Canvas will not return is refused, not warned about.
  const unread = await sendQuizItem({ item_entry_scoring_data: scoring }, { item: CHOICE_ITEM, itemStatus: 500 });
  assert.equal(unread.result.ok, false);
  assert.equal(unread.result.sent, false);
  assert.match(unread.result.error, /^new_quiz_item_read_failed: /);
  assert.deepEqual(unread.sent, []);

  // So is a change against a row that is not the New Quiz item it names.
  const wrong = await sendQuizItem({ item_entry_scoring_data: scoring }, { item: { ...CHOICE_ITEM, entry_type: "Stimulus" } });
  assert.equal(wrong.result.ok, false);
  assert.equal(wrong.result.sent, false);
  assert.match(wrong.result.error, /^new_quiz_item_target_changed: /);
  assert.deepEqual(wrong.sent, []);
});

test("a non-structural change reads the complete item, validates the merged payload, and sends the partial patch", async () => {
  const { result, requests } = await sendQuizItem({ item_entry_item_body: "<p>Explain how a cell makes ATP. Use one example.</p>" }, { item: ESSAY_ITEM });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(requests.map((request) => `${request.method} ${request.pathname}`), [`GET ${ITEM_PATH}`, `PATCH ${ITEM_PATH}`]);
  assert.deepEqual(JSON.parse(requests[1].body), { item: { entry: { item_body: "<p>Explain how a cell makes ATP. Use one example.</p>" } } });
});

test("a guarded move reads the complete order before and after one PATCH", async () => {
  const before = [ITEM_ID, "89", "90"];
  const expected = ["89", ITEM_ID, "90"];
  const { result, requests, sent } = await sendQuizItem({
    item_position: 2,
    morrow_new_quiz_item_position_guard: positionGuard(before, expected),
  }, { listReads: [{ value: orderRows(before) }, { value: orderRows(expected) }] });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.verification, {
    schema: "morrow.browser-verification.v1",
    status: "verified",
    evidence: "complete_new_quiz_item_order_reread_after_write",
  });
  assert.equal(sent.length, 1);
  assert.deepEqual(JSON.parse(sent[0].body), { item: { position: 2 } });
  assert.deepEqual(requests.map((request) => `${request.method} ${request.pathname}`), [
    `GET ${ITEMS_PATH}`,
    `GET ${ITEM_PATH}`,
    `PATCH ${ITEM_PATH}`,
    `GET ${ITEMS_PATH}`,
  ]);
});

test("a position-only update refuses locked and stimulus-linked items before PATCH", async () => {
  const before = [ITEM_ID, "89"];
  const expected = ["89", ITEM_ID];
  const guardedArgs = {
    item_position: 2,
    morrow_new_quiz_item_position_guard: positionGuard(before, expected),
  };
  const unsafeItems = [
    { ...ESSAY_ITEM, status: "immutable" },
    { ...ESSAY_ITEM, status: undefined },
    { ...ESSAY_ITEM, entry_editable: false },
    { ...ESSAY_ITEM, immutable: true },
    { ...ESSAY_ITEM, stimulus_quiz_entry_id: "31" },
  ];
  for (const unsafeItem of unsafeItems) {
    const { result, requests, sent } = await sendQuizItem(guardedArgs, {
      item: unsafeItem,
      listReads: [{ value: orderRows(before) }],
    });
    assert.equal(result.sent, false);
    assert.match(result.error, /^new_quiz_item_edit_dependency_unverified:/);
    assert.deepEqual(sent, []);
    assert.deepEqual(requests.map((request) => `${request.method} ${request.pathname}`), [
      `GET ${ITEMS_PATH}`,
      `GET ${ITEM_PATH}`,
    ]);
  }
});

test("a content update refuses a locked or stimulus-linked item before PATCH", async () => {
  for (const unsafeItem of [
    { ...ESSAY_ITEM, status: "immutable" },
    { ...ESSAY_ITEM, stimulus_quiz_entry_id: "31" },
  ]) {
    const { result, sent } = await sendQuizItem({ item_entry_item_body: "<p>Changed.</p>" }, { item: unsafeItem });
    assert.equal(result.sent, false);
    assert.match(result.error, /^new_quiz_item_edit_dependency_unverified:/);
    assert.deepEqual(sent, []);
  }
});

test("a combined move and content update reads the target item once", async () => {
  const before = [ITEM_ID, "89"];
  const expected = ["89", ITEM_ID];
  const { result, requests } = await sendQuizItem({
    item_position: 2,
    item_entry_item_body: "<p>Explain ATP synthesis.</p>",
    morrow_new_quiz_item_position_guard: positionGuard(before, expected),
  }, {
    item: ESSAY_ITEM,
    listReads: [{ value: orderRows(before) }, { value: orderRows(expected) }],
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(requests.filter((request) => request.method === "GET" && request.pathname === ITEM_PATH).length, 1);
  assert.equal(requests.filter((request) => request.method === "PATCH").length, 1);
});

test("a stale order digest refuses the move before PATCH", async () => {
  const plannedBefore = [ITEM_ID, "89", "90"];
  const savedBefore = [ITEM_ID, "90", "89"];
  const expected = ["89", ITEM_ID, "90"];
  const { result, requests, sent } = await sendQuizItem({
    item_position: 2,
    morrow_new_quiz_item_position_guard: positionGuard(plannedBefore, expected),
  }, { listReads: [{ value: orderRows(savedBefore) }] });

  assert.equal(result.ok, false);
  assert.equal(result.sent, false);
  assert.match(result.error, /^new_quiz_item_position_stale: /);
  assert.deepEqual(sent, []);
  assert.deepEqual(requests.map((request) => `${request.method} ${request.pathname}`), [`GET ${ITEMS_PATH}`]);
});

test("an incomplete paginated order refuses the move before PATCH", async () => {
  const before = [ITEM_ID, "89", "90"];
  const expected = ["89", ITEM_ID, "90"];
  const next = `${ORIGIN}${ITEMS_PATH}?per_page=100&page=2`;
  const { result, requests, sent } = await sendQuizItem({
    item_position: 2,
    morrow_new_quiz_item_position_guard: positionGuard(before, expected),
  }, { listReads: [
    { value: orderRows(before.slice(0, 1)), link: `<${next}>; rel="next"` },
    { value: { id: "not-a-complete-page" } },
  ] });

  assert.equal(result.ok, false);
  assert.equal(result.sent, false);
  assert.equal(result.error, "new_quiz_item_position_list_incomplete");
  assert.deepEqual(sent, []);
  assert.deepEqual(requests.map((request) => `${request.method} ${request.pathname}`), [
    `GET ${ITEMS_PATH}`,
    `GET ${ITEMS_PATH}`,
  ]);
});

test("a direct item_position update without the guard sends no PATCH", async () => {
  const { result, requests, sent } = await sendQuizItem({ item_position: 2 });
  assert.equal(result.ok, false);
  assert.equal(result.sent, false);
  assert.match(result.error, /^new_quiz_item_position_guard_required: /);
  assert.deepEqual(sent, []);
  assert.deepEqual(requests, []);
});

test("an uncertain move response reads the full order once and never retries PATCH", async () => {
  const before = [ITEM_ID, "89", "90"];
  const expected = ["89", ITEM_ID, "90"];
  const guardedArgs = {
    item_position: 2,
    morrow_new_quiz_item_position_guard: positionGuard(before, expected),
  };

  const recovered = await sendQuizItem(guardedArgs, {
    listReads: [{ value: orderRows(before) }, { value: orderRows(expected) }],
    patchThrows: true,
  });
  assert.equal(recovered.result.ok, true, JSON.stringify(recovered.result));
  assert.equal(recovered.result.recovered, true);
  assert.equal(recovered.result.verification.status, "verified");
  assert.equal(recovered.sent.length, 1);
  assert.equal(recovered.requests.filter((request) => request.method === "PATCH").length, 1);
  assert.equal(recovered.requests.filter((request) => request.method === "GET" && request.pathname === ITEMS_PATH).length, 2);

  const mismatched = await sendQuizItem(guardedArgs, {
    listReads: [{ value: orderRows(before) }, { value: orderRows(before) }],
    patchThrows: true,
  });
  assert.equal(mismatched.result.ok, false);
  assert.equal(mismatched.result.outcomeUnknown, true);
  assert.equal(mismatched.result.verification.status, "mismatch");
  assert.equal(mismatched.result.verification.reason, "new_quiz_item_position_readback_mismatch");
  assert.equal(mismatched.sent.length, 1);
  assert.equal(mismatched.requests.filter((request) => request.method === "PATCH").length, 1);
  assert.equal(mismatched.requests.filter((request) => request.method === "GET" && request.pathname === ITEMS_PATH).length, 2);
});

test("the general New Quiz question update is offered for review only", () => {
  const operations = CATALOG.operations.map((operation) => ({ ...operation, provider: "canvas" }));
  const options = categoriesForBinding({ provider: "canvas" }, operations);
  const derived = options.find((option) => option.id === "action:canvas:canvas_update_quiz_item");
  assert.equal(derived.availability, "review");
  assert.match(derived.reviewReason, /delete-then-add contract/);
  assert.equal(derived.rules, undefined);

  // The four curated New Quiz repairs stay the Edit path.
  for (const id of ["canvas_new_quiz_item_image_alt", "canvas_new_quiz_nested_image_alt"]) {
    assert.equal(options.find((option) => option.id === id).availability, "edit", id);
  }
});
