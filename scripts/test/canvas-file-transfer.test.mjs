import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  MAX_CANVAS_FILE_TRANSFER_BYTES,
  canvasUploadFolderId,
  executeCanvasCourseFileTransferInPage,
} from "../../connector/extension/src/canvas-file-transfer.js";

const CANVAS = "https://canvas.example.test";
const STORAGE = "https://storage.example.test";
const bytes = new TextEncoder().encode("Selected canonical course material.");
const digest = createHash("sha256").update(bytes).digest("hex");

function response({ status = 200, url = CANVAS + "/", json = {}, text, headers = {}, body } = {}) {
  const headerValues = new Headers(headers);
  const streamBytes = body ?? new TextEncoder().encode(text ?? JSON.stringify(json));
  return {
    status,
    ok: status >= 200 && status < 300,
    url,
    headers: headerValues,
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(streamBytes);
        controller.close();
      },
    }),
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
    target: { kind: "file", uploadPath: "/api/v1/folders/81/files" },
    attachment: attachment(),
    expiresAt: Date.now() + 60_000,
    ...overrides,
  };
}

function liveResponse({ status, url, headers = {} }) {
  let cancelled = 0;
  const response = {
    status,
    ok: status >= 200 && status < 300,
    url,
    headers: new Headers(headers),
    body: { cancel() { cancelled += 1; return new Promise(() => {}); } },
  };
  return { response, cancellations: () => cancelled };
}

function fixtureResponses(overrides = {}) {
  return [
    response({ url: CANVAS + "/api/v1/users/self/profile", json: { id: "7" } }),
    response({ url: CANVAS + "/api/v1/courses/42", json: { id: "42" } }),
    response({
      url: CANVAS + "/api/v1/folders/81/files?search_term=course-material.txt&per_page=100&only%5B%5D=names",
      json: [],
    }),
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
    response({
      url: CANVAS + "/api/v1/files/501",
      json: {
        id: "501",
        folder_id: "81",
        display_name: "course-material.txt",
        filename: "course-material.txt",
        size: bytes.byteLength,
        "content-type": "text/plain",
        url: overrides.fileUrl === undefined ? CANVAS + "/files/501/download?verifier=opaque-verifier" : overrides.fileUrl,
      },
    }),
    response({
      url: overrides.downloadUrl || STORAGE + "/download/material",
      headers: { "content-length": String((overrides.downloadBytes || bytes).byteLength) },
      body: overrides.downloadBytes || bytes,
    }),
  ];
}

async function run(value = input(), responses = fixtureResponses()) {
  const priorFetch = globalThis.fetch;
  const priorLocation = globalThis.location;
  const priorDocument = globalThis.document;
  const requests = [];
  globalThis.location = { origin: CANVAS };
  globalThis.document = { cookie: "canvas_session=opaque; _csrf_token=page%2Btoken%3D" };
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
    globalThis.document = priorDocument;
  }
}

