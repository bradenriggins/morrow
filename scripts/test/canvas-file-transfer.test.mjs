import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  MAX_CANVAS_FILE_TRANSFER_BYTES,
  executeCanvasCourseFileTransferInPage,
} from "../../connector/extension/src/canvas-file-transfer.js";

const CANVAS = "https://canvas.example.test";
const STORAGE = "https://storage.example.test";
const bytes = new TextEncoder().encode("Selected canonical course material.");
const digest = createHash("sha256").update(bytes).digest("hex");

function response({ status = 200, url = CANVAS + "/", json = {}, text = "", headers = {}, body = bytes } = {}) {
  const headerValues = new Headers(headers);
  return {
    status,
    ok: status >= 200 && status < 300,
    url,
    headers: headerValues,
    async json() { return json; },
    async text() { return text; },
    async arrayBuffer() { return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength); },
  };
}

function attachment(overrides = {}) {
  return {
    schema: "morrow.private-file-attachment.v1",
    handle: "file:canvas-course-material-1",
    manifest: { filename: "course-material.txt", size_bytes: bytes.byteLength, sha256: digest },
    bytes_base64: Buffer.from(bytes).toString("base64"),
    content_type: "text/plain",
    ...overrides,
  };
}

function input(overrides = {}) {
  return {
    binding: { origin: CANVAS, courseId: "42", principalId: "7" },
    folderId: "81",
    attachment: attachment(),
    ...overrides,
  };
}

function fixtureResponses(overrides = {}) {
  return [
    response({ url: CANVAS + "/api/v1/users/self/profile", json: { id: "7" } }),
    response({ url: CANVAS + "/api/v1/courses/42", json: { id: "42" } }),
    response({ url: CANVAS + "/api/v1/courses/42/folders/81", json: { id: "81" } }),
    response({
      url: CANVAS + "/api/v1/folders/81/files",
      json: {
        upload_url: STORAGE + "/upload/signed",
        upload_params: { key: "uploads/material", policy: "opaque-policy" },
      },
    }),
    response({ status: 302, headers: { location: "/api/v1/files/501" } }),
    response({ url: CANVAS + "/api/v1/files/501", json: { id: "501" } }),
    response({ url: CANVAS + "/api/v1/users/self/profile", json: { id: "7" } }),
    response({ url: CANVAS + "/api/v1/courses/42", json: { id: "42" } }),
    response({ url: CANVAS + "/api/v1/courses/42/folders/81", json: { id: "81" } }),
    response({
      url: CANVAS + "/api/v1/courses/42/files/501",
      json: {
        id: "501",
        folder_id: "81",
        display_name: "course-material.txt",
        filename: "course-material.txt",
        size: bytes.byteLength,
        "content-type": "text/plain",
        url: CANVAS + "/files/501/download?verifier=opaque-verifier",
      },
    }),
    response({
      url: STORAGE + "/download/material",
      headers: { "content-length": String(bytes.byteLength) },
      body: overrides.downloadBytes || bytes,
    }),
  ];
}

async function run(value = input(), responses = fixtureResponses()) {
  const priorFetch = globalThis.fetch;
  const priorLocation = globalThis.location;
  const requests = [];
  globalThis.location = { origin: CANVAS };
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    const next = responses.shift();
    assert.ok(next, "unexpected request");
    return next;
  };
  try {
    return { result: await executeCanvasCourseFileTransferInPage(value), requests };
  } finally {
    globalThis.fetch = priorFetch;
    globalThis.location = priorLocation;
  }
}

