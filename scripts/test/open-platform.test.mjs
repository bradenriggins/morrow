import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInThisContext } from "node:vm";

/**
 * WI-1.1: the "Open Canvas" / "Open Moodle" handler and its `morrow_open_platform` router entry.
 * The buttons that send this message are WI-1.1b. This exercises the real service-worker.js source
 * for the router chain and the handler, with the page-message and Chrome APIs stubbed, the way
 * scripts/test/canvas-course-file-worker.test.mjs isolates one handler from the rest of the worker.
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

/** The region from startMarker up to (not including) endMarker. */
function sliceBefore(startMarker, endMarker) {
  const { start, endIndex } = findEnd(startMarker, endMarker);
  return WORKER_SOURCE.slice(start, endIndex);
}

const STORED_ANCHORS_SOURCE = sliceIncluding("function storedAnchors(value) {", "\n}\n");
const MESSAGE_CODE_SOURCE = sliceIncluding("function messageCode(error) {", "\n}\n");
const HANDLER_SOURCE = sliceBefore("function awaitTabLoad(tabId, timeoutMs) {", "\nasync function disconnectConnector()");
const ROUTER_SOURCE = sliceBefore("chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {", "\nchrome.permissions.onAdded.addListener");

test("the load-wait budget stays twenty seconds (WI-1.1 acceptance)", () => {
  assert.match(WORKER_SOURCE, /const OPEN_PLATFORM_LOAD_TIMEOUT_MS = 20_000;/);
});

/**
 * Loads storedAnchors, awaitTabLoad, openPlatform, bindingForCommand and the real onMessage router
 * out of service-worker.js into an isolated context, with storage, publishBindings, bindingFor and
 * siteAnchorMatches stubbed and Chrome's tabs and storage.local API faked. Nothing here reaches a
 * network or a real tab.
 *
 * `bindingForResults`, when given, is the queue of binding-check outcomes that the stubbed
 * `bindingFor` returns, in call order: consumed one at a time, the last entry repeats for any call
 * beyond the queue's length (so a test can assert exactly how many times it was called).
 */
function harness({ anchors = [], bindings = [], matchResult = true, loadOutcome = "complete", consentAccepted = true, openPlatformWhenNeeded, bindingForResults = [] } = {}) {
  const calls = { tabsCreated: [], tabsUpdated: [], publishBindings: 0, siteAnchorMatches: [], requireConsent: 0, bindingFor: [], storageSet: [] };
  const script = [
    "globalThis.__morrowOpenPlatformHarness = (() => {",
    `const calls = ${JSON.stringify(calls)};`,
    `let fixture = { anchors: ${JSON.stringify(anchors)}, bindings: ${JSON.stringify(bindings)}, openPlatformWhenNeeded: ${JSON.stringify(openPlatformWhenNeeded === undefined ? null : openPlatformWhenNeeded)} };`,
    `let matchResult = ${JSON.stringify(matchResult)};`,
    `let loadOutcome = ${JSON.stringify(loadOutcome)};`,
    `let consentAccepted = ${JSON.stringify(consentAccepted)};`,
    `let bindingForQueue = ${JSON.stringify(bindingForResults)};`,
    // Test-only stand-ins for the rest of the worker. Each is called exactly as openPlatform,
    // bindingForCommand and the router call the real one; only the body differs.
    // A missing key (fixture.openPlatformWhenNeeded === null, the "not set in this fixture" marker)
    // is left out of the returned object, the same shape chrome.storage.local.get gives for an
    // unset key, so bindingForCommand's default-on check exercises the real "missing key" path.
    "async function storage() { return { siteAnchors: fixture.anchors, bindings: fixture.bindings, ...(fixture.openPlatformWhenNeeded === null ? {} : { openPlatformWhenNeeded: fixture.openPlatformWhenNeeded }) }; }",
    "async function publishBindings() { calls.publishBindings += 1; }",
    "async function siteAnchorMatches(anchor, options) { calls.siteAnchorMatches.push({ siteAnchorId: anchor?.siteAnchorId, options }); return matchResult; }",
    "async function requireCourseDataConsent() { if (!consentAccepted) throw new Error('course_data_consent_required'); }",
    "async function bindingFor(sourceBindingId, options) { calls.bindingFor.push({ sourceBindingId, options }); return bindingForQueue.length > 1 ? bindingForQueue.shift() : bindingForQueue[0]; }",
    "const OPEN_PLATFORM_LOAD_TIMEOUT_MS = 40;", // WORKER_SOURCE pins the real 20_000ms budget; this test uses a short one.
    STORED_ANCHORS_SOURCE,
    MESSAGE_CODE_SOURCE,
    HANDLER_SOURCE,
    "let nextTabId = 1;",
    "let onUpdatedListeners = [];",
    "let routerListener = null;",
    "globalThis.chrome = {",
    "  tabs: {",
    "    create: async ({ url, active }) => {",
    "      const tab = { id: nextTabId++, url, active };",
    "      calls.tabsCreated.push({ url, active });",
    "      if (loadOutcome === 'complete') {",
    "        queueMicrotask(() => { for (const listener of [...onUpdatedListeners]) listener(tab.id, { status: 'complete' }); });",
    "      }",
    "      return tab;",
    "    },",
    "    update: async (tabId, changes) => { calls.tabsUpdated.push({ tabId, changes }); return { id: tabId, ...changes }; },",
    "    onUpdated: {",
    "      addListener: (listener) => onUpdatedListeners.push(listener),",
    "      removeListener: (listener) => { onUpdatedListeners = onUpdatedListeners.filter((entry) => entry !== listener); },",
    "    },",
    "  },",
    "  storage: { local: { set: async (values) => { calls.storageSet.push(values); } } },",
    "  runtime: { onMessage: { addListener: (listener) => { routerListener = listener; } } },",
    "};",
    ROUTER_SOURCE,
    "return {",
    "  calls,",
    "  dispatch: (message, sender = {}) => new Promise((resolve) => { routerListener(message, sender, resolve); }),",
    "  bindingForCommand: (command, operation) => bindingForCommand(command, operation),",
    "};",
    "})();",
  ].join("\n");
  runInThisContext(script, { filename: "service-worker-open-platform-region.js" });
  const value = globalThis.__morrowOpenPlatformHarness;
  delete globalThis.__morrowOpenPlatformHarness;
  // globalThis.chrome stays: openPlatform reads it lazily, on the dispatch a caller still awaits
  // after this call returns. The next harness() call replaces it before its own first dispatch.
  return value;
}

