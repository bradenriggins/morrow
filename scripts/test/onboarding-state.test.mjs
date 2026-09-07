import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { problemCode, problemCopy, problemText } from "../../connector/extension/src/bridge-problem-copy.js";
import {
  SETUP_CHECK_IDS,
  SETUP_MODE_KEY,
  setupGuideState,
  shouldRefreshForStorageChange,
} from "../../connector/extension/onboarding/onboarding-state.js";

// One recorded read, as connector/extension/src/service-worker.js writes it after an invoke_read
// that returned ok.
const FIRST_READ = Object.freeze({
  provider: "canvas",
  origin: "https://canvas.example",
  courseId: "42",
  courseName: "Biology 101",
  at: 1_700_000_000_000,
});

const READY_STATUS = Object.freeze({
  paired: true,
  pairing: false,
  connecting: false,
  connected: true,
  runtimeHealthy: true,
  bindings: [{ runtimeVerified: true }],
  siteAnchors: [{ runtimeVerified: true }],
  firstCourseRead: FIRST_READ,
});

const textOf = (state, id) => state.checks.find((check) => check.id === id).text;

test("setup guide prioritizes a live pairing approval over an unpaired state", () => {
  const state = setupGuideState({ pairing: true, paired: false, connected: false, bindings: [], siteAnchors: [] });
  assert.equal(state.title, "Allow connection");
  assert.equal(state.showAssistantGuide, false);
  assert.equal(textOf(state, "assistant"), "An assistant approval is waiting on the Morrow page that opened");
  assert.equal(textOf(state, "connection"), "Morrow Bridge connects after you allow this connection");
});

test("setup guide directs an unpaired Bridge to the graphical Morrow app", () => {
  const state = setupGuideState({ pairing: false, paired: false, connecting: false, connected: false, bindings: [], siteAnchors: [] });
  assert.equal(state.title, "Open Morrow");
  assert.equal(state.showAssistantGuide, true);
  assert.match(state.detail, /choose your assistant/i);
  assert.match(state.detail, /select Connect Morrow/i);
});

test("setup guide distinguishes a closed assistant, signed-out course, Plan selection, and ready course", () => {
  const connected = { paired: true, connected: true, runtimeHealthy: true };
  assert.equal(setupGuideState({ paired: true, connected: false, bindings: [], siteAnchors: [] }).title, "Open Morrow again");
  assert.equal(setupGuideState({ ...connected, bindings: [], siteAnchors: [{ runtimeVerified: false }] }).title, "Reconnect a course site");
  const plan = setupGuideState({ ...connected, bindings: [], siteAnchors: [{ runtimeVerified: true }] });
  assert.equal(plan.title, "Select a course in Plan");
  assert.equal(plan.canOpenSettings, true);
  const ready = setupGuideState(READY_STATUS);
  assert.equal(ready.ready, true);
  assert.equal(ready.title, "Plan your first change");
});

// The five checks are the completion goal: an assistant approved this connection, Morrow matches
// this extension, the connection is open, the selected course is ready, and one course read
// actually happened. Each fixture completes one more of them.
test("the guide reports five checks, and each one is the step it asks for while it is open", () => {
  const site = [{ runtimeVerified: true }];
  const ladder = [
    ["assistant", { paired: false, connected: false, bindings: [], siteAnchors: [] }],
    ["connection", { paired: true, connected: false, bindings: [], siteAnchors: [] }],
    ["runtime", { paired: true, connected: true, runtimeHealthy: false, bindings: [], siteAnchors: [] }],
    ["course", { paired: true, connected: true, runtimeHealthy: true, bindings: [], siteAnchors: site }],
    ["read", { paired: true, connected: true, runtimeHealthy: true, bindings: [{ runtimeVerified: true }], siteAnchors: site }],
    ["", READY_STATUS],
  ];
  for (const [open, status] of ladder) {
    const state = setupGuideState(status);
    const done = SETUP_CHECK_IDS.map((id) => (open === "" ? true : SETUP_CHECK_IDS.indexOf(id) < SETUP_CHECK_IDS.indexOf(open)));
    assert.deepEqual(state.checks.map((check) => check.id), [...SETUP_CHECK_IDS], open);
    assert.deepEqual(state.checks.map((check) => check.done), done, open);
    assert.equal(state.open, open, open);
    assert.equal(state.ready, open === "", open);
  }
  const ready = setupGuideState(READY_STATUS);
  assert.deepEqual(ready.checks.map((check) => check.text), [
    "An assistant approved this connection in Morrow. Morrow Bridge sees the connection, not the assistant itself.",
    "Morrow Bridge is connected to Morrow",
    "Morrow matches this Morrow Bridge version and its list of course actions",
    "1 selected course is ready",
    "First read completed in Biology 101",
  ]);
});