test("uploads only an existing private attachment and verifies saved Canvas bytes", async () => {
  const { result, requests } = await run();

  assert.equal(result.ok, true);
  assert.equal(result.sent, true);
  assert.equal(result.outcomeUnknown, false);
  assert.equal(result.data.file.id, "501");
  assert.equal(result.data.course_id, "42");
  assert.equal(result.data.folder_id, "81");
  assert.equal(result.data.sha256, digest);
  assert.deepEqual(result.verification.targets, [
    { type: "canvas_course", id: "42" },
    { type: "canvas_folder", id: "81" },
    { type: "canvas_file", id: "501" },
  ]);

  const search = new URL(requests[2].url);
  assert.equal(search.pathname, "/api/v1/folders/81/files");
  assert.equal(search.searchParams.get("search_term"), "course-material.txt");
  assert.equal(search.searchParams.get("per_page"), "100");
  assert.deepEqual(search.searchParams.getAll("only[]"), ["names"]);
  assert.equal(requests[2].options.credentials, "include");
  assert.equal(requests[3].url, CANVAS + "/api/v1/folders/81/files");
  assert.equal(requests[3].options.method, "POST");
  // Canvas refuses a signed-in change without the page's own request token.
  assert.equal(requests[3].options.headers["X-CSRF-Token"], "page+token=");
  assert.equal(new URLSearchParams(requests[3].options.body).get("on_duplicate"), "rename");
  assert.equal(requests[4].url, STORAGE + "/upload/signed");
  assert.equal(requests[4].options.credentials, "omit");
  assert.equal(requests[4].options.redirect, "manual");
  assert.equal(requests[4].options.body instanceof FormData, true);
  const parts = [...requests[4].options.body.entries()];
  assert.deepEqual(parts.slice(0, -1), [["key", "uploads/material"], ["policy", "opaque-policy"]]);
  assert.equal(parts.at(-1)[0], "file");
  assert.equal(parts.at(-1)[1] instanceof Blob, true);
  assert.equal(requests[8].url, CANVAS + "/api/v1/files/501");
  assert.equal(requests[9].url, CANVAS + "/files/501/download?verifier=opaque-verifier");
  // Canvas serves a course file to the signed-in person. Reading it back without
  // the session answers the sign-in page, which proves nothing about the file.
  assert.equal(requests[9].options.credentials, "include");
  assert.equal(requests[9].options.redirect, "follow");
});

test("a saved file Canvas names without a verifier is read back with the session", async () => {
  const { result, requests } = await run(input(), fixtureResponses({ fileUrl: CANVAS + "/files/501/download?download_frd=1" }));
  assert.equal(result.ok, true);
  assert.equal(result.verification.status, "verified");
  assert.equal(requests[9].url, CANVAS + "/files/501/download?download_frd=1");
  assert.equal(requests[9].options.credentials, "include");
});

test("a download route for another file or another site is refused", async () => {
  for (const url of [CANVAS + "/files/999/download", "https://elsewhere.example/files/501/download", CANVAS + "/files/501/download?verifier=a&verifier=b"]) {
    const { result } = await run(input(), fixtureResponses({ fileUrl: url }));
    assert.equal(result.ok, false, url);
    assert.equal(result.error, "canvas_file_download_url_refused", url);
  }
});

test("a saved file Canvas names no route for is read back on its own route", async () => {
  const { result, requests } = await run(input(), fixtureResponses({ fileUrl: "", downloadUrl: CANVAS + "/files/501/download" }));
  assert.equal(result.ok, true);
  assert.equal(result.verification.status, "verified");
  assert.equal(requests[9].url, CANVAS + "/files/501/download");
  assert.equal(requests[9].options.credentials, "include");
});

test("a saved file answered by the sign-in page is never taken for the file", async () => {
  const { result } = await run(input(), fixtureResponses({
    downloadUrl: CANVAS + "/login/canvas",
    downloadBytes: new TextEncoder().encode("<!doctype html><title>Log In to Canvas</title>"),
  }));
  assert.equal(result.ok, false);
  assert.equal(result.error, "canvas_file_download_session_required");
  assert.equal(result.outcomeUnknown, true);
});

test("an expired command starts no Canvas file-transfer request", async () => {
  const { result, requests } = await run(input({ expiresAt: Date.now() - 1 }), []);
  assert.equal(result.ok, false);
  assert.equal(result.sent, false);
  assert.equal(result.error, "canvas_file_transfer_timeout");
  assert.deepEqual(requests, []);
});

test("expiry during profile preflight prevents the next Canvas request", async () => {
  const priorFetch = globalThis.fetch;
  const priorLocation = globalThis.location;
  const requests = [];
  globalThis.location = { origin: CANVAS };
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    await new Promise((resolve) => setTimeout(resolve, 15));
    return response({ url: CANVAS + "/api/v1/users/self/profile", json: { id: "7" } });
  };
  try {
    const result = await executeCanvasCourseFileTransferInPage(input({ expiresAt: Date.now() + 5 }));
    assert.equal(result.ok, false);
    assert.equal(result.sent, false);
    assert.equal(result.error, "canvas_file_transfer_timeout");
    assert.deepEqual(requests, [CANVAS + "/api/v1/users/self/profile"]);
  } finally {
    globalThis.fetch = priorFetch;
    globalThis.location = priorLocation;
  }
});

