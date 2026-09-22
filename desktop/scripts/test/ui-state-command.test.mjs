import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInThisContext } from "node:vm";
import { parseReviewLearnerNames } from "../../connector/extension/src/review-approval.js";

/**
 * WI-2.4d: the Bridge side of `ui_state` (D1b). The runtime pushes the list of reviews waiting
 * for the person; this worker checks the command again (the same rules as
 * `normalizeBridgeUiState` in packages/bridge-protocol), stores the checked list in memory only,
 * and lets the toolbar badge (WI-1.3, refreshBadge, covered by scripts/test/toolbar-badge.test.mjs)
 * reflect the new count. This exercises the real service-worker.js source for the validator, the
 * apply step and the command handler, the way scripts/test/open-platform.test.mjs isolates one
 * handler from the rest of the worker. The popup's own "Waiting for your review" rendering is a
 * later work item and is not exercised here.
 */

const WORKER_SOURCE = readFileSync(new URL("../../connector/extension/src/service-worker.js", import.meta.url), "utf8");

function findEnd(startMarker, endMarker) {
  const start = WORKER_SOURCE.indexOf(startMarker);
  assert.ok(start >= 0, `moved in service-worker.js: ${startMarker}`);
  const endIndex = WORKER_SOURCE.indexOf(endMarker, start + startMarker.length);
  assert.ok(endIndex > start, `moved in service-worker.js: ${endMarker}`);
  return { start, endIndex };
}

/** The region from startMarker through the end of endMarker itself. */
function sliceIncluding(startMarker, endMarker) {
  const { start, endIndex } = findEnd(startMarker, endMarker);
  return WORKER_SOURCE.slice(start, endIndex + endMarker.length);
}

const PROTOCOL_VERSION_SOURCE = sliceIncluding("const PROTOCOL_VERSION = ", ";");
const PROBLEM_SOURCE = sliceIncluding("const MORROW_REFUSAL_TOKEN = ", "\n}\n");
const UI_STATE_VALIDATOR_SOURCE = sliceIncluding("const MAX_BRIDGE_UI_REVIEWS = 20;", "\n}\n");
const APPLY_UI_STATE_SOURCE = sliceIncluding("async function applyBridgeUiState(uiState) {", "\n}\n");
const HANDLE_UI_STATE_SOURCE = sliceIncluding("async function handleUiState(command) {", "\n}\n");

/**
 * Loads bridgeUiState, applyBridgeUiState and handleUiState out of service-worker.js into an
 * isolated context, with `state`, `refreshBadge`, `bridgeCommandCancelled` and `sendResult`
 * stubbed. Nothing here reaches a real socket, a real tab or the real refreshBadge.
 */
function harness({ generation = 1, cancelled = false } = {}) {
  const calls = { sendResult: [], refreshBadge: 0, bridgeCommandCancelled: 0, runtimeMessages: [], storedLearnerNames: [] };
  globalThis.__morrowParseReviewLearnerNames = parseReviewLearnerNames;
  const script = [
    "globalThis.__morrowUiStateHarness = (() => {",
    `const calls = ${JSON.stringify(calls)};`,
    `let cancelled = ${JSON.stringify(cancelled)};`,
    `const state = { generation: ${JSON.stringify(generation)}, reviews: [], reviewsWaiting: 0 };`,
    "async function refreshBadge() { calls.refreshBadge += 1; }",
    "async function bridgeCommandCancelled() { calls.bridgeCommandCancelled += 1; return cancelled; }",
    "function sendResult(command, ok, result, failure) { calls.sendResult.push({ ok, result, failure }); }",
    "const chrome = { runtime: { sendMessage: async (message) => { calls.runtimeMessages.push(message); } } };",
    "const parseReviewLearnerNames = globalThis.__morrowParseReviewLearnerNames;",
    "async function storeReviewLearnerNames(entries) { calls.storedLearnerNames.push(entries); }",
    PROTOCOL_VERSION_SOURCE,
    PROBLEM_SOURCE,
    UI_STATE_VALIDATOR_SOURCE,
    APPLY_UI_STATE_SOURCE,
    HANDLE_UI_STATE_SOURCE,
    "return {",
    "  calls,",
    "  state,",
    "  bridgeUiState: (command) => bridgeUiState(command),",
    "  handleUiState: (command) => handleUiState(command),",
    "};",
    "})();",
  ].join("\n");
  runInThisContext(script, { filename: "service-worker-ui-state-region.js" });
  const value = globalThis.__morrowUiStateHarness;
  delete globalThis.__morrowUiStateHarness;
  delete globalThis.__morrowParseReviewLearnerNames;
  return value;
}

