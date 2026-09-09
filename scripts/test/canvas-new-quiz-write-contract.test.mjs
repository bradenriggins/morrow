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
 * settings guard makes; `quizStatus` makes that read fail. `writeError` models
 * a lost response, and `writeStatus` models an uncertain HTTP result.
 */
async function sendCanvas(toolName, args, {
  quiz = null,
  quizStatus = 200,
  savedQuiz = quiz,
  savedQuizStatus = 200,
  writeError = null,
  writeStatus = 200,
  // Path-keyed reads, for a create whose list read and created-quiz read are different routes.
  routes = null,
  writeData = { id: QUIZ_ID },
} = {}) {
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
      const afterWrite = requests.slice(0, -1).some((request) => request.method !== "GET");
      if (method === "GET") {
        if (routes) {
          const answer = routes[url.pathname];
          if (answer === undefined) return jsonResponse({ errors: [{ message: "no route" }] }, 404);
          return jsonResponse(typeof answer === "function" ? answer(afterWrite) : answer);
        }
        const status = afterWrite ? savedQuizStatus : quizStatus;
        return status === 200 ? jsonResponse(afterWrite ? savedQuiz : quiz) : jsonResponse({ errors: [{ message: "no" }] }, status);
      }
      if (writeError) throw writeError;
      return jsonResponse(writeStatus === 200 ? writeData : { errors: [{ message: "uncertain" }] }, writeStatus);
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

/** The one encoding every Morrow digest is taken over. Copied from connector/extension/src/edit-policy.js. */
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  return JSON.stringify(value === undefined ? null : value);
}

function digest(value) {
  return createHash("sha256").update(stable(value)).digest("hex");
}

/**
 * The guard `morrow_plan_new_quiz_create` produces: the complete current course
 * quiz list and the reviewed payload. A create without it sends nothing.
 */
function lifecycleGuard(beforeQuizIds, payload) {
  return {
    morrow_new_quiz_lifecycle_guard: {
      kind: "create",
      before_quiz_ids: beforeQuizIds,
      before_quiz_ids_sha256: digest(beforeQuizIds.map(String)),
      payload_sha256: digest(payload),
    },
  };
}

