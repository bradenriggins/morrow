import assert from "node:assert/strict";
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
const CONTENT_SOURCE = readFileSync(new URL("../../connector/extension/src/canvas-content.js", import.meta.url), "utf8");
const CATALOG = JSON.parse(readFileSync(new URL("../../artifacts/canvas-api/canvas-api-catalog.json", import.meta.url), "utf8"));

function catalogOperation(toolName) {
  const operation = CATALOG.operations.find((entry) => entry.toolName === toolName);
  assert.ok(operation, `missing Canvas operation ${toolName}`);
  // Exactly what connector/extension/src/service-worker.js sends to the page.
  return { ...operation, morrowCourseTarget: canvasOperationAdmission(operation).courseTarget };
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

/**
 * Runs the real content script the way Chrome runs it: the file is evaluated as
 * a classic script against these page globals, so the request the test reads is
 * the request Canvas would receive. `item` answers the New Quiz item read this
 * guard makes, and `itemStatus` makes that read fail.
 */
async function sendQuizItem(args, { item = null, itemStatus = 200 } = {}) {
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
        return itemStatus === 200 ? jsonResponse(item) : jsonResponse({ errors: [{ message: "no" }] }, itemStatus);
      }
      return jsonResponse(item);
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

function item(entry) {
  return { id: ITEM_ID, entry_type: "Item", position: 1, points_possible: 1, entry };
}

const CHOICE_ITEM = item({
  interaction_type_slug: "choice",
  item_body: "<p>Which organelle makes most of a cell's ATP?</p>",
  interaction_data: {
    choices: [
      { id: "choice_a", position: 1, item_body: "<p>Mitochondrion</p>" },
      { id: "choice_b", position: 2, item_body: "<p>Ribosome</p>" },
      { id: "choice_c", position: 3, item_body: "<p>Golgi apparatus</p>" },
    ],
  },
  scoring_data: { value: "choice_a" },
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
  scoring_data: { value: { "q-1": "Makes ATP", "q-2": "Assembles proteins" } },
});

const RICH_FILL_ITEM = item({
  interaction_type_slug: "rich-fill-blank",
  item_body: '<p>A cell makes ATP in the <span id="blank_b1"></span> and proteins on the <span id="blank_b2"></span>.</p>',
  interaction_data: {
    blanks: [
      { id: "b1", blank_text: "mitochondrion" },
      { id: "b2", blank_text: "ribosome" },
    ],
  },
  scoring_data: { value: [{ id: "b1", scoring_data: { value: "mitochondrion" } }, { id: "b2", scoring_data: { value: "ribosome" } }] },
});

const ESSAY_ITEM = item({
  interaction_type_slug: "essay",
  item_body: "<p>Explain how a cell makes ATP.</p>",
  scoring_data: { value: "" },
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
    interaction: withChoices(CHOICES.map((choice) => choice.id === "choice_b" ? { ...choice, item_body: '<p><img src="/courses/42/files/9" alt="A ribosome"></p>' } : choice)),
    allowed: true,
  },
  {
    name: "a renamed choice id",
    current: CHOICE_ITEM,
    interaction: withChoices(CHOICES.map((choice) => choice.id === "choice_b" ? { ...choice, id: "choice_b2" } : choice)),
    allowed: false,
  },
  {
    name: "an added choice",
    current: CHOICE_ITEM,
    interaction: withChoices([...CHOICES, { id: "choice_d", position: 4, item_body: "<p>Lysosome</p>" }]),
    allowed: false,
  },
  {
    name: "a removed choice",
    current: CHOICE_ITEM,
    interaction: withChoices(CHOICES.filter((choice) => choice.id !== "choice_c")),
    allowed: false,
  },
  {
    name: "a whole set of regenerated choice ids",
    current: CHOICE_ITEM,
    interaction: withChoices(CHOICES.map((choice, index) => ({ ...choice, id: `4f6b0a${index}` }))),
    allowed: false,
  },
  {
    name: "a choice with no id at all",
    current: CHOICE_ITEM,
    interaction: withChoices(CHOICES.map((choice) => choice.id === "choice_c" ? { position: 3, item_body: choice.item_body } : choice)),
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
      blanks: [{ id: "b1", blank_text: "mitochondrion" }, { id: "blank_2", blank_text: "ribosome" }],
    },
    allowed: false,
  },
  {
    name: "a rich fill in the blank text change under the same ids",
    current: RICH_FILL_ITEM,
    interaction: {
      ...RICH_FILL_ITEM.entry.interaction_data,
      blanks: [{ id: "b1", blank_text: "mitochondrion" }, { id: "b2", blank_text: "ribosomes" }],
    },
    allowed: true,
  },
];