const ANCHOR = { siteAnchorId: "canvas:account:g1", provider: "canvas", origin: "https://school.instructure.com", principalId: "p1" };
const MOODLE_ANCHOR = { siteAnchorId: "moodle:site:m1", provider: "moodle", origin: "https://moodle.school.edu", siteUrl: "https://moodle.school.edu/", principalId: "p2" };
const BINDING = { sourceBindingId: "canvas:account:g1:c42", siteAnchorId: "canvas:account:g1", courseId: "42" };
const MOODLE_BINDING = { sourceBindingId: "moodle:site:m1:c9", siteAnchorId: "moodle:site:m1", courseId: "9" };

test("morrow_open_platform makes one tab, then calls publishBindings after the load", async () => {
  const harness1 = harness({ anchors: [ANCHOR], bindings: [BINDING] });
  const response = await harness1.dispatch({ type: "morrow_open_platform", siteAnchorId: ANCHOR.siteAnchorId, sourceBindingId: BINDING.sourceBindingId });
  assert.deepEqual(response, { ok: true, result: { opened: true, verified: true } });
  assert.equal(harness1.calls.tabsCreated.length, 1, "exactly one tab");
  assert.deepEqual(harness1.calls.tabsCreated[0], { url: "https://school.instructure.com/courses/42", active: false });
  assert.equal(harness1.calls.publishBindings, 1);
  assert.equal(harness1.calls.tabsUpdated.length, 0, "a verified anchor is not made active");
});

test("with no binding, the Canvas address is the site root, not a course", async () => {
  const harness1 = harness({ anchors: [ANCHOR] });
  const response = await harness1.dispatch({ type: "morrow_open_platform", siteAnchorId: ANCHOR.siteAnchorId });
  assert.equal(response.ok, true);
  assert.equal(harness1.calls.tabsCreated[0].url, "https://school.instructure.com/");
});

test("a Moodle anchor with a binding opens course/view.php", async () => {
  const harness1 = harness({ anchors: [MOODLE_ANCHOR], bindings: [MOODLE_BINDING] });
  await harness1.dispatch({ type: "morrow_open_platform", siteAnchorId: MOODLE_ANCHOR.siteAnchorId, sourceBindingId: MOODLE_BINDING.sourceBindingId });
  assert.equal(harness1.calls.tabsCreated[0].url, "https://moodle.school.edu/course/view.php?id=9");
});

test("a Moodle anchor with no binding opens the site URL", async () => {
  const harness1 = harness({ anchors: [MOODLE_ANCHOR] });
  await harness1.dispatch({ type: "morrow_open_platform", siteAnchorId: MOODLE_ANCHOR.siteAnchorId });
  assert.equal(harness1.calls.tabsCreated[0].url, "https://moodle.school.edu/");
});

