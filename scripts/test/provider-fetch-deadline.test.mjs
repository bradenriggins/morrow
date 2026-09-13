import assert from "node:assert/strict";
import test from "node:test";

import { executeCanvasCourseSummaryInPage } from "../../connector/extension/src/canvas-course-summary-read.js";

test("a stalled Canvas read fetch settles at the operation deadline", async () => {
  const priorFetch = globalThis.fetch;
  const priorLocation = globalThis.location;
  const signals = [];
  globalThis.location = { origin: "https://canvas.example.test" };
  globalThis.fetch = (_url, options = {}) => {
    signals.push(options.signal);
    return new Promise((_, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true }));
  };

  let timeout;
  const startedAt = Date.now();
  try {
    const execution = executeCanvasCourseSummaryInPage(JSON.stringify({
      operation: {
        key: "canvas.api.v1.course.assignment.submissions.aggregate.read.v1",
        toolName: "canvas_get_assignment_submission_summary",
        provider: "canvas",
        readOnly: true,
      },
      arguments: { course_id: "42", assignment_id: "81" },
      binding: {
        origin: "https://canvas.example.test",
        siteUrl: "https://canvas.example.test/courses/42",
        principalId: "7",
        courseId: "42",
      },
      expiresAt: Date.now() + 40,
    }));
    const result = await Promise.race([
      execution,
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("read fetch remained pending")), 1_000); }),
    ]);

    assert.equal(result.ok, false);
    assert.equal(result.sent, false);
    assert.equal(signals.length, 1);
    assert.equal(signals[0] instanceof AbortSignal, true);
    assert.equal(signals[0].aborted, true);
    assert.ok(Date.now() - startedAt < 500);
  } finally {
    clearTimeout(timeout);
    globalThis.fetch = priorFetch;
    if (priorLocation === undefined) delete globalThis.location;
    else globalThis.location = priorLocation;
  }
});