function proposed(current, interaction) {
  return { ...current, entry: { ...current.entry, interaction_data: interaction } };
}

test("the interaction ids of an item are the ordered member ids of every list it carries", () => {
  assert.deepEqual(newQuizInteractionIds(CHOICE_ITEM), { choices: ["choice_a", "choice_b", "choice_c"] });
  assert.deepEqual(newQuizInteractionIds(MATCHING_ITEM), { questions: ["q-1", "q-2"] });
  assert.deepEqual(newQuizInteractionIds(RICH_FILL_ITEM), { blanks: ["b1", "b2"] });
  assert.deepEqual(newQuizInteractionIds(item({ interaction_data: { entries: [{ id: 1 }, { id: 2 }] } })), { entries: ["1", "2"] });

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
  assert.equal(newQuizIdsPreserved(CHOICE_ITEM, proposed(CHOICE_ITEM, withChoices([CHOICES[0], CHOICES[1], { ...CHOICES[2], id: "choice_b" }]))), false);

  // Dropping the whole list is a structural change, not a preserved id set.
  assert.equal(newQuizIdsPreserved(CHOICE_ITEM, proposed(CHOICE_ITEM, { shuffle: false })), false);
});

test("the connector refuses every id change before it sends anything", async () => {
  for (const entry of CASES) {
    const { result, requests, sent } = await sendQuizItem({ item_entry_interaction_data: entry.interaction }, { item: entry.current });
    assert.equal(result.ok, entry.allowed, `${entry.name}: ${JSON.stringify(result)}`);
    if (entry.allowed) {
      assert.deepEqual(sent.map((request) => request.pathname), [ITEM_PATH], entry.name);
      assert.deepEqual(JSON.parse(sent[0].body), { item: { entry: { interaction_data: entry.interaction } } }, entry.name);
      continue;
    }
    assert.equal(result.sent, false, entry.name);
    assert.match(result.error, /^new_quiz_interaction_ids_changed: /, entry.name);
    assert.deepEqual(sent, [], entry.name);
    assert.deepEqual(requests.map((request) => `${request.method} ${request.pathname}`), [`GET ${ITEM_PATH}`], entry.name);
  }
});

test("the guarded answer repair keeps every id, so it is still sent", async () => {
  // The shape connector/extension/src/canvas-content.js builds for the
  // canvas_new_quiz_choice_image_alt repair: the current interaction data with
  // one existing answer's body rewritten and every id left alone.
  const repaired = withChoices(CHOICES.map((choice) => choice.id === "choice_a"
    ? { ...choice, item_body: '<p><img src="/courses/42/files/12" alt="Mitochondrion diagram"></p>' }
    : choice));
  const { result, sent } = await sendQuizItem({ item_entry_interaction_data: repaired }, { item: CHOICE_ITEM });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(sent.length, 1);
  assert.deepEqual(JSON.parse(sent[0].body), { item: { entry: { interaction_data: repaired } } });
});

test("an answer key change is read against the question that holds those ids", async () => {
  const scoring = { value: "choice_b" };
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

test("a change that touches no answer structure reads nothing and is sent unchanged", async () => {
  const { result, requests } = await sendQuizItem({ item_entry_item_body: "<p>Explain how a cell makes ATP. Use one example.</p>" }, { item: ESSAY_ITEM });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(requests.map((request) => `${request.method} ${request.pathname}`), [`PATCH ${ITEM_PATH}`]);
  assert.deepEqual(JSON.parse(requests[0].body), { item: { entry: { item_body: "<p>Explain how a cell makes ATP. Use one example.</p>" } } });
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