test("non-OK Canvas, upload, and download bodies are canceled without awaiting cancellation", async () => {
  for (const scenario of ["canvas", "upload", "download"]) {
    const responses = fixtureResponses();
    const index = scenario === "canvas" ? 0 : scenario === "upload" ? 4 : 9;
    const url = scenario === "canvas"
      ? CANVAS + "/api/v1/users/self/profile"
      : scenario === "upload" ? STORAGE + "/upload/signed" : STORAGE + "/download/material";
    const live = liveResponse({ status: 503, url });
    responses[index] = live.response;
    const completed = await Promise.race([
      run(input(), responses),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`${scenario} cancellation was awaited`)), 250)),
    ]);
    assert.equal(completed.result.ok, false, scenario);
    assert.equal(completed.result.sent, scenario !== "canvas", scenario);
    assert.equal(live.cancellations(), 1, scenario);
  }
});

test("a redirect response body is canceled before its confirmation read", async () => {
  const responses = fixtureResponses();
  const live = liveResponse({ status: 302, url: STORAGE + "/upload/signed", headers: { location: "/api/v1/files/501" } });
  responses[4] = live.response;
  const { result } = await run(input(), responses);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(live.cancellations(), 1);
});

test("preserves canonical course and folder IDs above Number.MAX_SAFE_INTEGER", async () => {
  const courseId = "9007199254740993";
  const folderId = "9007199254740995";
  const responses = [
    response({ url: CANVAS + "/api/v1/users/self/profile", json: { id: "7" } }),
    response({ url: `${CANVAS}/api/v1/courses/${courseId}`, json: { id: courseId } }),
    response({
      url: `${CANVAS}/api/v1/folders/${folderId}/files?search_term=course-material.txt&per_page=100&only%5B%5D=names`,
      json: [],
    }),
    response({
      url: `${CANVAS}/api/v1/folders/${folderId}/files`,
      json: { upload_url: STORAGE + "/upload/signed", upload_params: { key: "uploads/material" } },
    }),
  ];

  const { result } = await run(input({
    mode: "initialize",
    binding: { origin: CANVAS, courseId, principalId: "7" },
    target: { kind: "file", uploadPath: `/api/v1/folders/${folderId}/files` },
  }), responses);

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.sent, false);
  assert.equal(result.data.course_id, courseId);
  assert.equal(result.data.folder_id, folderId);
  assert.equal(typeof result.data.course_id, "string");
  assert.equal(typeof result.data.folder_id, "string");
  assert.equal(result.data.upload_path, `/api/v1/folders/${folderId}/files`);
  assert.equal(canvasUploadFolderId(`/api/v1/folders/${folderId}/files`), folderId);
  assert.equal(canvasUploadFolderId("/api/v1/groups/9/files"), "");
});

test("refuses an existing exact Canvas filename before it initializes an upload", async () => {
  const responses = fixtureResponses();
  responses[2] = response({
    url: CANVAS + "/api/v1/folders/81/files?search_term=course-material.txt&per_page=100&only%5B%5D=names",
    json: [{ id: "400", display_name: "course-material.txt", filename: "course-material.txt" }],
  });
  const { result, requests } = await run(input(), responses);

  assert.deepEqual(result, {
    schema: "morrow.canvas-course-file-transfer.v1",
    ok: false,
    sent: false,
    outcomeUnknown: false,
    error: "canvas_file_name_already_exists",
  });
  assert.equal(requests.length, 3);
  assert.equal(requests.every((request) => request.options.method !== "POST"), true);
});

