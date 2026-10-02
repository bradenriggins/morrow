import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInThisContext } from "node:vm";
import { canvasReviewedUploadKind, canvasReviewedUploadPath } from "../../connector/extension/generated/canvas-operation-admission.js";

// The Bridge worker carries the saved-file read itself for a folder upload: the
// page prepares and completes the upload, and the worker reads the bytes back.
// That read is what proves the upload, so it executes here rather than being
// described.
const WORKER_SOURCE = readFileSync(new URL("../../connector/extension/src/service-worker.js", import.meta.url), "utf8");

const COURSE_ID = "89585";
const ORIGIN = "https://school.instructure.com";
const FOLDER_ID = "1564337";
const FILE_ID = "14113694";
const BYTES = new TextEncoder().encode("Morrow reviewed transfer proof\n");
const SHA256 = "5c1f4b57f4c8be7e0c3e2c2d8b91a45be6b1cbb5e3c3adcd0a3a4b4f1a8ea6ce";

function region({ siteTarget = false, courseAccessMode = "selected", resolveResult } = {}) {
  const start = WORKER_SOURCE.indexOf("async function executeCanvasCourseFileTransfer(");
  const end = WORKER_SOURCE.indexOf("\n}\n", WORKER_SOURCE.indexOf("uploadObserver?.close();", start)) + 3;
  assert.ok(start > 0 && end > start, "the Canvas file transfer moved in service-worker.js");
  const body = WORKER_SOURCE.slice(start, end);
  const resolveAnswer = resolveResult === undefined
    ? "{ ok: true, sent: false, data: { course_id: " + JSON.stringify(COURSE_ID) + ", upload_path: '/api/v1/folders/" + FOLDER_ID + "/files' } }"
    : JSON.stringify(resolveResult);
  const script = [
    "globalThis.__morrowTransferRegion = (() => {",
    "const MAX_PRIVATE_FILE_BYTES = 1024 * 1024;",
    "function executeCanvasCourseFileTransferInPage() {}",
    "const COURSE_FILE_READ_TIMEOUT_MS = 30_000;",
    "const calls = { downloads: [] };",
    "let completion = null;",
    "function canvasReviewedUploadTarget(binding, args) { return { kind: 'file', uploadPath: '/api/v1/folders/" + FOLDER_ID + "/files'" + (siteTarget ? ", siteTarget: true" : "") + " }; }",
    "async function storage() { return { courseAccessMode: " + JSON.stringify(courseAccessMode) + " }; }",
    "function boundedCommandDeadline() { return Date.now() + 30_000; }",
    "function commandDeadlineCurrent() { return true; }",
    "async function courseFileStorageAccessEnabled() { return true; }",
    "function canvasUploadFolderId(path) { return /\\/folders\\/([1-9][0-9]*)\\/files$/.exec(path)?.[1] || ''; }",
    "function decimalId(value) { return /^[1-9][0-9]*$/.test(String(value)) ? String(value) : ''; }",
    "function privateCanvasUploadPlan(data) { return { entries: [['key', 'uploads/material']], uploadUrl: new URL('https://storage.example.test/upload') }; }",
    "function observeCanvasUploadConfirmation() { return { result: Promise.resolve({ status: 201, confirmation: new URL('" + ORIGIN + "/api/v1/files/" + FILE_ID + "/confirm') }), close() {} }; }",
    "async function boundedResponseBytes(response) { return new Uint8Array(await response.arrayBuffer()); }",
    "async function sha256Bytes() { return " + JSON.stringify(SHA256) + "; }",
    "function privateCanvasConfirmationUrl(value, canvasOrigin) { try { const url = new URL(value, canvasOrigin); return url.origin === canvasOrigin ? url : null; } catch { return null; } }",
    "globalThis.chrome = { scripting: { executeScript: async ({ args }) => [{ result: (() => { const mode = JSON.parse(args[0]).mode;",
    "  if (mode === 'initialize') return { ok: true, sent: false, data: { course_id: " + JSON.stringify(COURSE_ID) + ", upload_path: '/api/v1/folders/" + FOLDER_ID + "/files' } };",
    "  if (mode === 'resolve') return (" + resolveAnswer + ");",
    "  return completion; })() }] } };",
    body,
    "return { executeCanvasCourseFileTransfer, calls, setCompletion: (value) => { completion = value; } };",
    "})();",
  ].join("\n");
  runInThisContext(script, { filename: "service-worker-transfer-region.js" });
  const value = globalThis.__morrowTransferRegion;
  delete globalThis.__morrowTransferRegion;
  return value;
}

