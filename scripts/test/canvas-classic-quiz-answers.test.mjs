import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInThisContext } from "node:vm";
import { canvasOperationAdmission } from "../../connector/extension/generated/canvas-operation-admission.js";

const ORIGIN = "https://school.instructure.com";
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
 * a classic script against these page globals, and the write goes through its
 * own message listener, so the recorded request is the one Canvas would receive.
 */
async function sendQuizQuestionWrite(toolName, args) {
  const keys = ["location", "document", "fetch", "chrome", "__morrowCanvasConnectorInstalled"];
  const descriptors = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const operation = catalogOperation(toolName);
  const requests = [];
  const listeners = [];
  const values = {
    location: { origin: ORIGIN, pathname: "/courses/42/quizzes/77" },
    document: { cookie: "_csrf_token=csrf-value; _legacy_normandy_session=session" },
    fetch: async (input, options = {}) => {
      const url = new URL(String(input?.href ?? input), ORIGIN);
      if (url.pathname === "/api/v1/users/self/profile") return jsonResponse({ id: "7", name: "Teacher" });
      if (url.pathname === "/api/v1/courses/42") return jsonResponse({ id: "42", name: "Biology" });
      requests.push({
        pathname: url.pathname,
        method: options.method || "GET",
        contentType: options.headers?.get("Content-Type") || "",
        body: String(options.body ?? ""),
      });
      return jsonResponse({ id: "512", question_type: "multiple_choice_question" });
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
        courseId: "42",
      }, null, resolve);
      if (handled !== true) reject(new Error("the content script did not accept the execute message"));
    });
    return { result, requests };
  } finally {
    for (const key of keys) {
      const descriptor = descriptors.get(key);
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
}

const VALID_ANSWERS = [
  { id: "6656", answer_text: "Constantinople", answer_weight: 100, answer_comments: "Correct." },
  { answer_text: "", answer_weight: 0, answer_html: "<p>Ankara</p>" },
];

test("a Classic Quiz question write sends every answer as indexed form fields", async () => {
  const { result, requests } = await sendQuizQuestionWrite("canvas_update_existing_quiz_question", {
    course_id: "42",
    quiz_id: "77",
    id: "512",
    question_question_type: "multiple_choice_question",
    question_answers: VALID_ANSWERS,
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, "PUT");
  assert.equal(requests[0].pathname, "/api/v1/courses/42/quizzes/77/questions/512");
  assert.match(requests[0].contentType, /^application\/x-www-form-urlencoded/);
  assert.deepEqual([...new URLSearchParams(requests[0].body).entries()], [
    ["question[answers][0][id]", "6656"],
    ["question[answers][0][answer_text]", "Constantinople"],
    ["question[answers][0][answer_weight]", "100"],
    ["question[answers][0][answer_comments]", "Correct."],
    ["question[answers][1][answer_text]", ""],
    ["question[answers][1][answer_weight]", "0"],
    ["question[answers][1][answer_html]", "<p>Ankara</p>"],
    ["question[question_type]", "multiple_choice_question"],
  ]);
});

test("a new Classic Quiz question sends the same indexed answer fields", async () => {
  const { result, requests } = await sendQuizQuestionWrite("canvas_create_single_quiz_question", {
    course_id: "42",
    quiz_id: "77",
    question_question_name: "Capital",
    question_answers: [{ answer_text: "True", answer_weight: 100 }],
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(requests[0].method, "POST");
  assert.equal(requests[0].pathname, "/api/v1/courses/42/quizzes/77/questions");
  assert.deepEqual([...new URLSearchParams(requests[0].body).entries()], [
    ["question[answers][0][answer_text]", "True"],
    ["question[answers][0][answer_weight]", "100"],
    ["question[question_name]", "Capital"],
  ]);
});

test("an answer array Canvas cannot accept is refused before anything is sent", async () => {
  const refused = [
    [],
    "Constantinople",
    [{ answer_text: "Constantinople" }],
    [{ answer_weight: 100 }],
    [{ answer_text: "Constantinople", answer_weight: 101 }],
    [{ answer_text: "Constantinople", answer_weight: "100" }],
    [{ answer_text: "Constantinople", answer_weight: 100, id: "0" }],
    [{ answer_text: "Constantinople", answer_weight: 100, answer_match_left: "Utah" }],
    [{ answer_text: "Constantinople", answer_weight: 100, answer_html: 12 }],
    [{ answer_text: "x".repeat(16_385), answer_weight: 100 }],
    Array.from({ length: 101 }, () => ({ answer_text: "Constantinople", answer_weight: 0 })),
  ];
  for (const question_answers of refused) {
    const { result, requests } = await sendQuizQuestionWrite("canvas_update_existing_quiz_question", {
      course_id: "42",
      quiz_id: "77",
      id: "512",
      question_answers,
    });
    assert.deepEqual(result, { ok: false, sent: false, error: "canvas_classic_quiz_answers_invalid" }, JSON.stringify(question_answers));
    assert.deepEqual(requests, [], JSON.stringify(question_answers));
  }
});