const REVIEW = { url: "http://127.0.0.1:44300/operations/op-12345678", label: "Update the syllabus page in BIO 201" };
const BATCH_REVIEW = { url: "http://127.0.0.1:44300/batches/batch-12345678", label: "3 changes in BIO 201" };

function command(overrides = {}) {
  return {
    schema: "morrow.bridge.command.v1",
    protocolVersion: 1,
    requestId: "req-1",
    operationId: "op-1",
    kind: "ui_state",
    uiState: { reviews: [REVIEW] },
    generation: 1,
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    ...overrides,
  };
}

test("a well-formed command validates, an empty list validates, and a batches address validates", () => {
  const h = harness();
  assert.deepEqual(h.bridgeUiState(command()), { reviews: [REVIEW] });
  assert.deepEqual(h.bridgeUiState(command({ uiState: { reviews: [] } })), { reviews: [] });
  assert.deepEqual(h.bridgeUiState(command({ uiState: { reviews: [REVIEW, BATCH_REVIEW] } })), { reviews: [REVIEW, BATCH_REVIEW] });
});

test("more than 20 reviews is refused", () => {
  const h = harness();
  const reviews = Array.from({ length: 21 }, () => REVIEW);
  assert.throws(() => h.bridgeUiState(command({ uiState: { reviews } })), /ui_state_invalid/);
});

test("an unsupported key at the command, the uiState or the entry level is refused", () => {
  const h = harness();
  assert.throws(() => h.bridgeUiState({ ...command(), extra: true }), /ui_state_invalid/);
  assert.throws(() => h.bridgeUiState(command({ uiState: { reviews: [], path: "/tmp" } })), /ui_state_invalid/);
  assert.throws(() => h.bridgeUiState(command({ uiState: { reviews: [{ ...REVIEW, extra: true }] } })), /ui_state_invalid/);
});

test("the wrong kind is refused", () => {
  const h = harness();
  assert.throws(() => h.bridgeUiState(command({ kind: "edit_policy_set" })), /ui_state_invalid/);
});

const BAD_URLS = [
  ["https instead of http", "https://127.0.0.1:44300/operations/op-12345678"],
  ["localhost instead of the loopback address", "http://localhost:44300/operations/op-12345678"],
  ["a shortened loopback address", "http://127.1:44300/operations/op-12345678"],
  ["no port", "http://127.0.0.1/operations/op-12345678"],
  ["a query string", "http://127.0.0.1:44300/operations/op-12345678?x=1"],
  ["a hash", "http://127.0.0.1:44300/operations/op-12345678#top"],
  ["a user name and password", "http://user:pass@127.0.0.1:44300/operations/op-12345678"],
  ["a path outside operations and batches", "http://127.0.0.1:44300/tasks/op-12345678"],
  ["an id shorter than 8 characters", "http://127.0.0.1:44300/operations/short"],
];

for (const [label, url] of BAD_URLS) {
  test(`a review address is refused: ${label}`, () => {
    const h = harness();
    assert.throws(() => h.bridgeUiState(command({ uiState: { reviews: [{ ...REVIEW, url }] } })), /ui_state_invalid/);
  });
}

test("a label that is empty or over 120 characters is refused", () => {
  const h = harness();
  assert.throws(() => h.bridgeUiState(command({ uiState: { reviews: [{ ...REVIEW, label: "" }] } })), /ui_state_invalid/);
  assert.throws(() => h.bridgeUiState(command({ uiState: { reviews: [{ ...REVIEW, label: "x".repeat(121) }] } })), /ui_state_invalid/);
  // 120 characters exactly still validates.
  assert.doesNotThrow(() => h.bridgeUiState(command({ uiState: { reviews: [{ ...REVIEW, label: "x".repeat(120) }] } })));
});

