import assert from "node:assert/strict";
import test from "node:test";

import { executeCanvasCourseFileTextInPage } from "../../connector/extension/src/canvas-file-content.js";

const CANVAS = "https://canvas.example.test";

function response({ status = 200, url = CANVAS + "/", json = {} } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    url,
    async json() { return json; },
  };
}

function input(overrides = {}) {
  return {
    binding: { courseId: "10", principalId: "20", origin: CANVAS },
    fileId: "30",
    ...overrides,
  };
}

test("reads the selected course file's text metadata when everything lines up", async () => {
  const responses = [
    response({ json: { id: "20" } }),
    response({ json: { id: "10" } }),
    response({ json: { id: "30", size: 42, "content-type": "text/plain", updated_at: "2026-01-01T00:00:00Z" } }),
  ];
  const priorFetch = globalThis.fetch;
  const priorLocation = globalThis.location;
  globalThis.location = { origin: CANVAS };
  globalThis.fetch = async () => responses.shift();
  try {
    const result = await executeCanvasCourseFileTextInPage(input());
    assert.equal(result.ok, true);
    assert.equal(result.file.id, "30");
    assert.equal(result.file.size, 42);
  } finally {
    globalThis.fetch = priorFetch;
    globalThis.location = priorLocation;
  }
});

test("reports a fixed token instead of a raw transport error when a metadata read fails", async () => {
  const priorFetch = globalThis.fetch;
  const priorLocation = globalThis.location;
  globalThis.location = { origin: CANVAS };
  globalThis.fetch = async () => { throw new Error("storage connection lost"); };
  try {
    const result = await executeCanvasCourseFileTextInPage(input());
    assert.equal(result.ok, false);
    assert.equal(result.error, "canvas_file_text_execution_failed");
  } finally {
    globalThis.fetch = priorFetch;
    globalThis.location = priorLocation;
  }
});
