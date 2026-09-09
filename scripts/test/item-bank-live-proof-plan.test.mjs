import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../..", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const plan = read("docs/implementation/ITEM-BANK-LIVE-PROOF-PLAN.md");
const catalog = JSON.parse(read("connector/extension/generated/canvas-api-catalog.json"));
const itemBanks = catalog.operations.filter((operation) => operation.service === "item_bank");

test("the plan keeps the five attended-proof stages in order", () => {
  const headings = [...plan.matchAll(/^## Step (\d): (.+)$/gm)].map((match) => `${match[1]} ${match[2]}`);
  assert.deepEqual(headings, [
    "1 Frame observation",
    "2 Exact snapshot record",
    "3 No-write planning",
    "4 Attended write if separately authorized",
    "5 Uncertain outcome settlement",
  ]);
});

test("the plan covers all current Item Bank tools", () => {
  assert.equal(itemBanks.length, 18);
  for (const operation of itemBanks) assert.ok(plan.includes(`\`${operation.toolName}\``), operation.toolName);
  assert.equal(itemBanks.filter((operation) => operation.readOnly).length, 7);
  assert.equal(itemBanks.filter((operation) => !operation.readOnly).length, 11);
});

test("the plan records each operation-specific snapshot contract", () => {
  const required = {
    canvas_item_bank_create_bank: ["banks_sha256"],
    canvas_item_bank_rename_bank: ["bank_sha256"],
    canvas_item_bank_archive_bank: ["bank_sha256", "entries_sha256", "shares_sha256"],
    canvas_item_bank_create_item: ["bank_sha256"],
    canvas_item_bank_update_item: ["bank_sha256", "item_sha256"],
    canvas_item_bank_attach_item: ["bank_sha256", "item_sha256", "entries_sha256"],
    canvas_item_bank_delete_entry: ["bank_sha256", "entry_sha256", "entries_sha256"],
    canvas_item_bank_share_bank: ["bank_sha256", "shares_sha256"],
    canvas_item_bank_attach_bank_to_quiz: ["bank_sha256", "quiz_entries_sha256"],
    canvas_item_bank_attach_bank_entry_to_quiz: ["bank_sha256", "entry_sha256", "quiz_entries_sha256"],
    canvas_item_bank_delete_quiz_bank_entry: ["bank_sha256", "quiz_entries_sha256", "quiz_entry_sha256"],
  };
  for (const [tool, digests] of Object.entries(required)) {
    const row = plan.split("\n").find((line) => line.includes(`\`${tool}\``));
    assert.ok(row, tool);
    for (const digest of digests) assert.ok(row.includes(`\`${digest}\``), `${tool} must name ${digest}`);
  }
});

test("the plan forbids live dispatch under the current assignment", () => {
  assert.match(plan, /Skip this step for the current assignment/);
  assert.match(plan, /Do not approve or dispatch it in this assignment/);
  assert.match(plan, /It needs its own written authorization from the course owner/);
  assert.match(plan, /There is no automatic retry/);
});

test("the frame and secret boundary matches the implementation", () => {
  const credential = read("connector/extension/src/item-bank-credential.js");
  const executor = read("connector/extension/src/item-bank-executor.js");
  assert.match(credential, /ITEM_BANK_EXTERNAL_TOOL_ID = "54065"/);
  assert.match(credential, /contextUuid/);
  assert.match(executor, /credential\.canvasLocalContextId !== input\.courseId/);
  assert.match(plan, /Never record an `Authorization` value/);
  assert.match(plan, /Do not record a digest, prefix, or length for the credential/);
  assert.match(plan, /service-worker memory/);
});

test("the plan names the exact readback classes and uncertain settlement", () => {
  for (const phrase of [
    "the verification status and evidence, and the exact reread that proved the saved result",
    "One successful preflight permits one provider request",
    "Do not dispatch it again",
    "It repairs one reviewed image and leaves every other part of the question",
  ]) assert.ok(plan.includes(phrase), phrase);
});

test("all cited repository sources and linked documents exist", () => {
  const sources = [...plan.matchAll(/`([A-Za-z0-9_./-]+\.(?:js|ts|mjs))`/g)].map((match) => match[1]);
  for (const source of sources) assert.ok(existsSync(new URL(source, root)), source);
  const planUrl = new URL("docs/implementation/ITEM-BANK-LIVE-PROOF-PLAN.md", root);
  for (const match of plan.matchAll(/\]\(([^)]+\.md)\)/g)) assert.ok(existsSync(new URL(match[1], planUrl)), match[1]);
});

test("fixture evidence remains distinct from live Canvas evidence", () => {
  assert.match(plan, /implementation evidence only/);
  assert.match(plan, /They are not live Canvas evidence/);
  assert.match(plan, /live-unverified/);
});