test("a generation that does not match the Bridge's own is stale, not invalid", () => {
  const h = harness({ generation: 1 });
  assert.throws(() => h.bridgeUiState(command({ generation: 2 })), /ui_state_stale/);
});

test("an expired or missing expiresAt is stale", () => {
  const h = harness({ generation: 1 });
  assert.throws(() => h.bridgeUiState(command({ expiresAt: Date.now() - 1 })), /ui_state_stale/);
  assert.throws(() => h.bridgeUiState(command({ expiresAt: undefined })), /ui_state_stale/);
});

test("a checked ui_state is stored in memory, refreshes the badge once, and tells an open popup", async () => {
  const h = harness({ generation: 1 });
  await h.handleUiState(command({ uiState: { reviews: [REVIEW, BATCH_REVIEW] } }));
  assert.deepEqual(h.state.reviews, [REVIEW, BATCH_REVIEW]);
  assert.equal(h.state.reviewsWaiting, 2);
  assert.equal(h.calls.refreshBadge, 1);
  assert.deepEqual(h.calls.runtimeMessages, [{ type: "morrow_bridge_status_changed" }]);
  assert.equal(h.calls.sendResult.length, 1);
  assert.deepEqual(h.calls.sendResult[0], { ok: true, result: { schema: "morrow.bridge.ui-state.v1", accepted: 2 }, failure: null });
  assert.deepEqual(h.calls.storedLearnerNames, [[]], "a push with no names forgets every name");
});

test("a review's label-to-name map is checked, stored for the review tab, and never echoed in the result", async () => {
  const h = harness({ generation: 1 });
  const learnerNames = [{ path: "/operations/op-12345678", names: { "Student A1": "Jane Doe" } }];
  assert.deepEqual(h.bridgeUiState(command({ uiState: { reviews: [REVIEW], learnerNames } })), { reviews: [REVIEW], learnerNames });
  assert.throws(() => h.bridgeUiState(command({ uiState: { reviews: [], learnerNames: [{ path: "/recent", names: { "Student A1": "Jane Doe" } }] } })), /ui_state_invalid/);
  await h.handleUiState(command({ uiState: { reviews: [REVIEW], learnerNames } }));
  assert.deepEqual(h.calls.storedLearnerNames, [learnerNames]);
  assert.doesNotMatch(JSON.stringify(h.calls.sendResult), /Jane/);
});

test("an invalid ui_state applies nothing, and the failure never throws (a failure must never block a plan)", async () => {
  const h = harness({ generation: 1 });
  await h.handleUiState(command({ kind: "wrong" }));
  assert.equal(h.calls.refreshBadge, 0, "nothing is applied on a refused command");
  assert.deepEqual(h.state.reviews, [], "state is untouched");
  assert.equal(h.calls.sendResult.length, 1);
  const [{ ok, result, failure }] = h.calls.sendResult;
  assert.equal(ok, false);
  assert.equal(result, null);
  assert.equal(failure.code, "ui_state_invalid");
  assert.equal(failure.recoverable, true);
});

test("a stale ui_state answers the stale code, recoverable false", async () => {
  const h = harness({ generation: 1 });
  await h.handleUiState(command({ generation: 9 }));
  assert.equal(h.calls.sendResult.length, 1);
  const [{ ok, failure }] = h.calls.sendResult;
  assert.equal(ok, false);
  assert.equal(failure.code, "ui_state_stale");
  assert.equal(failure.recoverable, false);
});

test("a cancelled command applies nothing and sends no result", async () => {
  const h = harness({ generation: 1, cancelled: true });
  await h.handleUiState(command());
  assert.equal(h.calls.bridgeCommandCancelled, 1);
  assert.equal(h.calls.refreshBadge, 0);
  assert.equal(h.calls.sendResult.length, 0);
});
