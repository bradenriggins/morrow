import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInThisContext } from "node:vm";

/**
 * WI-1.3: the toolbar badge, refreshBadge(). This exercises the real service-worker.js source for
 * refreshBadge, the way scripts/test/open-platform.test.mjs isolates
 * one handler from the rest of the worker. storage(), catalog() and validEditPermission (owned by
 * edit-policy.js, exercised by its own tests) are stubbed; storedPolicies is the real source.
 */

const WORKER_SOURCE = readFileSync(new URL("../../connector/extension/src/service-worker.js", import.meta.url), "utf8");

function findEnd(startMarker, endMarker) {
  const start = WORKER_SOURCE.indexOf(startMarker);
  assert.ok(start >= 0, `moved in service-worker.js: ${startMarker}`);
  const endIndex = WORKER_SOURCE.indexOf(endMarker, start + startMarker.length);
  assert.ok(endIndex > start, `moved in service-worker.js: ${endMarker}`);
  return { start, endIndex };
}

/** The region from startMarker through the end of endMarker itself, braces balanced. */
function sliceIncluding(startMarker, endMarker) {
  const { start, endIndex } = findEnd(startMarker, endMarker);
  return WORKER_SOURCE.slice(start, endIndex + endMarker.length);
}

const BADGE_CONSTANTS_SOURCE = sliceIncluding('const BADGE_ALARM_NAME = "morrow-badge";', 'const BADGE_ACTION_COLOR = "#253FEA";');
const REFRESH_BADGE_SOURCE = sliceIncluding("async function refreshBadge() {", "\n}\n");
const STORED_POLICIES_SOURCE = sliceIncluding("function storedPolicies(value) {", "\n}\n");

test("the action color in refreshBadge matches the brand document's Action swatch", () => {
  assert.match(WORKER_SOURCE, /const BADGE_ACTION_COLOR = "#253FEA";/);
  const brand = readFileSync(new URL("../../docs/brand/MORROW-BRAND.md", import.meta.url), "utf8");
  assert.match(brand, /\| Action \| `#253FEA` \|/);
});

/**
 * Loads refreshBadge and storedPolicies out of service-worker.js into an isolated
 * context, with storage, catalog and validEditPermission stubbed and chrome.action / chrome.alarms
 * faked. Nothing here reaches a real tab, a network, or the real edit-policy.js.
 *
 * `editValidity` maps a binding's sourceBindingId to what the stubbed validEditPermission returns
 * for it: `null` (or omitted) for no valid Edit permission, or an object such as
 * `{ expiresAt: <ms> }` for a valid one. A permission's own `expiresAt` is deliberately not the
 * fixture's `permission.expiresAt` shape, because refreshBadge reads it only off what
 * validEditPermission returns, exactly as the real function does.
 */
function harness({ reviewsWaiting, bindings = [], editValidity = {} } = {}) {
  const calls = { setBadgeText: [], setBadgeBackgroundColor: [], setTitle: [], alarmsCreate: [], alarmsClear: [], validEditPermission: [] };
  const script = [
    "globalThis.__morrowBadgeHarness = (() => {",
    `const calls = ${JSON.stringify(calls)};`,
    `const bindings = ${JSON.stringify(bindings)};`,
    `const editValidity = ${JSON.stringify(editValidity)};`,
    `let state = { ${reviewsWaiting === undefined ? "" : `reviewsWaiting: ${JSON.stringify(reviewsWaiting)},`} operations: new Map() };`,
    "async function storage() { return { bindings, editPolicies: {} }; }",
    "async function catalog() { return { catalogDigest: 'fixture-digest' }; }",
    "async function validEditPermission({ permission, binding, catalogDigest, operations }) {",
    "  calls.validEditPermission.push({ sourceBindingId: binding.sourceBindingId, catalogDigest });",
    "  const result = editValidity[binding.sourceBindingId];",
    "  return result === undefined ? null : result;",
    "}",
    STORED_POLICIES_SOURCE,
    BADGE_CONSTANTS_SOURCE,
    REFRESH_BADGE_SOURCE,
    "globalThis.chrome = {",
    "  action: {",
    "    setBadgeText: async (value) => { calls.setBadgeText.push(value); },",
    "    setBadgeBackgroundColor: async (value) => { calls.setBadgeBackgroundColor.push(value); },",
    "    setTitle: async (value) => { calls.setTitle.push(value); },",
    "  },",
    "  alarms: {",
    "    create: async (name, options) => { calls.alarmsCreate.push({ name, options }); },",
    "    clear: async (name) => { calls.alarmsClear.push(name); },",
    "  },",
    "};",
    "return { calls, refreshBadge: () => refreshBadge() };",
    "})();",
  ].join("\n");
  runInThisContext(script, { filename: "service-worker-badge-region.js" });
  const value = globalThis.__morrowBadgeHarness;
  delete globalThis.__morrowBadgeHarness;
  return value;
}

const BINDING_1 = { sourceBindingId: "canvas:account:g1:c1" };
const BINDING_2 = { sourceBindingId: "canvas:account:g1:c2" };