// Morrow Bridge cannot see the assistant window. It sees the connection an assistant approved, and
// the line says exactly that rather than reporting a running assistant it never checked.
test("the assistant check states that it reports this connection, not the assistant itself", () => {
  const paired = textOf(setupGuideState({ paired: true, connected: false, bindings: [], siteAnchors: [] }), "assistant");
  assert.match(paired, /approved this connection in Morrow/);
  assert.match(paired, /sees the connection, not the assistant itself/);
  assert.equal(textOf(setupGuideState({ paired: false, connected: false, bindings: [], siteAnchors: [] }), "assistant"),
    "No assistant has approved this connection yet");
});

// A connection is not a version match. Morrow names the connector identity it accepted, and an
// answer that does not match this extension is a state with its own next action.
test("the version check separates a matching Morrow from one this connection cannot confirm", () => {
  const connected = { paired: true, connected: true, bindings: [{ runtimeVerified: true }], siteAnchors: [{ runtimeVerified: true }], firstCourseRead: FIRST_READ };
  const mismatch = setupGuideState({ ...connected, runtimeHealthy: false });
  assert.equal(mismatch.ready, false);
  assert.equal(mismatch.heading, "Morrow needs a reload");
  assert.equal(mismatch.title, "Reload Morrow Bridge");
  assert.equal(textOf(mismatch, "runtime"), "Morrow reports a different version from this Morrow Bridge");
  assert.match(mismatch.detail, /reload Morrow Bridge on the Chrome extensions page/);
  // Before the connection there is no version result to report, and none is invented.
  assert.equal(textOf(setupGuideState({ paired: true, connected: false, bindings: [], siteAnchors: [] }), "runtime"),
    "Morrow version is checked when Morrow Bridge connects");
  assert.equal(textOf(setupGuideState({ ...connected, runtimeHealthy: true }), "runtime"),
    "Morrow matches this Morrow Bridge version and its list of course actions");
  // A status with no version answer at all is not treated as a match.
  assert.equal(setupGuideState({ ...connected }).ready, false);
});

// "Ready to use" is the claim a person acts on, so only a read that happened can raise it, and the
// line that raises it names the course that was read.
test("Ready to use waits for a recorded course read, and the record names the course", () => {
  const connected = { paired: true, connected: true, runtimeHealthy: true, bindings: [{ runtimeVerified: true }], siteAnchors: [{ runtimeVerified: true }] };
  const waiting = setupGuideState(connected);
  assert.equal(waiting.ready, false);
  assert.equal(waiting.heading, "One step left");
  assert.equal(waiting.summary, "1 selected course is ready in this Chrome session. One read from your assistant completes this setup.");
  assert.equal(waiting.title, "Try a first read");
  assert.equal(textOf(waiting, "read"), "No first read is completed yet");

  const read = setupGuideState({ ...connected, firstCourseRead: FIRST_READ });
  assert.equal(read.ready, true);
  assert.equal(read.heading, "Ready to use");
  assert.equal(read.summary, "1 selected course is ready in this Chrome session. Morrow completed a first read in Biology 101.");
  assert.equal(textOf(read, "read"), "First read completed in Biology 101");

  // A record that cannot name its course completes nothing, and a record that carries only the
  // course id still names that course.
  for (const record of [{}, { courseName: "   " }, { at: 1 }, "read", null]) {
    assert.equal(setupGuideState({ ...connected, firstCourseRead: record }).ready, false, JSON.stringify(record));
  }
  const byId = setupGuideState({ ...connected, firstCourseRead: { provider: "moodle", courseId: "7", at: 1 } });
  assert.equal(byId.ready, true);
  assert.equal(textOf(byId, "read"), "First read completed in course 7");

  // A read is not a substitute for the checks in front of it.
  assert.equal(setupGuideState({ ...connected, connected: false, firstCourseRead: FIRST_READ }).ready, false);
  assert.equal(setupGuideState({ ...connected, bindings: [], firstCourseRead: FIRST_READ }).ready, false);
});

