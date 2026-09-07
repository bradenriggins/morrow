import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInThisContext } from "node:vm";
import { canvasOperationAdmission } from "../../connector/extension/generated/canvas-operation-admission.js";

const ORIGIN = "https://school.instructure.com";
const COURSE_ID = "42";
const QUIZ_ID = "77";
const QUESTION_ID = "301";
const CONTENT_SOURCE = readFileSync(new URL("../../connector/extension/src/canvas-content.js", import.meta.url), "utf8");
const CATALOG = JSON.parse(readFileSync(new URL("../../artifacts/canvas-api/canvas-api-catalog.json", import.meta.url), "utf8"));
/**
 * The alternative-text rewrite itself needs a DOM, which this harness does not
 * have. `document.createElement` therefore raises this marker, so a run that
 * reaches it has passed every question check, every digest comparison, and the
 * complete payload rebuild. The rewrite and the saved-question comparison are
 * proved in scripts/test/canvas-connector-browser.mjs, which runs the same file
 * inside real Chrome.
 */
const DOM_MARKER = "morrow_test_dom_unavailable";

function catalogOperation(toolName) {
  const operation = CATALOG.operations.find((entry) => entry.toolName === toolName);
  assert.ok(operation, `missing Canvas operation ${toolName}`);
  // Exactly what connector/extension/src/service-worker.js sends to the page.
  return { ...operation, morrowCourseTarget: canvasOperationAdmission(operation).courseTarget };
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

/** The connector's own key ordering, written out here so a drift in either copy fails. */
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  return JSON.stringify(value === undefined ? null : value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** The digest the guard carries: the whole fresh question without updated_at and without the one edited field. */
function protectedQuestionDigest(question, answerId, answerField) {
  const state = structuredClone(question);
  delete state.updated_at;
  if (answerId === undefined) delete state.question_text;
  else {
    const answer = state.answers.find((candidate) => String(candidate.id) === answerId);
    assert.ok(answer, "the fixture question has no such answer");
    delete answer[answerField];
  }
  return sha256(stable(state));
}

const MISSING_ALT_IMAGE = '<img src="/courses/42/files/16">';
const QUESTION = Object.freeze({
  id: QUESTION_ID,
  quiz_id: QUIZ_ID,
  quiz_group_id: null,
  assessment_question_id: "9001",
  position: 1,
  question_name: "Cell structure",
  question_type: "multiple_choice_question",
  question_text: `<p>Which part controls the cell?</p>${MISSING_ALT_IMAGE}`,
  points_possible: 2,
  correct_comments: "Correct.",
  incorrect_comments: "Review the diagram.",
  neutral_comments: "",
  correct_comments_html: "<p>Correct.</p>",
  incorrect_comments_html: "<p>Review the diagram.</p>",
  neutral_comments_html: "",
  answers: [
    { id: "6656", answer_text: `<p>Nucleus</p>${MISSING_ALT_IMAGE}`, answer_weight: 100, answer_comments: "Correct." },
    { id: "6657", answer_text: "<p>Cell wall</p>", answer_weight: 0, answer_comments: "Review the diagram." },
  ],
});

function question(overrides = {}) {
  return { ...structuredClone(QUESTION), ...overrides };
}

/**
 * Builds the guard a fresh Morrow plan would carry for one image in one field
 * of this question. `answer` selects an answer field instead of the question
 * text; `overrides` replaces guard fields to test a stale or shifted guard.
 */
function guardFor(record, { answer, overrides = {} } = {}) {
  const body = answer ? record.answers.find((entry) => entry.id === answer.id)[answer.field] : record.question_text;
  const imageStart = body.indexOf(MISSING_ALT_IMAGE);
  assert.ok(imageStart >= 0, "the fixture body has no missing-alt image");
  return {
    kind: "classic_quiz_question_image_alt",
    course_id: COURSE_ID,
    quiz_id: QUIZ_ID,
    question_id: QUESTION_ID,
    ...(answer ? { answer_id: answer.id, answer_field: answer.field } : {}),
    body_sha256: sha256(body),
    protected_state_sha256: protectedQuestionDigest(record, answer?.id, answer?.field),
    image_index: 1,
    image_start: imageStart,
    image_end: imageStart + MISSING_ALT_IMAGE.length - 1,
    image_tag_sha256: sha256(MISSING_ALT_IMAGE),
    image_src_sha256: sha256("/courses/42/files/16"),
    alt_text: "Cell structure diagram",
    decorative: false,
    ...overrides,
  };
}

/**
 * Runs the real content script the way Chrome runs it: the file is evaluated as
 * a classic script against these page globals, and the write goes through its
 * own message listener, so every check runs exactly as it would on a Canvas
 * page. `record` is what the fresh pre-write read returns.
 */
async function sendQuestionRepair(args, record) {
  const keys = ["location", "document", "fetch", "chrome", "__morrowCanvasConnectorInstalled"];
  const descriptors = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const operation = catalogOperation("canvas_update_existing_quiz_question");
  const requests = [];
  const listeners = [];
  const values = {
    location: { origin: ORIGIN, protocol: "https:", pathname: `/courses/${COURSE_ID}/quizzes/${QUIZ_ID}` },
    document: {
      cookie: "_csrf_token=csrf-value; _legacy_normandy_session=session",
      createElement: () => { throw new Error(DOM_MARKER); },
    },
    fetch: async (input, options = {}) => {
      const url = new URL(String(input?.href ?? input), ORIGIN);
      if (url.pathname === "/api/v1/users/self/profile") return jsonResponse({ id: "7", name: "Teacher" });
      if (url.pathname === `/api/v1/courses/${COURSE_ID}`) return jsonResponse({ id: COURSE_ID, name: "Biology" });
      const method = options.method || "GET";
      requests.push({ pathname: url.pathname, method, body: String(options.body ?? "") });
      if (method === "GET") return jsonResponse(record);
      return jsonResponse(record);
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
        arguments: args,
        principalId: "7",
        expiresAt: Date.now() + 60_000,
        courseId: COURSE_ID,
      }, null, resolve);
      if (handled !== true) reject(new Error("the content script did not accept the execute message"));
    });
    return { result, requests, writes: requests.filter((entry) => entry.method !== "GET") };
  } finally {
    for (const key of keys) {
      const descriptor = descriptors.get(key);
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
}

function repairArguments(guard) {
  return { course_id: COURSE_ID, quiz_id: QUIZ_ID, id: QUESTION_ID, morrow_canvas_content_guard: guard };
}

/** Every refusal must leave Canvas untouched, so no request other than the fresh read may be made. */
async function refusal(args, record) {
  const { result, writes } = await sendQuestionRepair(args, record);
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.sent, false, JSON.stringify(result));
  assert.deepEqual(writes, [], "a refused Classic Quiz question repair sent a request to Canvas");
  return String(result.error);
}