test("reviews waiting: text is the count, color is the action color, no Edit check runs", async () => {
  const h = harness({ reviewsWaiting: 2, bindings: [BINDING_1] });
  await h.refreshBadge();
  assert.deepEqual(h.calls.setBadgeText, [{ text: "2" }]);
  assert.deepEqual(h.calls.setBadgeBackgroundColor, [{ color: "#253FEA" }]);
  assert.deepEqual(h.calls.setTitle, [{ title: "Morrow Bridge. 2 reviews wait." }]);
  assert.equal(h.calls.validEditPermission.length, 0, "a review count wins outright; Edit is not checked");
  assert.deepEqual(h.calls.alarmsClear, ["morrow-badge"], "no expiry to track while reviews own the badge");
  assert.equal(h.calls.alarmsCreate.length, 0);
});

test("reviews waiting: the count caps at 99", async () => {
  const h = harness({ reviewsWaiting: 150 });
  await h.refreshBadge();
  assert.deepEqual(h.calls.setBadgeText, [{ text: "99" }]);
  assert.equal(h.calls.setTitle[0].title, "Morrow Bridge. 150 reviews wait.", "the title states the real count, only the badge glyph caps");
});

test("reviews waiting: one review reads as singular", async () => {
  const h = harness({ reviewsWaiting: 1 });
  await h.refreshBadge();
  assert.deepEqual(h.calls.setBadgeText, [{ text: "1" }]);
  assert.equal(h.calls.setTitle[0].title, "Morrow Bridge. 1 review waits.");
});

// Edit is not timed, so the title names no end time, and nothing needs an alarm.
test("no reviews, one valid Edit permission: text is ON, the title names the course, no alarm", async () => {
  const h = harness({ reviewsWaiting: 0, bindings: [BINDING_1], editValidity: { [BINDING_1.sourceBindingId]: {} } });
  await h.refreshBadge();
  assert.deepEqual(h.calls.setBadgeText, [{ text: "ON" }]);
  assert.deepEqual(h.calls.setBadgeBackgroundColor, [{ color: "#253FEA" }]);
  assert.deepEqual(h.calls.setTitle, [{ title: "Morrow Bridge. Morrow can change 1 course with no review." }]);
  assert.deepEqual(h.calls.alarmsClear, ["morrow-badge"]);
  assert.equal(h.calls.alarmsCreate.length, 0);
});

test("a missing state.reviewsWaiting (before R2) reads as 0, so it falls through to the Edit check", async () => {
  const h = harness({ reviewsWaiting: undefined, bindings: [BINDING_1], editValidity: { [BINDING_1.sourceBindingId]: {} } });
  await h.refreshBadge();
  assert.deepEqual(h.calls.setBadgeText, [{ text: "ON" }], "no thrown error, no reviews-branch text");
});

// A grant saved while Edit was timed still has its own end time. The title does not promise it, and
// the alarm refreshes the badge when the sooner of those grants lapses to Plan.
test("two connections have valid Edit; the count is 2, and the alarm tracks a saved grant's end", async () => {
  const sooner = Date.now() + 60_000;
  const h = harness({
    reviewsWaiting: 0,
    bindings: [BINDING_1, BINDING_2],
    editValidity: { [BINDING_1.sourceBindingId]: {}, [BINDING_2.sourceBindingId]: { expiresAt: sooner } },
  });
  await h.refreshBadge();
  assert.deepEqual(h.calls.setBadgeText, [{ text: "ON" }]);
  assert.equal(h.calls.setTitle[0].title, "Morrow Bridge. Morrow can change 2 courses with no review.");
  assert.deepEqual(h.calls.alarmsCreate, [{ name: "morrow-badge", options: { when: sooner } }]);
});

test("no reviews and no valid Edit permission: empty text, plain title, no alarm", async () => {
  const h = harness({ reviewsWaiting: 0, bindings: [BINDING_1], editValidity: {} });
  await h.refreshBadge();
  assert.deepEqual(h.calls.setBadgeText, [{ text: "" }]);
  assert.equal(h.calls.setBadgeBackgroundColor.length, 0, "no color set for an empty badge");
  assert.deepEqual(h.calls.setTitle, [{ title: "Morrow Bridge" }]);
  assert.deepEqual(h.calls.alarmsClear, ["morrow-badge"]);
  assert.equal(h.calls.alarmsCreate.length, 0);
});

test("no bindings at all: the Edit check runs over an empty list and lands on the empty state", async () => {
  const h = harness({ reviewsWaiting: 0, bindings: [] });
  await h.refreshBadge();
  assert.deepEqual(h.calls.setBadgeText, [{ text: "" }]);
  assert.equal(h.calls.validEditPermission.length, 0);
});

/**
 * The alarm named "morrow-badge" is how the badge clears itself with no other event to prompt it.
 * The router's listener is exercised in scripts/test/lib (not here): this pins the constant it
 * fires refreshBadge on, and that refreshBadge itself schedules the alarm to that same name.
 */
test("the alarm name refreshBadge schedules and clears is morrow-badge", () => {
  assert.match(WORKER_SOURCE, /const BADGE_ALARM_NAME = "morrow-badge";/);
  assert.match(WORKER_SOURCE, /if \(alarm\.name === BADGE_ALARM_NAME\) void refreshBadge\(\);/);
});