test("the address never comes from the page message", async () => {
  const harness1 = harness({ anchors: [ANCHOR], bindings: [BINDING] });
  await harness1.dispatch({
    type: "morrow_open_platform",
    siteAnchorId: ANCHOR.siteAnchorId,
    sourceBindingId: BINDING.sourceBindingId,
    url: "https://evil.example/take-over",
    origin: "https://evil.example",
  });
  assert.equal(harness1.calls.tabsCreated[0].url, "https://school.instructure.com/courses/42");
});

test("a binding for a different site is ignored, not mixed into the address", async () => {
  const harness1 = harness({ anchors: [ANCHOR], bindings: [MOODLE_BINDING] });
  await harness1.dispatch({ type: "morrow_open_platform", siteAnchorId: ANCHOR.siteAnchorId, sourceBindingId: MOODLE_BINDING.sourceBindingId });
  assert.equal(harness1.calls.tabsCreated[0].url, "https://school.instructure.com/", "the mismatched binding's courseId is not used");
});

test("a missing anchor raises platform_open_anchor_missing and opens no tab", async () => {
  const harness1 = harness({ anchors: [] });
  const response = await harness1.dispatch({ type: "morrow_open_platform", siteAnchorId: "gone" });
  assert.deepEqual(response, { ok: false, code: "platform_open_anchor_missing", error: "platform_open_anchor_missing" });
  assert.equal(harness1.calls.tabsCreated.length, 0);
});

test("an unverified anchor after the load is made active so the person can sign in", async () => {
  const harness1 = harness({ anchors: [ANCHOR], bindings: [BINDING], matchResult: false });
  const response = await harness1.dispatch({ type: "morrow_open_platform", siteAnchorId: ANCHOR.siteAnchorId, sourceBindingId: BINDING.sourceBindingId });
  assert.deepEqual(response.result, { opened: true, verified: false });
  assert.deepEqual(harness1.calls.tabsUpdated, [{ tabId: 1, changes: { active: true } }]);
});

test("a load that never completes still finishes: publishBindings runs after the wait", async () => {
  const harness1 = harness({ anchors: [ANCHOR], bindings: [BINDING], loadOutcome: "never" });
  const response = await harness1.dispatch({ type: "morrow_open_platform", siteAnchorId: ANCHOR.siteAnchorId, sourceBindingId: BINDING.sourceBindingId });
  assert.equal(response.ok, true);
  assert.equal(harness1.calls.publishBindings, 1);
});

test("morrow_open_platform requires course data consent, like the other course-reading messages", async () => {
  const harness1 = harness({ anchors: [ANCHOR], bindings: [BINDING], consentAccepted: false });
  const response = await harness1.dispatch({ type: "morrow_open_platform", siteAnchorId: ANCHOR.siteAnchorId, sourceBindingId: BINDING.sourceBindingId });
  assert.deepEqual(response, { ok: false, code: "course_data_consent_required", error: "course_data_consent_required" });
  assert.equal(harness1.calls.tabsCreated.length, 0, "no tab opens before consent is confirmed");
});

test("morrow_open_platform is not restricted to the settings-page sender", async () => {
  const harness1 = harness({ anchors: [ANCHOR], bindings: [BINDING] });
  const response = await harness1.dispatch({ type: "morrow_open_platform", siteAnchorId: ANCHOR.siteAnchorId, sourceBindingId: BINDING.sourceBindingId }, { id: "some-other-id", url: undefined });
  assert.equal(response.ok, true, "the popup and the setup guide send this message too, not only Plan and Edit settings");
});

/**
 * WI-1.2 (D1a): a command whose binding has no signed-in site tab. bindingForCommand is the piece
 * of commandContext that opens the platform once and reads the binding again before the command
 * fails with canvas_binding_required.
 */
const UNVERIFIED_BINDING = { sourceBindingId: BINDING.sourceBindingId, siteAnchorId: ANCHOR.siteAnchorId, provider: "canvas", runtimeVerified: false };
const VERIFIED_BINDING = { sourceBindingId: BINDING.sourceBindingId, siteAnchorId: ANCHOR.siteAnchorId, provider: "canvas", runtimeVerified: true };
const READ_COMMAND = { sourceBindingId: BINDING.sourceBindingId, kind: "invoke_read" };
const CANVAS_OPERATION = { provider: "canvas" };