function run(downloadResponse, regionOptions) {
  const worker = region(regionOptions);
  worker.setCompletion({
    ok: true,
    data: {
      course_id: COURSE_ID, upload_path: `/api/v1/folders/${FOLDER_ID}/files`, sha256: SHA256,
      file: { id: FILE_ID }, download_url: `${ORIGIN}/files/${FILE_ID}/download?download_frd=1`,
    },
  });
  const requests = [];
  const priorFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url: String(url?.href || url), options });
    if (String(url?.href || url).includes("/upload")) return { ok: true, status: 201 };
    return downloadResponse;
  };
  const binding = { tabId: 3, origin: ORIGIN, courseId: COURSE_ID, principalId: "7" };
  const attachment = { manifest: { filename: "proof.txt", size_bytes: BYTES.byteLength, sha256: SHA256 }, content_type: "text/plain", bytes_base64: Buffer.from(BYTES).toString("base64") };
  return worker.executeCanvasCourseFileTransfer(binding, { upload_tool: "canvas_upload_file_v1_folders_folder_id_files_post" }, Date.now() + 30_000, attachment)
    .then((result) => ({ result, requests }))
    .finally(() => { globalThis.fetch = priorFetch; });
}

test("the saved file is read back with the signed-in session", async () => {
  const { result, requests } = await run({
    ok: true, status: 200, url: "https://cdn.inst-fs.example.test/file?token=signed",
    arrayBuffer: async () => BYTES.buffer.slice(0),
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.verification.status, "verified");
  const download = requests.at(-1);
  assert.equal(download.url, `${ORIGIN}/files/${FILE_ID}/download?download_frd=1`);
  assert.equal(download.options.credentials, "include");
});

test("Canvas answering the sign-in page is never taken for the saved file", async () => {
  const { result } = await run({
    ok: true, status: 200, url: `${ORIGIN}/login/canvas`,
    arrayBuffer: async () => new TextEncoder().encode("<!doctype html><title>Log In</title>").buffer,
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "canvas_file_download_session_required");
  assert.equal(result.outcomeUnknown, true);
});

test("an unproved folder, group, or section target stops the transfer before anything is sent", async () => {
  const { result, requests } = await run(
    { ok: true, status: 200, url: "https://cdn.inst-fs.example.test/file?token=signed", arrayBuffer: async () => BYTES.buffer.slice(0) },
    { resolveResult: { ok: false, sent: false, outcomeUnknown: false, error: "canvas_file_upload_target_invalid" } },
  );
  assert.equal(result.ok, false);
  assert.equal(result.sent, false);
  assert.equal(result.error, "canvas_file_upload_target_invalid");
  assert.deepEqual(requests, []);
});

test("a site upload target needs Account access before anything is sent", async () => {
  const download = { ok: true, status: 200, url: "https://cdn.inst-fs.example.test/file?token=signed", arrayBuffer: async () => BYTES.buffer.slice(0) };
  const refused = await run(download, { siteTarget: true });
  assert.equal(refused.result.ok, false);
  assert.equal(refused.result.sent, false);
  assert.equal(refused.result.error, "course_access_account_required");
  assert.deepEqual(refused.requests, []);
  const allowed = await run(download, { siteTarget: true, courseAccessMode: "account" });
  assert.equal(allowed.result.ok, true, JSON.stringify(allowed.result));
});

const UPLOAD_CATALOG = JSON.parse(readFileSync(new URL("../../connector/extension/generated/canvas-api-catalog.json", import.meta.url), "utf8"));

// The real target resolver out of service-worker.js, with the real catalog upload routes: a
// person's files reach only that same signed-in person, and a person's files and an account
// rubric import are marked as site targets for the Account access gate at dispatch.
function targetResolver() {
  const start = WORKER_SOURCE.indexOf("function canvasReviewedUploadTarget(binding, args) {");
  const end = WORKER_SOURCE.indexOf("\n}\n", start) + 3;
  assert.ok(start > 0 && end > start, "the reviewed upload target moved in service-worker.js");
  const body = WORKER_SOURCE.slice(start, end);
  const uploads = UPLOAD_CATALOG.operations
    .filter((operation) => canvasReviewedUploadKind({ ...operation, readOnly: false }))
    .map((operation) => ({ ...operation, provider: "canvas", readOnly: false }));
  assert.ok(uploads.length > 0);
  globalThis.__morrowUploadOperations = new Map(uploads.map((operation) => [operation.toolName, operation]));
  globalThis.__morrowUploadKind = canvasReviewedUploadKind;
  globalThis.__morrowUploadPath = canvasReviewedUploadPath;
  const script = [
    "globalThis.__morrowUploadTarget = (() => {",
    "const state = { operations: globalThis.__morrowUploadOperations };",
    "const canvasReviewedUploadKind = globalThis.__morrowUploadKind;",
    "const canvasReviewedUploadPath = globalThis.__morrowUploadPath;",
    "function decimalId(value) { const id = String(value || ''); return /^[1-9][0-9]*$/.test(id) ? id : ''; }",
    body,
    "return { canvasReviewedUploadTarget };",
    "})();",
  ].join("\n");
  try {
    runInThisContext(script, { filename: "service-worker-upload-target-region.js" });
    const value = globalThis.__morrowUploadTarget;
    delete globalThis.__morrowUploadTarget;
    return value;
  } finally {
    delete globalThis.__morrowUploadOperations;
    delete globalThis.__morrowUploadKind;
    delete globalThis.__morrowUploadPath;
  }
}

test("upload targets name the bound course, own files, or a site import", () => {
  const { canvasReviewedUploadTarget } = targetResolver();
  const binding = { courseId: COURSE_ID, principalId: "7" };
  const target = (args) => canvasReviewedUploadTarget(binding, { course_id: COURSE_ID, ...args });
  assert.deepEqual(
    target({ upload_tool: "canvas_upload_file_v1_courses_course_id_files_post", upload_arguments: { course_id: COURSE_ID } }),
    { kind: "file", uploadPath: `/api/v1/courses/${COURSE_ID}/files` },
  );
  assert.deepEqual(
    target({ upload_tool: "canvas_upload_file_v1_folders_folder_id_files_post", upload_arguments: { folder_id: FOLDER_ID } }),
    { kind: "file", uploadPath: `/api/v1/folders/${FOLDER_ID}/files` },
  );
  assert.deepEqual(
    target({ upload_tool: "canvas_upload_file_v1_users_user_id_files_post", upload_arguments: { user_id: "self" } }),
    { kind: "file", uploadPath: "/api/v1/users/self/files", siteTarget: true },
  );
  assert.deepEqual(
    target({ upload_tool: "canvas_upload_file_v1_users_user_id_files_post", upload_arguments: { user_id: "7" } }),
    { kind: "file", uploadPath: "/api/v1/users/7/files", siteTarget: true },
  );
  assert.equal(
    target({ upload_tool: "canvas_upload_file_v1_users_user_id_files_post", upload_arguments: { user_id: "9" } }),
    null,
  );
  assert.deepEqual(
    target({ upload_tool: "canvas_creates_rubric_using_csv_file_accounts", upload_arguments: { account_id: "5" } }),
    { kind: "rubric_csv", uploadPath: "/api/v1/accounts/5/rubrics/upload", siteTarget: true },
  );
  assert.deepEqual(
    target({ upload_tool: "canvas_creates_rubric_using_csv_file_courses", upload_arguments: { course_id: COURSE_ID } }),
    { kind: "rubric_csv", uploadPath: `/api/v1/courses/${COURSE_ID}/rubrics/upload` },
  );
  assert.equal(
    canvasReviewedUploadTarget(binding, { course_id: "43", upload_tool: "canvas_upload_file_v1_folders_folder_id_files_post", upload_arguments: { folder_id: FOLDER_ID } }),
    null,
  );
});
