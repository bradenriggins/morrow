import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { BRIDGE_SOURCE_FILES } from "../package-mcp-bundle.mjs";

const root = new URL("../../", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("connector/extension/manifest.json", root), "utf8"));
const catalog = readFileSync(new URL("artifacts/canvas-api/canvas-api-catalog.json", root));
const extensionCatalog = readFileSync(new URL("connector/extension/generated/canvas-api-catalog.json", root));
const extensionReadbackPlan = readFileSync(new URL("connector/extension/generated/canvas-readback-plan.js", root), "utf8");
const extensionAdmission = readFileSync(new URL("connector/extension/generated/canvas-operation-admission.js", root), "utf8");
const extensionSemanticTarget = readFileSync(new URL("connector/extension/generated/canvas-semantic-target.js", root), "utf8");
const worker = readFileSync(new URL("connector/extension/src/service-worker.js", root), "utf8");

test("the Bridge release includes the Item Bank credential module", () => {
  assert.match(worker, /from "\.\/item-bank-credential\.js"/);
  assert.match(worker, /from "\.\/quiz-bank-draw-executor\.js"/);
  assert.ok(BRIDGE_SOURCE_FILES.includes("src/item-bank-credential.js"));
  assert.ok(BRIDGE_SOURCE_FILES.includes("src/quiz-bank-draw-executor.js"));
});

/** The exact top-level function of that name, taken from the shipped service worker and run here. */
function workerFunction(name) {
  const start = worker.search(new RegExp(`^(?:async )?function ${name}\\(`, "m"));
  assert.ok(start >= 0, `${name} is no longer a top-level function in the service worker`);
  const end = worker.indexOf("\n}\n", start);
  assert.ok(end > start, `${name} does not close at the start of a line`);
  return worker.slice(start, end + 2);
}

function workerConstant(name) {
  const match = worker.match(new RegExp(`^const ${name} = .+;$`, "m"));
  assert.ok(match, `${name} is no longer a top-level constant in the service worker`);
  return match[0];
}

/** chrome.storage.session as the service worker uses it: read the named keys, merge what is written. */
function storageArea() {
  const values = new Map();
  return {
    async get(keys) {
      const names = typeof keys === "string" ? [keys] : keys;
      return Object.fromEntries(names.filter((name) => values.has(name)).map((name) => [name, values.get(name)]));
    },
    async set(items) {
      for (const [name, value] of Object.entries(items)) values.set(name, value);
    },
  };
}

/** The receipt record of one browser session, with the service worker's own reservation running against it. */
function receiptRecord() {
  const area = storageArea();
  const sandbox = { chrome: { storage: { session: area, local: area } } };
  runInNewContext([
    workerConstant("USED_EFFECT_RECEIPT_LIMIT"),
    workerFunction("problem"),
    workerFunction("discoveryArea"),
    workerFunction("storedUsedReceipts"),
    workerFunction("reserveReceiptNow"),
    "globalThis.reserve = reserveReceiptNow;",
    "globalThis.limit = USED_EFFECT_RECEIPT_LIMIT;",
  ].join("\n"), sandbox);
  return {
    area,
    limit: sandbox.limit,
    reserve: (effectReceiptId, createdAt) => sandbox.reserve({ kind: "invoke_write", createdAt, outerGrant: { effectReceiptId } }),
  };
}

function extensionId(publicKey) {
  const digest = createHash("sha256").update(Buffer.from(publicKey, "base64")).digest().subarray(0, 16);
  return [...digest].flatMap((byte) => [byte >> 4, byte & 15]).map((nibble) => String.fromCharCode(97 + nibble)).join("");
}