test("setting on, one tab and one retry: openPlatform runs once, then the binding is read again", async () => {
  const harness1 = harness({
    anchors: [ANCHOR],
    bindings: [BINDING],
    openPlatformWhenNeeded: true,
    bindingForResults: [UNVERIFIED_BINDING, VERIFIED_BINDING],
  });
  const result = await harness1.bindingForCommand(READ_COMMAND, CANVAS_OPERATION);
  assert.deepEqual(result, VERIFIED_BINDING, "the retried, now-verified binding is returned");
  assert.equal(harness1.calls.tabsCreated.length, 1, "openPlatform opens exactly one tab");
  assert.equal(harness1.calls.bindingFor.length, 2, "the binding is read once before, once after the retry");
  assert.equal(harness1.calls.storageSet.length, 1, "the popup notice is recorded once");
  assert.equal(harness1.calls.storageSet[0].openPlatformNotice.provider, "canvas");
});

test("a missing openPlatformWhenNeeded key defaults to on, the same as setting it true", async () => {
  const harness1 = harness({
    anchors: [ANCHOR],
    bindings: [BINDING],
    bindingForResults: [UNVERIFIED_BINDING, VERIFIED_BINDING],
    // openPlatformWhenNeeded omitted: storage() returns no such key, as chrome.storage.local.get
    // does for a key never written.
  });
  const result = await harness1.bindingForCommand(READ_COMMAND, CANVAS_OPERATION);
  assert.deepEqual(result, VERIFIED_BINDING);
  assert.equal(harness1.calls.tabsCreated.length, 1, "a missing key means on (WI-1.2)");
});

test("setting off, no tab: bindingForCommand returns the unverified binding without opening one", async () => {
  const harness1 = harness({
    anchors: [ANCHOR],
    bindings: [BINDING],
    openPlatformWhenNeeded: false,
    bindingForResults: [UNVERIFIED_BINDING],
  });
  const result = await harness1.bindingForCommand(READ_COMMAND, CANVAS_OPERATION);
  assert.deepEqual(result, UNVERIFIED_BINDING);
  assert.equal(harness1.calls.tabsCreated.length, 0, "the setting being off opens no tab");
  assert.equal(harness1.calls.bindingFor.length, 1, "no second read: there is nothing to retry");
  assert.equal(harness1.calls.storageSet.length, 0, "no notice for a tab that never opened");
});

test("no tab when one for the site exists: an already-verified binding is returned as read", async () => {
  const harness1 = harness({
    anchors: [ANCHOR],
    bindings: [BINDING],
    openPlatformWhenNeeded: true,
    bindingForResults: [VERIFIED_BINDING],
  });
  const result = await harness1.bindingForCommand(READ_COMMAND, CANVAS_OPERATION);
  assert.deepEqual(result, VERIFIED_BINDING);
  assert.equal(harness1.calls.tabsCreated.length, 0, "a site tab that already matches is left alone (D1a)");
  assert.equal(harness1.calls.bindingFor.length, 1, "the setting is on, but nothing needed opening");
});

test("a binding with no saved site (no siteAnchorId) is returned as read, never opened", async () => {
  const harness1 = harness({
    anchors: [ANCHOR],
    bindings: [BINDING],
    openPlatformWhenNeeded: true,
    bindingForResults: [{ sourceBindingId: BINDING.sourceBindingId, siteAnchorId: null, provider: "canvas", runtimeVerified: false }],
  });
  const result = await harness1.bindingForCommand(READ_COMMAND, CANVAS_OPERATION);
  assert.equal(result.siteAnchorId, null);
  assert.equal(harness1.calls.tabsCreated.length, 0, "nothing to open for a course with no saved connection");
});

test("a provider mismatch is returned as read, never opened: this retry answers only a closed tab", async () => {
  const harness1 = harness({
    anchors: [ANCHOR],
    bindings: [BINDING],
    openPlatformWhenNeeded: true,
    bindingForResults: [{ ...UNVERIFIED_BINDING, provider: "moodle" }],
  });
  const result = await harness1.bindingForCommand(READ_COMMAND, CANVAS_OPERATION);
  assert.equal(result.provider, "moodle");
  assert.equal(harness1.calls.tabsCreated.length, 0);
});

test("openPlatform's own failure (a gone anchor) is absorbed: the original binding is returned, not thrown", async () => {
  const harness1 = harness({
    anchors: [], // ANCHOR is not stored, so openPlatform throws platform_open_anchor_missing.
    bindings: [BINDING],
    openPlatformWhenNeeded: true,
    bindingForResults: [UNVERIFIED_BINDING],
  });
  const result = await harness1.bindingForCommand(READ_COMMAND, CANVAS_OPERATION);
  assert.deepEqual(result, UNVERIFIED_BINDING, "the caller still gets a binding, and reports canvas_binding_required as before");
  assert.equal(harness1.calls.tabsCreated.length, 0);
  assert.equal(harness1.calls.bindingFor.length, 1, "no retry read: the open itself never happened");
});