test("refuses incomplete Canvas filename search coverage before it initializes an upload", async () => {
  const responses = fixtureResponses();
  responses[2] = response({
    url: CANVAS + "/api/v1/folders/81/files?search_term=course-material.txt&per_page=100&only%5B%5D=names",
    headers: { link: '<https://canvas.example.test/api/v1/folders/81/files?page=2&per_page=100>; rel="next"' },
    json: [{ id: "400", display_name: "another-file.txt", filename: "another-file.txt" }],
  });
  const { result, requests } = await run(input(), responses);

  assert.deepEqual(result, {
    schema: "morrow.canvas-course-file-transfer.v1",
    ok: false,
    sent: false,
    outcomeUnknown: false,
    error: "canvas_file_name_check_incomplete",
  });
  assert.equal(requests.length, 3);
  assert.equal(requests.every((request) => request.options.method !== "POST"), true);
});

test("keeps a concurrent duplicate rename unconfirmed after the byte upload", async () => {
  const responses = fixtureResponses();
  responses[8] = response({
    url: CANVAS + "/api/v1/files/501",
    json: {
      id: "501",
      folder_id: "81",
      display_name: "course-material-1.txt",
      filename: "course-material-1.txt",
      size: bytes.byteLength,
      "content-type": "text/plain",
      url: CANVAS + "/files/501/download?verifier=opaque-verifier",
    },
  });
  const { result, requests } = await run(input(), responses);

  assert.equal(result.ok, false);
  assert.equal(result.sent, true);
  assert.equal(result.outcomeUnknown, true);
  assert.equal(result.error, "canvas_file_readback_mismatch");
  assert.equal(requests.length, 9);
});

test("refuses an upload address that is not a Canvas upload route before any request", async () => {
  for (const target of [
    { kind: "file", uploadPath: "/api/v1/courses/42/pages" },
    { kind: "file", uploadPath: "https://attacker.example.test/api/v1/folders/81/files" },
    { kind: "file", uploadPath: "/api/v1/folders/../files" },
    { kind: "rubric_csv", uploadPath: "/api/v1/folders/81/files" },
    { kind: "script", uploadPath: "/api/v1/folders/81/files" },
  ]) {
    const { result, requests } = await run(input({ target }), []);
    assert.equal(result.error, "canvas_file_binding_invalid", JSON.stringify(target));
    assert.equal(requests.length, 0);
  }
});

test("uploads to a group without a folder name check and accepts the copy Canvas renamed", async () => {
  const responses = [
    response({ url: CANVAS + "/api/v1/users/self/profile", json: { id: "7" } }),
    response({ url: CANVAS + "/api/v1/courses/42", json: { id: "42" } }),
    response({ url: CANVAS + "/api/v1/groups/9/files", json: { upload_url: STORAGE + "/upload/signed", upload_params: { key: "uploads/group" } } }),
    response({ status: 302, headers: { location: "/api/v1/files/601/create_success?uuid=opaque" } }),
    response({ url: CANVAS + "/api/v1/files/601/create_success?uuid=opaque", json: { id: "601" } }),
    response({ url: CANVAS + "/api/v1/users/self/profile", json: { id: "7" } }),
    response({ url: CANVAS + "/api/v1/courses/42", json: { id: "42" } }),
    response({ url: CANVAS + "/api/v1/files/601", json: {
      id: "601", folder_id: "900", display_name: "course-material-2.txt", filename: "course-material-2.txt",
      size: bytes.byteLength, "content-type": "text/plain", url: CANVAS + "/files/601/download?verifier=group-verifier",
    } }),
    response({ url: STORAGE + "/download/group", headers: { "content-length": String(bytes.byteLength) }, body: bytes }),
  ];
  const { result, requests } = await run(input({ target: { kind: "file", uploadPath: "/api/v1/groups/9/files" } }), responses);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.data.upload_path, "/api/v1/groups/9/files");
  assert.equal(result.data.folder_id, undefined);
  assert.equal(result.data.file.display_name, "course-material-2.txt");
  assert.deepEqual(result.verification.targets, [{ type: "canvas_course", id: "42" }, { type: "canvas_file", id: "601" }]);
  assert.equal(requests[2].url, CANVAS + "/api/v1/groups/9/files");
  assert.equal(requests.some((request) => request.url.includes("search_term")), false);
});