test("Canvas connector package has a stable least-privilege identity and exact generated catalog", () => {
  assert.equal(extensionId(manifest.key), "abeloclekioohahgedmjcdbpllfjfhko");
  assert.deepEqual(manifest.host_permissions, ["http://127.0.0.1/*"]);
  assert.deepEqual(manifest.optional_host_permissions, ["https://*/*"]);
  assert.equal(manifest.permissions.includes("cookies"), false);
  assert.equal(manifest.permissions.includes("sidePanel"), false);
  assert.equal(manifest.permissions.includes("webRequest"), true);
  assert.equal(manifest.host_permissions.includes("<all_urls>"), false);
  assert.equal("web_accessible_resources" in manifest, false);
  assert.deepEqual(catalog, extensionCatalog);
  assert.match(extensionReadbackPlan, /export function planBrowserReadback/);
  assert.doesNotMatch(extensionReadbackPlan, /\bnode:|\brequire\s*\(/);
  assert.match(extensionAdmission, /export function canvasOperationAdmission/);
  assert.doesNotMatch(extensionAdmission, /\bnode:|\brequire\s*\(/);
  assert.match(extensionSemanticTarget, /export function canvasSemanticCourseTarget/);
  assert.doesNotMatch(extensionSemanticTarget, /\bnode:|\brequire\s*\(/);
  const parsed = JSON.parse(catalog);
  assert.equal(parsed.counts.totalOperations, 1137);
  assert.equal(parsed.counts.newQuizzesOperations, 32);
  assert.equal(parsed.counts.itemBankOperations, 18);
  assert.equal(parsed.counts.courseFileContentOperations, 1);
  assert.deepEqual(parsed.operations.find((operation) => operation.toolName === "canvas_read_course_file_text"), {
    key: "CANVAS_COURSE_FILE_TEXT GET /v1/courses/{course_id}/files/{file_id}/text",
    toolName: "canvas_read_course_file_text",
    source: "morrow-privileged-canvas-file-content-contract",
    service: "course_file_content",
    resource: "Canvas Course Files",
    family: "files",
    nickname: "read_course_file_text",
    method: "GET",
    path: "/v1/courses/{course_id}/files/{file_id}/text",
    summary: "Read one confirmed text course file.",
    description: "Read one UTF-8 text, HTML, or XHTML Canvas course file after a fresh course-scoped file check. This requires the user's separate HTTPS file-reading permission and never sends browser credentials to the file storage host.",
    deprecated: false,
    risk: "read",
    readOnly: true,
    parameters: [
      { inputName: "course_id", wireName: "course_id", location: "path", required: true, deprecated: false, schema: { type: "string", pattern: "^[1-9][0-9]*$" } },
      { inputName: "file_id", wireName: "file_id", location: "path", required: true, deprecated: false, schema: { type: "string", pattern: "^[1-9][0-9]*$" } },
    ],
    inputSchema: {
      type: "object",
      properties: {
        course_id: { type: "string", pattern: "^[1-9][0-9]*$" },
        file_id: { type: "string", pattern: "^[1-9][0-9]*$" },
      },
      required: ["course_id", "file_id"],
      additionalProperties: false,
    },
    responseType: "CanvasCourseFileText",
  });
  assert.match(parsed.catalogDigest, /^[0-9a-f]{64}$/);
});

// The record of accepted changes is capped, so a long browser session cannot grow without a limit.
// Dropping the oldest receipt on its own would let that change through a second time, so the drop
// raises a mark and every command prepared at or before it is refused.
test("a receipt the extension dropped from its record is refused, not accepted a second time", async () => {
  const { area, limit, reserve } = receiptRecord();
  const first = 1_700_000_000_000;
  const full = Array.from({ length: limit }, (_, index) => ({ id: `effect:seed-${index}`, at: first + index }));
  const oldest = full[0];
  await area.set({ usedEffectReceipts: full });

  assert.equal(await reserve("effect:new-1", first + limit), null);
  const record = await area.get(["usedEffectReceipts", "usedEffectReceiptFloorAt"]);
  assert.equal(record.usedEffectReceipts.length, limit);
  assert.equal(record.usedEffectReceipts.some((entry) => entry.id === oldest.id), false, "the oldest receipt was dropped to keep the cap");
  assert.equal(record.usedEffectReceiptFloorAt, oldest.at);

  const refused = await reserve(oldest.id, oldest.at);
  assert.equal(refused.code, "effect_receipt_refused");
  assert.equal(refused.recoverable, false);
  assert.match(refused.message, /no longer holds the record/);
  const after = await area.get("usedEffectReceipts");
  assert.equal(after.usedEffectReceipts.some((entry) => entry.id === oldest.id), false, "a refused receipt is never written back");

  const used = await reserve("effect:new-1", first + limit + 1);
  assert.equal(used.code, "effect_receipt_refused");
  assert.match(used.message, /already used/);
  assert.equal(await reserve("effect:new-2", first + limit + 1), null, "a change prepared after the mark still goes through");
});

test("receipts written by an earlier build are still refused after this one takes over", async () => {
  const { area, reserve } = receiptRecord();
  await area.set({ usedEffectReceipts: ["effect:earlier-build"] });
  const refused = await reserve("effect:earlier-build", 1_700_000_000_000);
  assert.equal(refused.code, "effect_receipt_refused");
  assert.match(refused.message, /already used/);
});