test("setup opens only for a first extension install", async () => {
  const { shouldOpenSetupOnInstall } = await import("../../connector/extension/onboarding/onboarding-install.js");
  assert.equal(shouldOpenSetupOnInstall({ reason: "install" }), true);
  assert.equal(shouldOpenSetupOnInstall({ reason: "update" }), false);
  assert.equal(shouldOpenSetupOnInstall({ reason: "chrome_update" }), false);
  assert.equal(shouldOpenSetupOnInstall({ reason: "shared_module_update" }), false);
});

test("a status the guide could not read states that, instead of keeping the last known lines", () => {
  const ready = setupGuideState(READY_STATUS);
  const unread = setupGuideState(null);
  assert.equal(unread.known, false);
  assert.equal(unread.heading, "Setup state not checked");
  assert.deepEqual(unread.checks.map((check) => check.id), [...SETUP_CHECK_IDS]);
  assert.deepEqual(unread.checks.map((check) => check.text), [
    "Assistant approval is not checked",
    "Morrow Bridge connection is not checked",
    "Morrow version is not checked",
    "Course connection is not checked",
    "First read is not checked",
  ]);
  assert.equal(unread.checks.some((check) => check.done), false);
  assert.equal(unread.title, "Follow the setup steps");
  assert.equal(unread.ready, false);
  assert.equal(unread.readyCourses, 0);
  assert.equal(unread.canOpenSettings, false);
  assert.equal(unread.showAssistantGuide, false);
  for (const line of [unread.heading, unread.summary, unread.title, unread.detail, ...unread.checks.map((check) => check.text)]) {
    assert.doesNotMatch(line, /\bis ready\b|\bare ready\b|Ready to use|completed/, line);
  }
  for (const [index, check] of unread.checks.entries()) assert.notEqual(check.text, ready.checks[index].text, check.id);
  assert.equal(setupGuideState(undefined).known, false);
  assert.equal(setupGuideState("connected").known, false);
  assert.equal(setupGuideState({ paired: true, connected: true, bindings: [], siteAnchors: [] }).known, true);
});

test("each readiness state carries its own words, so the coloured dot is never the only difference", () => {
  const of = (status) => setupGuideState(status);
  const unread = of(null);
  const pending = of({ paired: false, connected: false, bindings: [], siteAnchors: [] });
  const pairing = of({ pairing: true, paired: false, connected: false, bindings: [], siteAnchors: [] });
  const connecting = of({ paired: true, connecting: true, connected: false, bindings: [], siteAnchors: [] });
  const mismatch = of({ paired: true, connected: true, runtimeHealthy: false, bindings: [], siteAnchors: [] });
  const oneLeft = of({ paired: true, connected: true, runtimeHealthy: true, bindings: [{ runtimeVerified: true }], siteAnchors: [{ runtimeVerified: true }] });
  const ready = of(READY_STATUS);
  const states = [unread, pending, pairing, connecting, mismatch, oneLeft, ready];
  assert.deepEqual(states.map((state) => state.tone), ["unread", "pending", "waiting", "waiting", "attention", "pending", "ready"]);
  const headings = states.map((state) => state.heading);
  assert.equal(new Set(headings).size, headings.length, headings.join(" | "));
  assert.equal(pairing.heading, "Waiting for approval");
  assert.equal(connecting.heading, "Connecting Morrow");
  assert.equal(mismatch.heading, "Morrow needs a reload");
  assert.equal(oneLeft.heading, "One step left");
  assert.equal(ready.heading, "Ready to use");
  assert.equal(ready.summary, "1 selected course is ready in this Chrome session. Morrow completed a first read in Biology 101.");
  assert.equal(of({ ...READY_STATUS, bindings: [{ runtimeVerified: true }, { runtimeVerified: true }] }).summary,
    "2 selected courses are ready in this Chrome session. Morrow completed a first read in Biology 101.");
});

