import assert from "node:assert/strict";
import { test } from "node:test";
import { canCompleteCourseConnectionIntent, normalizeCourseConnectionUrl, validCourseConnectionIntent } from "../../connector/extension/src/course-connection-intent.js";

const now = 1_800_000_000_000;
const intent = Object.freeze({
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", tabId: 41,
  url: "https://canvas.example.edu/courses/42?view=teacher",
  origins: ["https://canvas.example.edu/*"], preGrantedOrigins: [], createdAt: now,
});
const completion = (value = {}) => canCompleteCourseConnectionIntent(intent, {
  intentId: intent.id, tabId: 41, url: "https://canvas.example.edu/courses/42?view=teacher#editor",
  permissionOrigins: intent.origins, addedOrigins: intent.origins, now, ...value,
});

test("connection intent freezes full target URL while ignoring its fragment", () => {
  assert.equal(normalizeCourseConnectionUrl("https://moodle.example.edu/lms/course/view.php?id=9#top"), "https://moodle.example.edu/lms/course/view.php?id=9");
  assert.equal(completion(), true);
  assert.equal(completion({ url: "https://canvas.example.edu/courses/43?view=teacher" }), false);
  assert.equal(completion({ url: "https://canvas.example.edu/courses/42?view=student" }), false);
  assert.equal(completion({ url: "https://moodle.example.edu/lms/course/view.php?id=9" }), false);
  assert.equal(completion({ url: "https://moodle.example.edu/course/view.php?id=9" }), false);
});

test("onAdded only completes the exact permission request, preserving intent on unrelated grants", () => {
  assert.equal(completion({ addedOrigins: ["https://*/*"] }), false);
  assert.equal(completion({ addedOrigins: ["https://other.example.edu/*"] }), false);
  assert.equal(completion({ permissionOrigins: ["https://other.example.edu/*"] }), false);
  assert.equal(completion({ intentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }), false);
  assert.equal(completion({ now: now + 60_001 }), false);
  assert.equal(completion({ popupConfirmed: true, addedOrigins: undefined }), true);
  const partlyGranted = { ...intent, preGrantedOrigins: intent.origins };
  assert.equal(canCompleteCourseConnectionIntent(partlyGranted, { intentId: intent.id, tabId: 41, url: intent.url, permissionOrigins: intent.origins, addedOrigins: ["https://other.example.edu/*"], now }), true);
});

test("a connection intent cannot be created in the future", () => {
  assert.equal(validCourseConnectionIntent(intent, now), true);
  assert.equal(validCourseConnectionIntent({ ...intent, createdAt: now + 1 }, now), false);
  assert.equal(validCourseConnectionIntent({ ...intent, createdAt: now + 60_000 }, now), false);
});