test("imports a rubric CSV once and verifies only an import Canvas finished without errors", async () => {
  const importInput = input({
    mode: "rubric",
    target: { kind: "rubric_csv", uploadPath: "/api/v1/courses/42/rubrics/upload" },
    attachment: attachment({ manifest: { filename: "rubrics.csv", size_bytes: bytes.byteLength, sha256: digest }, content_type: "text/csv" }),
  });
  const preflight = () => [
    response({ url: CANVAS + "/api/v1/users/self/profile", json: { id: "7" } }),
    response({ url: CANVAS + "/api/v1/courses/42", json: { id: "42" } }),
  ];
  const { result, requests } = await run(importInput, [
    ...preflight(),
    response({ url: CANVAS + "/api/v1/courses/42/rubrics/upload", json: { id: "77", workflow_state: "importing" } }),
    response({ url: CANVAS + "/api/v1/courses/42/rubrics/upload/77", json: { id: "77", workflow_state: "succeeded", error_count: 0 } }),
  ]);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.verification.status, "verified");
  assert.deepEqual(result.data.rubric_import, { id: "77", workflow_state: "succeeded" });
  assert.equal(requests[2].options.method, "POST");
  assert.equal(requests[2].options.headers["X-CSRF-Token"], "page+token=");
  const form = requests[2].options.body;
  assert.equal(form instanceof FormData, true);
  assert.equal([...form.keys()].join(), "attachment");

  const failed = await run(importInput, [
    ...preflight(),
    response({ url: CANVAS + "/api/v1/courses/42/rubrics/upload", json: { id: "78", workflow_state: "succeeded_with_errors", error_count: 2 } }),
  ]);
  assert.equal(failed.result.ok, false);
  assert.equal(failed.result.sent, true);
  assert.equal(failed.result.verification.status, "mismatch");
  assert.equal(failed.result.error, "canvas_rubric_import_succeeded_with_errors");
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
  const priorDocument = globalThis.document;
  const requests = [];
  globalThis.location = { origin: CANVAS };
  globalThis.document = { cookie: "_csrf_token=page%2Btoken%3D" };
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
    assert.equal(result.error, "canvas_file_transfer_execution_failed");
    assert.equal(requests.length, 5);
  } finally {
    globalThis.fetch = priorFetch;
    globalThis.location = priorLocation;
    globalThis.document = priorDocument;
  }
});

test("cancels an oversized upload confirmation and keeps the dispatched write unknown", async () => {
  let cancelled = 0;
  const responses = fixtureResponses();
  responses[4] = {
    status: 200,
    ok: true,
    url: CANVAS + "/api/v1/files/501",
    headers: new Headers(),
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(2 * 1024 * 1024));
        controller.enqueue(new Uint8Array(1));
      },
      cancel() { cancelled += 1; },
    }),
  };
  const { result } = await run(input(), responses);
  assert.equal(result.ok, false);
  assert.equal(result.sent, true);
  assert.equal(result.outcomeUnknown, true);
  assert.equal(result.error, "canvas_file_transfer_response_too_large");
  assert.equal(cancelled, 1);
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
  assert.equal(requests.length, 10);
});

test("stops an undeclared oversized download while it is streaming", async () => {
  const responses = fixtureResponses();
  responses[9] = response({
    url: STORAGE + "/download/material",
    body: new Uint8Array(MAX_CANVAS_FILE_TRANSFER_BYTES + 1),
  });
  const { result, requests } = await run(input(), responses);

  assert.equal(result.ok, false);
  assert.equal(result.sent, true);
  assert.equal(result.outcomeUnknown, true);
  assert.equal(result.error, "canvas_file_download_too_large");
  assert.equal(requests.length, 10);
});