// scripts/test/canvas-connector-browser.mjs measures every visible h1 and h2 on this page at 320,
// 390, and 1280px and refuses a heading that wraps. That measurement needs a real browser, so this
// is only a character-count proxy for it: the readiness heading and the guide title both render as
// an h2 at 16px inside a card about 260px wide at 320px.
test("every heading this guide can render is short enough to stay on one line", () => {
  const titles = [
    setupGuideState(null),
    setupGuideState({ paired: false, connected: false, bindings: [], siteAnchors: [] }),
    setupGuideState({ pairing: true, paired: false, connected: false, bindings: [], siteAnchors: [] }),
    setupGuideState({ paired: true, connecting: true, connected: false, bindings: [], siteAnchors: [] }),
    setupGuideState({ paired: true, connected: false, bindings: [], siteAnchors: [] }),
    setupGuideState({ paired: true, connected: true, runtimeHealthy: false, bindings: [], siteAnchors: [] }),
    setupGuideState({ paired: true, connected: true, runtimeHealthy: true, bindings: [], siteAnchors: [] }),
    setupGuideState({ paired: true, connected: true, runtimeHealthy: true, bindings: [], siteAnchors: [{ runtimeVerified: false }] }),
    setupGuideState({ paired: true, connected: true, runtimeHealthy: true, bindings: [], siteAnchors: [{ runtimeVerified: true }] }),
    setupGuideState({ paired: true, connected: true, runtimeHealthy: true, bindings: [{ runtimeVerified: true }], siteAnchors: [{ runtimeVerified: true }] }),
    setupGuideState(READY_STATUS),
  ].flatMap((state) => [state.heading, state.title]);
  const markup = readFileSync(new URL("../../connector/extension/onboarding/onboarding.html", import.meta.url), "utf8");
  for (const [, heading] of markup.matchAll(/<h2[^>]*>([^<]*)<\/h2>/g)) titles.push(heading);
  for (const heading of titles) assert.ok(heading.length <= 28, `${heading} (${heading.length} characters)`);
});

// The guide renders one list item per check id, so a check with no line in the page would be a
// state a person never sees.
test("the page carries one list item for every check the guide reports", () => {
  const markup = readFileSync(new URL("../../connector/extension/onboarding/onboarding.html", import.meta.url), "utf8");
  const rendered = [...markup.matchAll(/<li id="([a-z-]+)-check">([^<]*)<\/li>/g)];
  assert.deepEqual(rendered.map(([, id]) => id), [...SETUP_CHECK_IDS]);
  assert.deepEqual(rendered.map(([, , text]) => text), setupGuideState(null).checks.map((check) => check.text));
});

test("each failure the setup guide can receive names its own state and next action", () => {
  for (const code of ["bridge_extension_unreachable", "bridge_extension_reloaded", "connector_catalog_invalid", "bridge_request_failed"]) {
    assert.equal(problemCopy(code).known, true, code);
  }
  assert.equal(problemCode(new Error("Could not establish connection. Receiving end does not exist.")), "bridge_extension_unreachable");
  assert.equal(problemCode(new Error("The message port closed before a response was received.")), "bridge_extension_unreachable");
  assert.equal(problemCode(new Error("Extension context invalidated.")), "bridge_extension_reloaded");
  assert.match(problemText("bridge_extension_unreachable"), /not answering in Chrome/);
  assert.match(problemText("bridge_extension_reloaded"), /Reload this page/);
  assert.match(problemText("connector_catalog_invalid"), /Reload Morrow Bridge on the Chrome extensions page/);
  // A cause with no code of its own is the one failure Morrow Bridge cannot name.
  assert.equal(problemCode(new Error("Morrow could not complete this request.")), "bridge_request_failed");
  assert.equal(problemCode(new Error("toString")), "bridge_request_failed");
  assert.equal(problemCode(null), "bridge_request_failed");
});

// morrow_status answers with a code, and this guide reads its words from that code. If this fails,
// the state the guide explains is no longer one the service worker raises. The same answer carries
// the version result and the recorded read the checks above read; scripts/test/
// canvas-connector-browser.mjs proves both against a real Chrome and a real Morrow.
test("every setup-guide failure code still exists in the service worker", () => {
  const worker = readFileSync(new URL("../../connector/extension/src/service-worker.js", import.meta.url), "utf8");
  for (const code of ["connector_catalog_invalid", "bridge_request_failed"]) assert.ok(worker.includes(`"${code}"`), code);
  for (const field of ["runtimeHealthy", "firstCourseRead"]) assert.ok(worker.includes(field), field);
});