test("a complete question read reaches the alternative-text rewrite with every check passed", async () => {
  const record = question();
  const error = await refusal(repairArguments(guardFor(record)), record);
  assert.match(error, new RegExp(DOM_MARKER));
});

test("an answer image is selected by its own answer id and field", async () => {
  const record = question();
  const error = await refusal(repairArguments(guardFor(record, { answer: { id: "6656", field: "answer_text" } })), record);
  assert.match(error, new RegExp(DOM_MARKER));
});

test("a question in a question group is refused", async () => {
  const record = question({ quiz_group_id: "5501" });
  const error = await refusal(repairArguments(guardFor(record)), record);
  assert.match(error, /^classic_quiz_question_group_linked: /);
  assert.match(error, /question group/);
});

test("an unsupported question type is refused", async () => {
  for (const questionType of ["matching_question", "calculated_question", "fill_in_multiple_blanks_question"]) {
    const record = question({ question_type: questionType });
    const error = await refusal(repairArguments(guardFor(record)), record);
    assert.match(error, /^classic_quiz_question_type_unsupported: /, questionType);
  }
});

test("a documented field the write must resend, absent from the read, is refused by name", async () => {
  for (const field of ["question_name", "correct_comments", "incorrect_comments", "neutral_comments", "position", "points_possible"]) {
    const record = question();
    delete record[field];
    const error = await refusal(repairArguments(guardFor(record)), record);
    assert.match(error, /^classic_quiz_question_incomplete: /, field);
    assert.match(error, new RegExp(`did not return ${field} `), field);
  }
});

test("a question read that carries state this write cannot resend is refused by name", async () => {
  const record = question({ regrade_option: "current_and_previous_submissions" });
  const error = await refusal(repairArguments(guardFor(question())), record);
  assert.match(error, /^classic_quiz_question_unmodelled_state: /);
  assert.match(error, /regrade_option/);
});

test("an answer that carries state this write cannot resend is refused", async () => {
  const record = question();
  record.answers[1].blank_id = "response1";
  const error = await refusal(repairArguments(guardFor(question())), record);
  assert.match(error, /^classic_quiz_question_unmodelled_state: /);
  assert.match(error, /blank_id/);
});

