import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInThisContext } from "node:vm";
import { canvasOperationAdmission } from "../../connector/extension/generated/canvas-operation-admission.js";
import { mergeQuizSettings, newQuizSettingsDigestSource, newQuizUsesJsonBody } from "../../connector/extension/src/new-quiz-write-contract.js";

const ORIGIN = "https://school.instructure.com";
const COURSE_ID = "42";
const QUIZ_ID = "77";
const QUIZ_PATH = `/api/quiz/v1/courses/${COURSE_ID}/quizzes/${QUIZ_ID}`;
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

/** The digest a caller takes over the quiz's current settings to build its guard. */
function settingsDigest(quizSettings) {
  return createHash("sha256").update(newQuizSettingsDigestSource(quizSettings)).digest("hex");
}

/**
 * Runs the real content script the way Chrome runs it: the file is evaluated as
 * a classic script against these page globals, so the request the test reads is
 * the request Canvas would receive. `quiz` answers the New Quiz read the
 * settings guard makes; `quizStatus` makes that read fail.
 */
async function sendCanvas(toolName, args, { quiz = null, quizStatus = 200, savedQuiz = quiz, savedQuizStatus = 200 } = {}) {
  const keys = ["location", "document", "fetch", "chrome", "__morrowCanvasConnectorInstalled"];
  const descriptors = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const operation = catalogOperation(toolName);
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
      requests.push({
        method,
        pathname: url.pathname,
        contentType: options.headers?.get?.("Content-Type") ?? null,
        body: options.body ?? null,
      });
      if (method === "GET") {
        const afterWrite = requests.some((request) => request.method !== "GET");
        const status = afterWrite ? savedQuizStatus : quizStatus;
        return status === 200 ? jsonResponse(afterWrite ? savedQuiz : quiz) : jsonResponse({ errors: [{ message: "no" }] }, status);
      }
      return jsonResponse({ id: QUIZ_ID });
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
    return { result, requests, operation };
  } finally {
    for (const key of keys) {
      const descriptor = descriptors.get(key);
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
}

/** The value a catalog parameter accepts, chosen from its own schema. */
function sampleValue(parameter, index) {
  const schema = parameter.schema || {};
  if (schema.type === "boolean") return index % 2 === 0;
  if (schema.type === "integer" || schema.type === "number") return index + 1;
  if (schema.type === "array") return [`value-${index}`];
  if (schema.type === "object") return { sample: `value-${index}` };
  if (schema.pattern === "^[1-9][0-9]*$") return String(index + 1);
  return `value-${index}`;
}

/** Every path and form argument for one operation, with the settings leaves left out. */
function writeArguments(operation) {
  const args = {};
  const sent = [];
  operation.parameters.forEach((parameter, index) => {
    if (parameter.location === "path") {
      args[parameter.inputName] = parameter.inputName === "course_id" ? COURSE_ID
        : parameter.inputName === "assignment_id" ? QUIZ_ID
        : String(80 + index);
      return;
    }
    if (parameter.location !== "form" || String(parameter.wireName).startsWith("quiz[quiz_settings]")) return;
    const value = sampleValue(parameter, index);
    args[parameter.inputName] = value;
    sent.push([String(parameter.wireName), value]);
  });
  return { args, sent };
}

/** The nested body those wire names and values describe. */
function expectedJsonBody(sent) {
  const body = {};
  for (const [wireName, value] of sent) {
    const path = wireName.match(/[^[\]]+/g);
    let current = body;
    for (const part of path.slice(0, -1)) {
      if (!current[part]) current[part] = {};
      current = current[part];
    }
    current[path[path.length - 1]] = value;
  }
  return body;
}

const CURRENT_SETTINGS = {
  shuffle_answers: false,
  shuffle_questions: false,
  has_time_limit: true,
  session_time_limit_in_seconds: 3600,
  result_view_settings: {
    result_view_restricted: true,
    display_items: true,
    display_item_response: true,
    display_item_correct_answer: false,
  },
  multiple_attempts: {
    multiple_attempts_enabled: true,
    max_attempts: 2,
  },
  filters: { ips: ["10.0.0.1"] },
};

const NEW_QUIZ = { id: QUIZ_ID, title: "Cell structures check", quiz_settings: CURRENT_SETTINGS };

function guard(quizSettings = CURRENT_SETTINGS) {
  return { morrow_new_quiz_settings_guard: { current_quiz_settings_sha256: settingsDigest(quizSettings) } };
}

test("every New Quizzes POST and PATCH sends a JSON body, and nothing else does", async () => {
  const newQuizWrites = CATALOG.operations.filter((operation) => operation.family === "new-quizzes"
    && ["POST", "PATCH"].includes(operation.method));
  assert.equal(newQuizWrites.length, 7, "the New Quizzes write surface changed");
  for (const entry of newQuizWrites) {
    const operation = catalogOperation(entry.toolName);
    assert.equal(newQuizUsesJsonBody(operation), true, entry.toolName);
    const { args, sent } = writeArguments(operation);
    // An in-place New Quiz item change reads the item first so that it can keep
    // every interaction id. connector/extension/src/new-quiz-item-guard.js holds
    // that rule and scripts/test/canvas-new-quiz-item-guard.test.mjs proves it,
    // so this sweep only has to answer that read.
    const quiz = entry.toolName === "canvas_update_quiz_item" ? { id: args.item_id, entry_type: "Item", entry: {} } : null;
    const { result, requests } = await sendCanvas(entry.toolName, args, { quiz });
    assert.equal(result.ok, true, `${entry.toolName}: ${JSON.stringify(result)}`);
    const writes = requests.filter((request) => request.method !== "GET");
    assert.equal(writes.length, 1, entry.toolName);
    assert.match(writes[0].contentType, /^application\/json/, entry.toolName);
    assert.deepEqual(JSON.parse(writes[0].body), expectedJsonBody(sent), entry.toolName);
  }
});

test("a Canvas REST write keeps its form encoding", async () => {
  const operation = catalogOperation("canvas_create_assignment_group");
  assert.equal(newQuizUsesJsonBody(operation), false);
  const { requests } = await sendCanvas("canvas_create_assignment_group", { course_id: COURSE_ID, name: "Weekly labs" });
  assert.equal(requests.length, 1);
  assert.match(requests[0].contentType, /^application\/x-www-form-urlencoded/);
  assert.equal(requests[0].body, "name=Weekly+labs");
});

test("a New Quiz settings change without its guard is refused before any request", async () => {
  const { result, requests } = await sendCanvas("canvas_update_single_quiz", {
    course_id: COURSE_ID,
    assignment_id: QUIZ_ID,
    quiz_quiz_settings_shuffle_answers: true,
  }, { quiz: NEW_QUIZ });
  assert.equal(result.ok, false);
  assert.equal(result.sent, false);
  assert.match(result.error, /^new_quiz_settings_guard_required: /);
  assert.deepEqual(requests, []);
});

test("a stale settings digest is refused after the read and before the change", async () => {
  const stale = { ...CURRENT_SETTINGS, shuffle_questions: true };
  const { result, requests } = await sendCanvas("canvas_update_single_quiz", {
    course_id: COURSE_ID,
    assignment_id: QUIZ_ID,
    quiz_quiz_settings_shuffle_answers: true,
    ...guard(stale),
  }, { quiz: NEW_QUIZ });
  assert.equal(result.ok, false);
  assert.equal(result.sent, false);
  assert.match(result.error, /^new_quiz_settings_stale: /);
  assert.deepEqual(requests, [{ method: "GET", pathname: QUIZ_PATH, contentType: null, body: null }]);
});

test("a quiz Morrow cannot read stops the settings change instead of warning about it", async () => {
  const { result, requests } = await sendCanvas("canvas_update_single_quiz", {
    course_id: COURSE_ID,
    assignment_id: QUIZ_ID,
    quiz_quiz_settings_shuffle_answers: true,
    ...guard(),
  }, { quiz: NEW_QUIZ, quizStatus: 500 });
  assert.equal(result.ok, false);
  assert.equal(result.sent, false);
  assert.match(result.error, /^new_quiz_settings_read_failed: /);
  assert.equal(requests.filter((request) => request.method !== "GET").length, 0);
});

test("a settings change sends the complete merged block and reports the exact preserved keys", async () => {
  const change = { shuffle_answers: true, result_view_settings: { display_item_correct_answer: true } };
  const merge = mergeQuizSettings(CURRENT_SETTINGS, change);
  const { result, requests } = await sendCanvas("canvas_update_single_quiz", {
    course_id: COURSE_ID,
    assignment_id: QUIZ_ID,
    quiz_quiz_settings_shuffle_answers: true,
    quiz_quiz_settings_result_view_settings_display_item_correct_answer: true,
    ...guard(),
  }, { quiz: NEW_QUIZ, savedQuiz: { ...NEW_QUIZ, quiz_settings: merge.merged } });
  assert.equal(result.ok, true);
  assert.equal(result.verification.status, "verified");
  assert.deepEqual(requests.map((request) => request.method), ["GET", "PATCH", "GET"]);
  const write = requests.find((request) => request.method === "PATCH");
  assert.ok(write, "the merged settings change was never sent");
  assert.match(write.contentType, /^application\/json/);
  const body = JSON.parse(write.body);

  // The in-page copy and connector/extension/src/new-quiz-write-contract.js
  // agree, and the body carries every current leaf plus the requested change.
  assert.deepEqual(body, { quiz: { quiz_settings: merge.merged } });
  assert.deepEqual(body.quiz.quiz_settings, {
    shuffle_answers: true,
    shuffle_questions: false,
    has_time_limit: true,
    session_time_limit_in_seconds: 3600,
    result_view_settings: {
      result_view_restricted: true,
      display_items: true,
      display_item_response: true,
      display_item_correct_answer: true,
    },
    multiple_attempts: { multiple_attempts_enabled: true, max_attempts: 2 },
    filters: { ips: ["10.0.0.1"] },
  });
  assert.deepEqual(result.newQuizSettingsPreserved, merge.preserved);
  assert.deepEqual(result.newQuizSettingsPreserved, [
    "filters.ips",
    "has_time_limit",
    "multiple_attempts.max_attempts",
    "multiple_attempts.multiple_attempts_enabled",
    "result_view_settings.display_item_response",
    "result_view_settings.display_items",
    "result_view_settings.result_view_restricted",
    "session_time_limit_in_seconds",
    "shuffle_questions",
  ]);
});

test("New Quiz writes preserve IP ranges, null resets and empty instructions", async () => {
  const requested = {
    filters: { ips: [["10.0.0.1", "10.0.0.20"], ["192.168.1.1", "192.168.1.5"]] },
    student_access_code: null,
    session_time_limit_in_seconds: null,
    multiple_attempts: { max_attempts: null, cooling_period_seconds: null },
  };
  for (const toolName of ["canvas_create_new_quiz", "canvas_update_single_quiz"]) {
    const update = toolName === "canvas_update_single_quiz";
    const { result, requests } = await sendCanvas(toolName, {
      course_id: COURSE_ID,
      ...(update ? { assignment_id: QUIZ_ID, ...guard() } : {}),
      quiz_instructions: "",
      quiz_quiz_settings_filters_ips: requested.filters.ips,
      quiz_quiz_settings_student_access_code: null,
      quiz_quiz_settings_session_time_limit_in_seconds: null,
      quiz_quiz_settings_multiple_attempts_max_attempts: null,
      quiz_quiz_settings_multiple_attempts_cooling_period_seconds: null,
    }, { quiz: NEW_QUIZ, savedQuiz: { ...NEW_QUIZ, quiz_settings: mergeQuizSettings(CURRENT_SETTINGS, requested).merged } });
    assert.equal(result.ok, true);
    if (update) assert.equal(result.verification.status, "verified");
    const write = requests.find((request) => request.method !== "GET");
    assert.ok(write);
    assert.deepEqual(JSON.parse(write.body), { quiz: {
      instructions: "",
      quiz_settings: update ? mergeQuizSettings(CURRENT_SETTINGS, requested).merged : requested,
    } });
  }

  const { result, requests } = await sendCanvas("canvas_update_single_quiz", {
    course_id: COURSE_ID, assignment_id: QUIZ_ID, quiz_quiz_settings_student_access_code: null,
  }, { quiz: NEW_QUIZ });
  assert.equal(result.sent, false);
  assert.match(result.error, /^new_quiz_settings_guard_required:/);
  assert.deepEqual(requests, []);
});

test("the settings check rejects changed protected settings and cannot confirm an unread saved quiz", async () => {
  const args = { course_id: COURSE_ID, assignment_id: QUIZ_ID, quiz_quiz_settings_shuffle_answers: true, ...guard() };
  const savedSettings = mergeQuizSettings(CURRENT_SETTINGS, { shuffle_answers: true }).merged;
  const wrongPreservedSetting = { ...savedSettings, shuffle_questions: true };
  for (const [savedQuiz, savedQuizStatus, status, reason] of [
    [{ ...NEW_QUIZ, quiz_settings: wrongPreservedSetting }, 200, "mismatch", "new_quiz_settings_readback_mismatch"],
    [{ ...NEW_QUIZ, course_id: "43", quiz_settings: savedSettings }, 200, "mismatch", "new_quiz_settings_readback_target_changed"],
    [{ ...NEW_QUIZ, quiz_settings: savedSettings }, 403, "unconfirmed", "new_quiz_settings_readback_unavailable"],
  ]) {
    const { result, requests } = await sendCanvas("canvas_update_single_quiz", args, { quiz: NEW_QUIZ, savedQuiz, savedQuizStatus });
    assert.equal(result.sent, true);
    assert.equal(result.verification.status, status);
    assert.equal(result.verification.reason, reason);
    assert.equal(requests.filter((request) => request.method === "PATCH").length, 1);
  }
  const { result, requests } = await sendCanvas("canvas_update_single_quiz", args, { quiz: { ...NEW_QUIZ, course_id: "43" } });
  assert.equal(result.sent, false);
  assert.match(result.error, /^new_quiz_settings_target_changed:/);
  assert.equal(requests.filter((request) => request.method === "PATCH").length, 0);
});

test("a title, instructions, date or points change needs no settings guard and reads no quiz", async () => {
  const { result, requests } = await sendCanvas("canvas_update_single_quiz", {
    course_id: COURSE_ID,
    assignment_id: QUIZ_ID,
    quiz_instructions: "<p>Answer every question.</p>",
    quiz_title: "Cell structures check",
    quiz_due_at: "2026-10-01T23:59:00Z",
    quiz_points_possible: 10,
  }, { quiz: NEW_QUIZ });
  assert.equal(result.ok, true);
  assert.equal(Object.hasOwn(result, "newQuizSettingsPreserved"), false);
  assert.deepEqual(requests.map((request) => request.method), ["PATCH"]);
  assert.deepEqual(JSON.parse(requests[0].body), {
    quiz: {
      due_at: "2026-10-01T23:59:00Z",
      instructions: "<p>Answer every question.</p>",
      points_possible: 10,
      title: "Cell structures check",
    },
  });
});

test("a settings guard is refused on a change that alters no setting", async () => {
  const { result, requests } = await sendCanvas("canvas_update_single_quiz", {
    course_id: COURSE_ID,
    assignment_id: QUIZ_ID,
    quiz_title: "Cell structures check",
    ...guard(),
  }, { quiz: NEW_QUIZ });
  assert.equal(result.ok, false);
  assert.equal(result.sent, false);
  assert.match(result.error, /^new_quiz_settings_guard_refused: /);
  assert.deepEqual(requests, []);
});

test("the merge keeps every leaf the caller did not name and reports what it kept", () => {
  const current = {
    shuffle_answers: false,
    result_view_settings: { display_items: true, display_item_feedback: false },
    multiple_attempts: { max_attempts: 2 },
    filters: { ips: ["10.0.0.1"] },
  };

  // A leaf inside one group changes; every other leaf, in that group and the others, is kept.
  const nested = mergeQuizSettings(current, { result_view_settings: { display_items: false } });
  assert.deepEqual(nested.merged, {
    shuffle_answers: false,
    result_view_settings: { display_items: false, display_item_feedback: false },
    multiple_attempts: { max_attempts: 2 },
    filters: { ips: ["10.0.0.1"] },
  });
  assert.deepEqual(nested.preserved, [
    "filters.ips",
    "multiple_attempts.max_attempts",
    "result_view_settings.display_item_feedback",
    "shuffle_answers",
  ]);

  // A caller that replaces a whole group replaces it: nothing inside it was kept.
  const replaced = mergeQuizSettings(current, { result_view_settings: null });
  assert.equal(replaced.merged.result_view_settings, null);
  assert.deepEqual(replaced.preserved, ["filters.ips", "multiple_attempts.max_attempts", "shuffle_answers"]);

  // A setting the current block does not carry is added, and preserves nothing.
  const added = mergeQuizSettings({ shuffle_answers: false }, { has_time_limit: true });
  assert.deepEqual(added.merged, { shuffle_answers: false, has_time_limit: true });
  assert.deepEqual(added.preserved, ["shuffle_answers"]);

  // No current settings at all: the request is the whole block and nothing is preserved.
  assert.deepEqual(mergeQuizSettings(null, { shuffle_answers: true }), { merged: { shuffle_answers: true }, preserved: [] });
});

test("the settings digest is taken over a stable encoding, so key order never makes a change look stale", () => {
  assert.equal(
    newQuizSettingsDigestSource({ b: 1, a: { d: [2, 3], c: true } }),
    newQuizSettingsDigestSource({ a: { c: true, d: [2, 3] }, b: 1 }),
  );
  assert.equal(newQuizSettingsDigestSource({ a: 1 }), '{"a":1}');
  assert.equal(newQuizSettingsDigestSource(null), "{}");
});
