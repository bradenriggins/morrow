import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInThisContext } from "node:vm";

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

function region() {
  const start = WORKER_SOURCE.indexOf("async function executeCanvasCourseFileTransfer(");
  const end = WORKER_SOURCE.indexOf("\n}\n", WORKER_SOURCE.indexOf("uploadObserver?.close();", start)) + 3;
  assert.ok(start > 0 && end > start, "the Canvas file transfer moved in service-worker.js");
  const body = WORKER_SOURCE.slice(start, end);
  const script = [
    "globalThis.__morrowTransferRegion = (() => {",
    "const MAX_PRIVATE_FILE_BYTES = 1024 * 1024;",
    "function executeCanvasCourseFileTransferInPage() {}",
    "const COURSE_FILE_READ_TIMEOUT_MS = 30_000;",
    "const calls = { downloads: [] };",
    "let completion = null;",
    "function canvasReviewedUploadTarget(binding, args) { return { kind: 'file', uploadPath: '/api/v1/folders/" + FOLDER_ID + "/files' }; }",
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
    "globalThis.chrome = { scripting: { executeScript: async ({ args }) => [{ result: args[0].mode === 'initialize'",
    "  ? { ok: true, sent: false, data: { course_id: " + JSON.stringify(COURSE_ID) + ", upload_path: '/api/v1/folders/" + FOLDER_ID + "/files' } }",
    "  : completion }] } };",
    body,
    "return { executeCanvasCourseFileTransfer, calls, setCompletion: (value) => { completion = value; } };",
    "})();",
  ].join("\n");
  runInThisContext(script, { filename: "service-worker-transfer-region.js" });
  const value = globalThis.__morrowTransferRegion;
  delete globalThis.__morrowTransferRegion;
  return value;
}

function run(downloadResponse) {
  const worker = region();
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