test("an essay question with answers, and a scored question without them, are both refused", async () => {
  const essayWithAnswers = question({ question_type: "essay_question" });
  assert.match(
    await refusal(repairArguments(guardFor(essayWithAnswers)), essayWithAnswers),
    /^classic_quiz_question_unmodelled_state: /,
  );
  const scoredWithoutAnswers = question({ answers: [] });
  assert.match(
    await refusal(repairArguments(guardFor(scoredWithoutAnswers)), scoredWithoutAnswers),
    /^classic_quiz_question_incomplete: /,
  );
});

test("an answer without an exact identifier, or with a repeated one, is refused", async () => {
  const missingId = question();
  delete missingId.answers[1].id;
  assert.match(
    await refusal(repairArguments(guardFor(question())), missingId),
    /^classic_quiz_question_incomplete: /,
  );
  const repeatedId = question();
  repeatedId.answers[1].id = repeatedId.answers[0].id;
  assert.match(
    await refusal(repairArguments(guardFor(question())), repeatedId),
    /^classic_quiz_question_incomplete: /,
  );
});

test("a question or answer that changed since the plan is refused before anything is sent", async () => {
  const record = question();
  const staleBody = { ...record, question_text: `${record.question_text}<p>Edited in Canvas.</p>` };
  assert.match(await refusal(repairArguments(guardFor(record)), staleBody), /^canvas_content_changed: /);
  const staleProtectedState = { ...record, points_possible: 5 };
  assert.match(await refusal(repairArguments(guardFor(record)), staleProtectedState), /^canvas_content_changed: /);
  const staleAnswerComment = structuredClone(record);
  staleAnswerComment.answers[0].answer_comments = "Changed in Canvas.";
  assert.match(
    await refusal(repairArguments(guardFor(record, { answer: { id: "6656", field: "answer_text" } })), staleAnswerComment),
    /^canvas_content_changed: /,
  );
});

test("a selected answer that is no longer in the question is refused", async () => {
  const record = question();
  const guard = guardFor(record, { answer: { id: "6656", field: "answer_text" } });
  const withoutSelected = structuredClone(record);
  withoutSelected.answers = [withoutSelected.answers[1]];
  const error = await refusal(repairArguments(guard), withoutSelected);
  assert.match(error, /^classic_quiz_question_answer_unavailable: /);
});

test("a selected answer field the read does not carry is refused", async () => {
  const record = question();
  record.answers[0].answer_html = `<p>Nucleus</p>${MISSING_ALT_IMAGE}`;
  const guard = guardFor(record, { answer: { id: "6656", field: "answer_html" } });
  const withoutHtml = structuredClone(record);
  delete withoutHtml.answers[0].answer_html;
  const error = await refusal(repairArguments(guard), withoutHtml);
  assert.match(error, /^classic_quiz_question_answer_unavailable: /);
});

test("a half-stated answer selector is not a valid guard", async () => {
  const record = question();
  for (const overrides of [{ answer_id: "6656" }, { answer_field: "answer_text" }, { answer_id: "6656", answer_field: "answer_comments" }, { answer_id: "not-an-id", answer_field: "answer_text" }]) {
    const guard = { ...guardFor(record), ...overrides };
    assert.match(await refusal(repairArguments(guard), record), /^canvas_content_guard_invalid$/, JSON.stringify(overrides));
  }
});

test("the repair carries no argument beyond the course, quiz, question and its guard", async () => {
  const record = question();
  const guard = guardFor(record);
  for (const extra of [{ question_question_text: "<p>Rewritten.</p>" }, { question_points_possible: "5" }, { question_question_name: "Renamed" }]) {
    const error = await refusal({ ...repairArguments(guard), ...extra }, record);
    assert.match(error, /^canvas_content_check_invalid$/, JSON.stringify(extra));
  }
  // An empty answer array never reaches Canvas: the answer serializer refuses it
  // before the guard is read, so a question is never rebuilt without its answers.
  const emptyAnswers = await refusal({ ...repairArguments(guard), question_answers: [] }, record);
  assert.match(emptyAnswers, /^canvas_classic_quiz_answers_invalid$/);
});

test("a guard for a different course, quiz or question is refused", async () => {
  const record = question();
  assert.match(await refusal(repairArguments({ ...guardFor(record), quiz_id: "78" }), record), /^canvas_content_check_invalid$/);
  assert.match(await refusal(repairArguments({ ...guardFor(record), question_id: "302" }), record), /^canvas_content_check_invalid$/);
  assert.match(await refusal(repairArguments({ ...guardFor(record), course_id: "43" }), record), /^canvas_content_guard_invalid$/);
});

test("a read that names a different quiz than the guard is refused", async () => {
  const record = question({ quiz_id: "78" });
  assert.match(await refusal(repairArguments(guardFor(question())), record), /^canvas_content_target_changed$/);
});
