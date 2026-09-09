import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInThisContext } from "node:vm";
import { canvasOperationAdmission } from "../../connector/extension/generated/canvas-operation-admission.js";

const ORIGIN = "https://school.instructure.com";
const COURSE_ID = "42";
const QUIZ_ID = "77";
const USER_ID = "912345";
const SOURCE = readFileSync(new URL("../../connector/extension/src/canvas-content.js", import.meta.url), "utf8");
const CATALOG = JSON.parse(readFileSync(new URL("../../artifacts/canvas-api/canvas-api-catalog.json", import.meta.url), "utf8"));

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
const digest = (value) => createHash("sha256").update(stable(value)).digest("hex");
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

function operation(name) {
  const value = CATALOG.operations.find((entry) => entry.toolName === name);
  assert.ok(value, `missing ${name}`);
  return { ...value, morrowCourseTarget: canvasOperationAdmission(value).courseTarget };
}

async function send(name, args, response, { throwAfterSend = false } = {}) {
  const keys = ["location", "document", "fetch", "chrome", "__morrowCanvasConnectorInstalled"];
  const descriptors = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const listeners = [];
  const writes = [];
  try {
    Object.defineProperties(globalThis, {
      location: { configurable: true, value: { origin: ORIGIN, protocol: "https:", pathname: `/courses/${COURSE_ID}/quizzes` } },
      document: { configurable: true, value: { cookie: "_csrf_token=csrf-value" } },
      chrome: { configurable: true, value: { runtime: { onMessage: { addListener: (listener) => listeners.push(listener) } } } },
      fetch: { configurable: true, value: async (input, options = {}) => {
        const url = new URL(String(input?.href ?? input), ORIGIN);
        const method = options.method || "GET";
        if (url.pathname === "/api/v1/users/self/profile") return json({ id: "7", name: "Teacher" });
        if (url.pathname === `/api/v1/courses/${COURSE_ID}`) return json({ id: COURSE_ID, name: "Biology" });
        if (method === "POST") {
          writes.push({ url, options });
          if (throwAfterSend) throw new Error("response lost");
          return json(response);
        }
        return json({ error: "not found" }, 404);
      } },
      __morrowCanvasConnectorInstalled: { configurable: true, writable: true, value: undefined },
    });
    delete globalThis.__morrowCanvasConnectorInstalled;
    runInThisContext(SOURCE, { filename: "canvas-content.js" });
    const result = await new Promise((resolve, reject) => {
      const handled = listeners[0]({ type: "morrow_canvas_execute", operation: operation(name), arguments: args,
        principalId: "7", expiresAt: Date.now() + 60_000, courseId: COURSE_ID }, null, resolve);
      if (!handled) reject(new Error("content script refused command"));
    });
    return { result, writes };
  } finally {
    for (const key of keys) {
      const descriptor = descriptors.get(key);
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
}

test("course accommodation sends one exact JSON array and verifies its per-user success row", async () => {
  const payload = { user_id: USER_ID, extra_time: 0, apply_to_in_progress_quiz_sessions: false, reduce_choices_enabled: false };
  const { result, writes } = await send("canvas_set_course_level_accommodations", {
    course_id: COURSE_ID, ...payload,
    morrow_new_quiz_effect_guard: { kind: "accommodation", payload_sha256: digest(payload) },
  }, { successful: [{ user_id: USER_ID }], failed: [] });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.verification.status, "verified");
  assert.equal(writes.length, 1);
  assert.equal(writes[0].options.headers.get("Content-Type"), "application/json;charset=UTF-8");
  assert.equal(writes[0].options.body, JSON.stringify([payload]));
});

test("quiz accommodation sends one exact JSON array and preserves zero values", async () => {
  const payload = { user_id: USER_ID, extra_time: 0, extra_attempts: 0, reduce_choices_enabled: false };
  const { result, writes } = await send("canvas_set_quiz_level_accommodations", {
    course_id: COURSE_ID, assignment_id: QUIZ_ID, ...payload,
    morrow_new_quiz_effect_guard: { kind: "accommodation", payload_sha256: digest(payload) },
  }, { successful: [{ user_id: USER_ID }], failed: [] });
  assert.equal(result.verification.status, "verified");
  assert.equal(writes.length, 1);
  assert.equal(writes[0].options.body, JSON.stringify([payload]));
});

test("accommodation failure row is a mismatch and a lost response is never retried", async () => {
  const payload = { user_id: USER_ID, extra_time: 15 };
  const args = { course_id: COURSE_ID, assignment_id: QUIZ_ID, ...payload,
    morrow_new_quiz_effect_guard: { kind: "accommodation", payload_sha256: digest(payload) } };
  const failed = await send("canvas_set_quiz_level_accommodations", args, { successful: [], failed: [{ user_id: USER_ID, message: "refused" }] });
  assert.equal(failed.result.verification.status, "mismatch");
  assert.equal(failed.result.verification.reason, "new_quiz_accommodation_provider_failed");
  const unknown = await send("canvas_set_quiz_level_accommodations", args, null, { throwAfterSend: true });
  assert.equal(unknown.writes.length, 1);
  assert.deepEqual(unknown.result.verification, { schema: "morrow.browser-verification.v1", status: "unconfirmed",
    strategy: "new-quiz-accommodation-response", reason: "provider_has_no_accommodation_read_route" });
});

test("report accepts only an assignment-bound Progress receipt", async () => {
  const payload = { report_type: "item_analysis", format: "csv" };
  const args = { course_id: COURSE_ID, assignment_id: QUIZ_ID,
    quiz_report_report_type: payload.report_type, quiz_report_format: payload.format,
    morrow_new_quiz_effect_guard: { kind: "report", payload_sha256: digest(payload) } };
  const valid = await send("canvas_create_quiz_report_course_id_quizzes_assignment_id_reports_post", args, {
    id: "501", context_id: QUIZ_ID, context_type: "Assignment", workflow_state: "queued", url: "/api/v1/progress/501",
  });
  assert.equal(valid.result.verification.status, "verified");
  const wrong = await send("canvas_create_quiz_report_course_id_quizzes_assignment_id_reports_post", args, {
    id: "501", context_id: "78", context_type: "Assignment", workflow_state: "queued", url: "/api/v1/progress/501",
  });
  assert.equal(wrong.result.verification.status, "mismatch");
  const completed = await send("canvas_create_quiz_report_course_id_quizzes_assignment_id_reports_post", args, {
    id: "501", context_id: QUIZ_ID, context_type: "Assignment", workflow_state: "completed", url: "/api/v1/progress/501",
    results: { url: "/api/quiz/v1/reports/501.csv" },
  });
  assert.equal(completed.result.verification.status, "verified");
  const unknown = await send("canvas_create_quiz_report_course_id_quizzes_assignment_id_reports_post", args, null, { throwAfterSend: true });
  assert.equal(unknown.writes.length, 1);
  assert.equal(unknown.result.verification.reason, "progress_id_response_lost");
});