test("a guide-mode write does not ask for the status it cannot change", () => {
  assert.equal(shouldRefreshForStorageChange({ [SETUP_MODE_KEY]: { newValue: "quick" } }, "local"), false);
  assert.equal(shouldRefreshForStorageChange({}, "local"), false);
  assert.equal(shouldRefreshForStorageChange(undefined, "local"), false);
  assert.equal(shouldRefreshForStorageChange({ bindings: { newValue: [] } }, "local"), true);
  assert.equal(shouldRefreshForStorageChange({ firstCourseRead: { newValue: {} } }, "local"), true);
  assert.equal(shouldRefreshForStorageChange({ [SETUP_MODE_KEY]: {}, token: {} }, "local"), true);
  assert.equal(shouldRefreshForStorageChange({ bindings: { newValue: [] } }, "session"), false);
  assert.equal(shouldRefreshForStorageChange({ bindings: { newValue: [] } }, "sync"), false);
});

// onboarding.js is loaded once, against a small stub of the globals it uses, because the stale-state
// defect and the refresh storm both live in the wiring rather than in the pure module.
function stubElement(text = "", hidden = false) {
  const classes = new Set();
  return {
    textContent: text,
    hidden,
    classes,
    attributes: {},
    listeners: {},
    classList: { toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)) },
    setAttribute(name, value) { this.attributes[name] = value; },
    addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); },
  };
}