test("uploads only an existing private attachment and verifies saved Canvas bytes", async () => {
  const { result, requests } = await run();

  assert.equal(result.ok, true);
  assert.equal(result.sent, true);
  assert.equal(result.outcomeUnknown, false);
  assert.equal(result.data.file.id, "501");
  assert.equal(result.data.folder_id, 81);
  assert.equal(result.data.sha256, digest);
  assert.deepEqual(result.verification.targets, [
    { type: "canvas_course", id: "42" },
    { type: "canvas_folder", id: "81" },
    { type: "canvas_file", id: "501" },
  ]);

  assert.equal(requests[3].url, CANVAS + "/api/v1/folders/81/files");
  assert.equal(requests[3].options.credentials, "include");
  assert.equal(requests[4].url, STORAGE + "/upload/signed");
  assert.equal(requests[4].options.credentials, "omit");
  assert.equal(requests[4].options.redirect, "manual");
  assert.equal(requests[4].options.body instanceof FormData, true);
  const parts = [...requests[4].options.body.entries()];
  assert.deepEqual(parts.slice(0, -1), [["key", "uploads/material"], ["policy", "opaque-policy"]]);
  assert.equal(parts.at(-1)[0], "file");
  assert.equal(parts.at(-1)[1] instanceof Blob, true);
  assert.equal(requests[10].url, CANVAS + "/files/501/download?verifier=opaque-verifier");
  assert.equal(requests[10].options.credentials, "omit");
  assert.equal(requests[10].options.redirect, "follow");
});

test("refuses a folder that is not freshly scoped to the selected course before it initializes an upload", async () => {
  const responses = fixtureResponses();
  responses[2] = response({ url: CANVAS + "/api/v1/courses/42/folders/81", json: { id: "99" } });
  const { result, requests } = await run(input({ upload_url: STORAGE + "/caller-supplied" }), responses);

  assert.deepEqual(result, {
    schema: "morrow.canvas-course-file-transfer.v1",
    ok: false,
    sent: false,
    outcomeUnknown: false,
    error: "canvas_file_folder_changed",
  });
  assert.equal(requests.length, 3);
});

test("does not accept invalid, oversized, or changed private attachment bytes", async () => {
  const oversized = attachment({
    manifest: { filename: "course-material.txt", size_bytes: MAX_CANVAS_FILE_TRANSFER_BYTES + 1, sha256: digest },
  });
  const { result, requests } = await run(input({ attachment: oversized }), []);

  assert.equal(result.ok, false);
  assert.equal(result.sent, false);
  assert.equal(result.error, "canvas_file_attachment_invalid");
  assert.equal(requests.length, 0);
});

test("marks the effect unknown after a dispatched byte upload loses contact", async () => {
  const responses = fixtureResponses();
  responses[4] = new Error("storage connection lost");
  const priorFetch = globalThis.fetch;
  const priorLocation = globalThis.location;
  const requests = [];
  globalThis.location = { origin: CANVAS };
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  try {
    const result = await executeCanvasCourseFileTransferInPage(input());
    assert.equal(result.ok, false);
    assert.equal(result.sent, true);
    assert.equal(result.outcomeUnknown, true);
    assert.equal(result.error, "storage connection lost");
    assert.equal(requests.length, 5);
  } finally {
    globalThis.fetch = priorFetch;
    globalThis.location = priorLocation;
  }
});

test("marks the effect unknown when the storage response redirects outside the selected Canvas origin", async () => {
  const responses = fixtureResponses();
  responses[4] = response({ status: 302, headers: { location: "https://attacker.example.test/confirm" } });
  const { result, requests } = await run(input(), responses);

  assert.equal(result.ok, false);
  assert.equal(result.sent, true);
  assert.equal(result.outcomeUnknown, true);
  assert.equal(result.error, "canvas_file_upload_confirmation_refused");
  assert.equal(requests.length, 5);
});

test("marks the effect unknown when readback bytes do not match the staged SHA-256", async () => {
  const { result, requests } = await run(input(), fixtureResponses({ downloadBytes: new TextEncoder().encode("changed") }));

  assert.equal(result.ok, false);
  assert.equal(result.sent, true);
  assert.equal(result.outcomeUnknown, true);
  assert.equal(result.error, "canvas_file_download_digest_mismatch");
  assert.equal(requests.length, 11);
});