test("every New Quizzes POST and PATCH uses JSON, and direct execution covers only routes without a specialized planner", async () => {
  const newQuizWrites = CATALOG.operations.filter((operation) => operation.family === "new-quizzes"
    && ["POST", "PATCH"].includes(operation.method));
  assert.equal(newQuizWrites.length, 7, "the New Quizzes write surface changed");
  for (const entry of newQuizWrites) {
    const operation = catalogOperation(entry.toolName);
    assert.equal(newQuizUsesJsonBody(operation), true, entry.toolName);
    if (entry.toolName !== "canvas_update_single_quiz") continue;
    const { args, sent } = writeArguments(operation);
    if (entry.toolName === "canvas_update_quiz_item") {
      delete args.item_position;
      const positionIndex = sent.findIndex(([wireName]) => wireName === "item[position]");
      if (positionIndex >= 0) sent.splice(positionIndex, 1);
    }
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
  const settingsArguments = {
    quiz_instructions: "",
    quiz_quiz_settings_filters_ips: requested.filters.ips,
    quiz_quiz_settings_student_access_code: null,
    quiz_quiz_settings_session_time_limit_in_seconds: null,
    quiz_quiz_settings_multiple_attempts_max_attempts: null,
    quiz_quiz_settings_multiple_attempts_cooling_period_seconds: null,
  };

  // An update merges the reviewed change into the complete saved block.
  const { result: updated, requests: updateRequests } = await sendCanvas("canvas_update_single_quiz", {
    course_id: COURSE_ID, assignment_id: QUIZ_ID, ...guard(), ...settingsArguments,
  }, { quiz: NEW_QUIZ, savedQuiz: { ...NEW_QUIZ, quiz_settings: mergeQuizSettings(CURRENT_SETTINGS, requested).merged } });
  assert.equal(updated.ok, true, JSON.stringify(updated));
  assert.equal(updated.verification.status, "verified");
  const update = updateRequests.find((request) => request.method !== "GET");
  assert.ok(update);
  assert.deepEqual(JSON.parse(update.body), {
    quiz: { instructions: "", quiz_settings: mergeQuizSettings(CURRENT_SETTINGS, requested).merged },
  });

  // A create has no saved block to merge into, so it sends exactly the reviewed payload. The
  // lifecycle guard carries the complete current course quiz list and that payload's digest.
  const CREATED_ID = "90";
  const listPath = `/api/quiz/v1/courses/${COURSE_ID}/quizzes`;
  const createPayload = { instructions: "", quiz_settings: requested };
  const createdQuiz = { id: CREATED_ID, ...createPayload };
  const createArguments = { course_id: COURSE_ID, ...settingsArguments };
  const createRoutes = {
    [listPath]: (afterWrite) => afterWrite ? [{ id: QUIZ_ID }, { id: CREATED_ID }] : [{ id: QUIZ_ID }],
    [`${listPath}/${CREATED_ID}`]: createdQuiz,
  };
  const { result: created, requests: createRequests } = await sendCanvas("canvas_create_new_quiz", {
    ...createArguments, ...lifecycleGuard([QUIZ_ID], createPayload),
  }, { routes: createRoutes, writeData: createdQuiz });
  assert.equal(created.ok, true, JSON.stringify(created));
  assert.equal(created.verification.status, "verified");
  assert.equal(created.verification.evidence, "complete_course_quiz_list_and_created_quiz_reread");
  const create = createRequests.find((request) => request.method === "POST");
  assert.ok(create);
  assert.deepEqual(JSON.parse(create.body), { quiz: createPayload });
  assert.equal(createRequests.filter((request) => request.method !== "GET").length, 1);

  // A create with no reviewed complete quiz list sends nothing.
  const bare = await sendCanvas("canvas_create_new_quiz", createArguments, { routes: createRoutes });
  assert.equal(bare.result.ok, false);
  assert.equal(bare.result.sent, false);
  assert.match(bare.result.error, /^new_quiz_lifecycle_guard_required:/);
  assert.deepEqual(bare.requests, []);

  // A create whose reviewed payload no longer matches its arguments sends nothing.
  const drifted = await sendCanvas("canvas_create_new_quiz", {
    ...createArguments, ...lifecycleGuard([QUIZ_ID], { ...createPayload, instructions: "Read first." }),
  }, { routes: createRoutes });
  assert.equal(drifted.result.sent, false);
  assert.match(drifted.result.error, /^new_quiz_lifecycle_guard_invalid:/);
  assert.deepEqual(drifted.requests.filter((request) => request.method !== "GET"), []);

  // A create whose course quiz list moved after review sends nothing.
  const stale = await sendCanvas("canvas_create_new_quiz", {
    ...createArguments, ...lifecycleGuard([QUIZ_ID, "78"], createPayload),
  }, { routes: createRoutes });
  assert.equal(stale.result.sent, false);
  assert.match(stale.result.error, /^new_quiz_lifecycle_stale:/);
  assert.deepEqual(stale.requests.filter((request) => request.method !== "GET"), []);

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

test("an uncertain settings response is recovered only by an exact complete-settings reread", async () => {
  const args = { course_id: COURSE_ID, assignment_id: QUIZ_ID, quiz_quiz_settings_shuffle_answers: true, ...guard() };
  const merged = mergeQuizSettings(CURRENT_SETTINGS, { shuffle_answers: true });
  const exact = { ...NEW_QUIZ, quiz_settings: merged.merged };
  const mismatch = { ...NEW_QUIZ, quiz_settings: { ...merged.merged, shuffle_questions: true } };
  const uncertainWrites = [
    { name: "network exception", writeError: new TypeError("response lost"), expectedStatus: 0 },
    { name: "HTTP 408", writeStatus: 408, expectedStatus: 408 },
    { name: "HTTP 429", writeStatus: 429, expectedStatus: 429 },
    { name: "HTTP 500", writeStatus: 500, expectedStatus: 500 },
    { name: "HTTP 503", writeStatus: 503, expectedStatus: 503 },
  ];
  const readbacks = [
    { name: "exact match", savedQuiz: exact, expectedOk: true, expectedStatus: "verified", expectedReason: undefined },
    { name: "no effect", savedQuiz: NEW_QUIZ, expectedOk: false, expectedStatus: "mismatch", expectedReason: "new_quiz_settings_readback_no_effect" },
    { name: "mismatch", savedQuiz: mismatch, expectedOk: false, expectedStatus: "mismatch", expectedReason: "new_quiz_settings_readback_mismatch" },
    { name: "unreadable", savedQuiz: exact, savedQuizStatus: 403, expectedOk: false, expectedStatus: "unconfirmed", expectedReason: "new_quiz_settings_readback_unavailable" },
  ];

  for (const uncertainWrite of uncertainWrites) {
    for (const readback of readbacks) {
      const { result, requests } = await sendCanvas("canvas_update_single_quiz", args, {
        quiz: NEW_QUIZ,
        ...uncertainWrite,
        ...readback,
      });
      assert.equal(result.ok, readback.expectedOk, `${uncertainWrite.name}: ${readback.name}`);
      assert.equal(result.sent, true, `${uncertainWrite.name}: ${readback.name}`);
      assert.equal(result.outcomeUnknown, !readback.expectedOk, `${uncertainWrite.name}: ${readback.name}`);
      assert.equal(result.recovered, readback.expectedOk ? true : undefined, `${uncertainWrite.name}: ${readback.name}`);
      assert.equal(
        result.status,
        uncertainWrite.writeError && !readback.expectedOk ? undefined : uncertainWrite.expectedStatus,
        `${uncertainWrite.name}: ${readback.name}`,
      );
      assert.equal(result.verification.status, readback.expectedStatus, `${uncertainWrite.name}: ${readback.name}`);
      assert.equal(result.verification.reason, readback.expectedReason, `${uncertainWrite.name}: ${readback.name}`);
      assert.deepEqual(result.newQuizSettingsPreserved, merged.preserved, `${uncertainWrite.name}: ${readback.name}`);
      assert.deepEqual(requests.map((request) => request.method), ["GET", "PATCH", "GET"], `${uncertainWrite.name}: ${readback.name}`);
      assert.equal(requests.filter((request) => request.method === "PATCH").length, 1, `${uncertainWrite.name}: ${readback.name}`);
    }
  }
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

// The three values a New Quizzes write is easiest to get wrong, each pinned on
// its own. They are one test above, bundled with everything else a settings
// change does; these separate them so a failure names which of the three broke.
//
// Absent, null and empty are three different instructions to Canvas. Absent
// means "leave this alone". Null means "clear it". Empty means "this is now
// empty". A writer that folds any two of them together either discards an edit
// a person made or leaves a setting switched on after they cleared it, and the
// person is told the opposite of what Canvas holds.

test("an IP filter a settings change does not name survives that change", async () => {
  // The reviewed change turns shuffling on and says nothing about filters.
  const { result, requests } = await sendCanvas("canvas_update_single_quiz", {
    course_id: COURSE_ID,
    assignment_id: QUIZ_ID,
    quiz_quiz_settings_shuffle_answers: true,
    ...guard(),
  }, {
    quiz: NEW_QUIZ,
    savedQuiz: { ...NEW_QUIZ, quiz_settings: mergeQuizSettings(CURRENT_SETTINGS, { shuffle_answers: true }).merged },
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  const write = requests.find((request) => request.method === "PATCH");
  assert.ok(write, "the settings change was never sent");
  const sent = JSON.parse(write.body).quiz.quiz_settings;
  assert.deepEqual(sent.filters, { ips: ["10.0.0.1"] }, "the stored IP filter was dropped");
  assert.equal(sent.shuffle_answers, true);
  assert.ok(result.newQuizSettingsPreserved.includes("filters.ips"), "the kept IP filter was not reported");
});

test("a cleared setting reaches Canvas as null, and is never dropped as if it were absent", async () => {
  const requested = { student_access_code: null, session_time_limit_in_seconds: null };
  const { result, requests } = await sendCanvas("canvas_update_single_quiz", {
    course_id: COURSE_ID,
    assignment_id: QUIZ_ID,
    quiz_quiz_settings_student_access_code: null,
    quiz_quiz_settings_session_time_limit_in_seconds: null,
    ...guard(),
  }, {
    quiz: NEW_QUIZ,
    savedQuiz: { ...NEW_QUIZ, quiz_settings: mergeQuizSettings(CURRENT_SETTINGS, requested).merged },
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  const write = requests.find((request) => request.method === "PATCH");
  assert.ok(write, "the reset was never sent");
  const sent = JSON.parse(write.body).quiz.quiz_settings;
  // Present and null, not missing: Canvas is told to clear both.
  assert.ok(Object.hasOwn(sent, "student_access_code"), "the access code reset was dropped");
  assert.equal(sent.student_access_code, null);
  assert.ok(Object.hasOwn(sent, "session_time_limit_in_seconds"), "the time limit reset was dropped");
  assert.equal(sent.session_time_limit_in_seconds, null);
  // A cleared value is a change, so it is never reported as a value Morrow kept.
  assert.equal(result.newQuizSettingsPreserved.includes("session_time_limit_in_seconds"), false);
});

test("empty instructions are sent as empty, and are never treated as absent", async () => {
  const { result, requests } = await sendCanvas("canvas_update_single_quiz", {
    course_id: COURSE_ID,
    assignment_id: QUIZ_ID,
    quiz_instructions: "",
  }, { quiz: NEW_QUIZ, savedQuiz: NEW_QUIZ });
  assert.equal(result.ok, true, JSON.stringify(result));
  const write = requests.find((request) => request.method === "PATCH");
  assert.ok(write, "the emptied instructions were never sent");
  const sent = JSON.parse(write.body).quiz;
  assert.ok(Object.hasOwn(sent, "instructions"), "the emptied instructions were dropped");
  assert.equal(sent.instructions, "");
});

test("a Canvas REST write still drops an empty value, so only New Quizzes keeps one", async () => {
  // The same empty value on a Canvas REST route is absent, which is what that
  // API means by it. Only the /quiz/v1/ JSON routes preserve null and empty.
  const restOperation = catalogOperation("canvas_edit_assignment");
  const empty = restOperation.parameters.find((parameter) => parameter.inputName === "assignment_name");
  assert.ok(empty, "canvas_edit_assignment no longer carries assignment_name");
  assert.equal(newQuizUsesJsonBody(restOperation), false);
});