test("the setup guide answers a failed status read with an unknown checklist, then clears it", async () => {
  const nodes = {
    "#guide-mode": stubElement("Guide me"),
    "#quick-mode": stubElement("All steps"),
    "#guide-panel": stubElement(),
    "#quick-panel": stubElement("", true),
    "#readiness-title": stubElement("Checking setup"),
    "#readiness-detail": stubElement("Morrow is checking this connection."),
    "#assistant-check": stubElement("Assistant approval is not checked"),
    "#connection-check": stubElement("Morrow Bridge connection is not checked"),
    "#runtime-check": stubElement("Morrow version is not checked"),
    "#course-check": stubElement("Course connection is not checked"),
    "#read-check": stubElement("First read is not checked"),
    "#status-dot": stubElement(),
    "#next-title": stubElement("Open Morrow"),
    "#next-detail": stubElement("Open Morrow, choose your assistant, then return to Morrow Bridge."),
    "#open-settings": stubElement("Open Plan and Edit settings", true),
    "#guide-assistant": stubElement(),
    "#quick-open-settings": stubElement("Open Plan and Edit settings"),
    "#error": stubElement("", true),
  };
  const requests = [];
  const storageListeners = [];
  let respond = async () => { throw new Error("Extension context invalidated."); };
  const warn = console.warn;
  console.warn = () => {};
  globalThis.document = { hidden: false, querySelector: (selector) => nodes[selector] || null, addEventListener() {} };
  globalThis.window = { addEventListener() {} };
  globalThis.chrome = {
    runtime: {
      sendMessage: (request) => { requests.push(request.type); return respond(request); },
      onMessage: { addListener() {} },
      openOptionsPage() {},
    },
    storage: {
      local: { get: async () => ({}), set: async () => undefined },
      onChanged: { addListener: (handler) => storageListeners.push(handler) },
    },
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 400));
  try {
    await import("../../connector/extension/onboarding/onboarding.js");
    assert.deepEqual(requests, ["morrow_status"]);
    assert.equal(nodes["#readiness-title"].textContent, "Setup state not checked");
    assert.equal(nodes["#assistant-check"].textContent, "Assistant approval is not checked");
    assert.equal(nodes["#connection-check"].textContent, "Morrow Bridge connection is not checked");
    assert.equal(nodes["#runtime-check"].textContent, "Morrow version is not checked");
    assert.equal(nodes["#course-check"].textContent, "Course connection is not checked");
    assert.equal(nodes["#read-check"].textContent, "First read is not checked");
    assert.equal(nodes["#next-title"].textContent, "Follow the setup steps");
    assert.equal(nodes["#status-dot"].classes.has("ready"), false);
    assert.equal(nodes["#status-dot"].classes.has("waiting"), false);
    assert.equal(nodes["#error"].hidden, false);
    assert.equal(nodes["#error"].textContent, problemText("bridge_extension_reloaded"));
    assert.equal(storageListeners.length, 1);

    // A guide-mode write is this page's own, and it changes no connection state.
    storageListeners[0]({ [SETUP_MODE_KEY]: { newValue: "quick" } }, "local");
    await settle();
    assert.deepEqual(requests, ["morrow_status"]);

    // A connected Morrow with a ready course is still one read short of "Ready to use".
    respond = async () => ({
      ok: true,
      result: { paired: true, pairing: false, connecting: false, connected: true, runtimeHealthy: true, bindings: [{ runtimeVerified: true }], siteAnchors: [{ runtimeVerified: true }] },
    });
    for (let index = 0; index < 4; index += 1) storageListeners[0]({ bindings: { newValue: [] } }, "local");
    await settle();
    assert.deepEqual(requests, ["morrow_status", "morrow_status"]);
    assert.equal(nodes["#readiness-title"].textContent, "One step left");
    assert.equal(nodes["#read-check"].textContent, "No first read is completed yet");
    assert.equal(nodes["#next-title"].textContent, "Try a first read");
    assert.equal(nodes["#status-dot"].classes.has("ready"), false);

    // The recorded read is what raises "Ready to use", and it names the course it read.
    respond = async () => ({ ok: true, result: { ...READY_STATUS } });
    storageListeners[0]({ firstCourseRead: { newValue: FIRST_READ } }, "local");
    await settle();
    assert.deepEqual(requests, ["morrow_status", "morrow_status", "morrow_status"]);
    assert.equal(nodes["#readiness-title"].textContent, "Ready to use");
    assert.equal(nodes["#readiness-detail"].textContent, "1 selected course is ready in this Chrome session. Morrow completed a first read in Biology 101.");
    assert.equal(nodes["#assistant-check"].textContent, "An assistant approved this connection in Morrow. Morrow Bridge sees the connection, not the assistant itself.");
    assert.equal(nodes["#connection-check"].textContent, "Morrow Bridge is connected to Morrow");
    assert.equal(nodes["#runtime-check"].textContent, "Morrow matches this Morrow Bridge version and its list of course actions");
    assert.equal(nodes["#course-check"].textContent, "1 selected course is ready");
    assert.equal(nodes["#read-check"].textContent, "First read completed in Biology 101");
    assert.equal(nodes["#status-dot"].classes.has("ready"), true);
    assert.equal(nodes["#error"].hidden, true);
    assert.equal(nodes["#error"].textContent, "");

    // A later failure states the new cause and drops the state it can no longer read.
    respond = async () => ({ ok: false, error: "connector_catalog_invalid" });
    storageListeners[0]({ bindings: { newValue: [] } }, "local");
    await settle();
    assert.deepEqual(requests, ["morrow_status", "morrow_status", "morrow_status", "morrow_status"]);
    assert.equal(nodes["#error"].textContent, problemText("connector_catalog_invalid"));
    assert.equal(nodes["#readiness-title"].textContent, "Setup state not checked");
    assert.equal(nodes["#course-check"].textContent, "Course connection is not checked");
    assert.equal(nodes["#read-check"].textContent, "First read is not checked");
    assert.equal(nodes["#status-dot"].classes.has("ready"), false);

    // A status read reaches the course tab, so a slow one can still be open when the next starts.
    // The later answer stands, and the earlier one never replaces it.
    let release = () => {};
    const slow = new Promise((resolve) => { release = resolve; });
    respond = async () => {
      const first = requests.filter((type) => type === "morrow_status").length === 5;
      if (first) await slow;
      return {
        ok: true,
        result: first
          ? { paired: true, connected: true, runtimeHealthy: true, bindings: [], siteAnchors: [] }
          : { ...READY_STATUS },
      };
    };
    storageListeners[0]({ bindings: { newValue: [] } }, "local");
    await new Promise((resolve) => setTimeout(resolve, 300));
    storageListeners[0]({ token: { newValue: "t" } }, "local");
    await settle();
    release();
    await settle();
    assert.equal(requests.filter((type) => type === "morrow_status").length, 6);
    assert.equal(nodes["#readiness-title"].textContent, "Ready to use");
    assert.equal(nodes["#course-check"].textContent, "1 selected course is ready");
    assert.equal(nodes["#read-check"].textContent, "First read completed in Biology 101");
  } finally {
    console.warn = warn;
    delete globalThis.document;
    delete globalThis.window;
    delete globalThis.chrome;
  }
});
