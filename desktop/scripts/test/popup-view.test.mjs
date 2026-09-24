import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PROBLEM_CODES, problemCopy, problemText } from "../../connector/extension/src/bridge-problem-copy.js";
import { CURATED_CATEGORY_SPECS } from "../../connector/extension/src/edit-policy.js";
import {
  activeEditBindings,
  canChooseCourses,
  connectedCourseRows,
  controlState,
  courseStateText,
  courseValue,
  detailText,
  nextError,
  pendingReviews,
  primaryAction,
  primaryLabel,
  reviewButtonLabel,
  runtimeNeedsReload,
  statusAnnouncement,
  statusValue,
} from "../../connector/extension/popup/popup-view.js";

const anchor = (fields = {}) => ({ provider: "canvas", runtimeVerified: true, lastSeenAt: 1, ...fields });
const binding = (fields = {}) => ({ courseName: "Biology 101", runtimeVerified: true, lastSeenAt: 1, ...fields });
const statuses = [
  null,
  { paired: false, pairing: false, connecting: false, connected: false, bindings: [], siteAnchors: [] },
  { paired: false, pairing: true, connecting: false, connected: false, bindings: [], siteAnchors: [] },
  { paired: true, pairing: false, connecting: true, connected: false, bindings: [], siteAnchors: [] },
  { paired: true, pairing: false, connecting: false, connected: false, bindings: [], siteAnchors: [] },
  { paired: true, pairing: false, connecting: false, connected: false, authenticationFailed: true, bindings: [binding()], siteAnchors: [anchor()], bindingCount: 1 },
  { paired: true, pairing: false, connecting: false, connected: true, runtimeHealthy: true, bindings: [], siteAnchors: [] },
  { paired: true, pairing: false, connecting: false, connected: true, runtimeHealthy: true, bindings: [], siteAnchors: [anchor()] },
  { paired: true, pairing: false, connecting: false, connected: true, runtimeHealthy: true, bindings: [], siteAnchors: [anchor({ runtimeVerified: false })] },
  { paired: true, pairing: false, connecting: false, connected: true, runtimeHealthy: true, bindings: [binding()], siteAnchors: [anchor()], bindingCount: 1 },
  { paired: true, pairing: false, connecting: false, connected: true, runtimeHealthy: true, bindings: [binding({ runtimeVerified: false })], siteAnchors: [anchor()], bindingCount: 1 },
];

// The primary button's words and what a click on it does come from one decision, so a label can
// never promise one step while the click takes another.
test("every primary label names the one action a click on it takes", () => {
  const actionFor = { "Try again": "retry", "Open setup guide": "open_setup", "Reconnect Morrow": "pair",
    "Connect Morrow": "pair", "Choose courses": "choose_courses", "Waiting for your assistant": "wait", "Connect this course": "connect_course", "": "none" };
  const cases = [
    ...statuses.map((status) => [status, null]),
    ...statuses.map((status) => [status, "canvas"]),
    [{ paired: true, pairing: true, authenticationFailed: false, connected: false, bindings: [], siteAnchors: [] }, "canvas"],
    [{ paired: true, pairing: true, authenticationFailed: true, connected: false, bindings: [], siteAnchors: [] }, null],
    [{ ...statuses[9], runtimeHealthy: false }, "canvas"],
  ];
  for (const [status, detected] of cases) {
    const action = primaryAction(status, detected);
    assert.equal(action.label, primaryLabel(status, detected), JSON.stringify(status));
    assert.equal(action.id, actionFor[action.label], `${action.label}: ${JSON.stringify(status)}`);
  }
  // Connect Morrow pairs in one step, so no status ever waits on an approval page. A status that
  // still carries an older pairing flag is read by its other fields alone.
  assert.equal(primaryAction({ paired: true, pairing: true, connected: false, bindings: [], siteAnchors: [] }, "canvas").id, "wait");
});

test("a connected socket with an unhealthy runtime asks for a Bridge reload", () => {
  const status = { ...statuses[9], runtimeHealthy: false };
  assert.equal(runtimeNeedsReload(status), true);
  assert.equal(statusValue(status), "Reload needed");
  assert.equal(courseValue(status), "Not available");
  assert.equal(primaryLabel(status), "Open setup guide");
  assert.equal(canChooseCourses(status), false);
  assert.equal(controlState(status).primaryDisabled, false);
  assert.match(detailText(status), /versions do not match/i);
  assert.match(detailText(status), /reload Morrow Bridge/i);
});

// Morrow closes a connection from a Bridge build it does not expect with its own reason. A new
// connection approval cannot fix that; an update and a reload can.
test("a Morrow that refused this Bridge version asks for a Bridge reload, not a new connection", () => {
  const status = { paired: true, pairing: false, connecting: false, connected: false, authenticationFailed: false, versionMismatch: true, runtimeHealthy: false, bindings: [binding()], siteAnchors: [anchor()], bindingCount: 1 };
  assert.equal(runtimeNeedsReload(status), true);
  assert.equal(statusValue(status), "Reload needed");
  assert.equal(courseValue(status), "Not available");
  assert.equal(primaryLabel(status), "Open setup guide");
  assert.equal(controlState(status).primaryDisabled, false);
  assert.match(detailText(status), /versions do not match/i);
  assert.doesNotMatch(detailText(status), /Reconnect Morrow|approve the new connection/);
});

test("a refused server identity offers re-pairing without discarding selected courses", () => {
  const status = statuses[5];
  assert.equal(statusValue(status), "Reconnect needed");
  assert.equal(courseValue(status), "Saved");
  assert.equal(primaryLabel(status), "Reconnect Morrow");
  assert.equal(controlState(status).primaryDisabled, false);
  assert.match(detailText(status), /selected courses stay saved/i);
});

test("a failed status read renders a definite state with a usable retry", () => {
  assert.equal(statusValue(null), "Not checked");
  assert.equal(courseValue(null), "Not checked");
  assert.equal(primaryLabel(null), "Try again");
  assert.doesNotMatch(detailText(null), /Checking/i);
  assert.match(detailText(null), /Select Try again/);
  const controls = controlState(null, { actionInFlight: false });
  assert.equal(controls.primaryDisabled, false);
  assert.equal(controls.primaryBusy, false);
  assert.equal(controls.secondaryDisabled, true);
  assert.equal(controlState(null, { actionInFlight: true }).primaryDisabled, true);
});

test("a successful status read clears the message a failed status read left", () => {
  const failed = nextError(null, { source: "status", cause: new Error("bridge_not_connected") });
  assert.equal(failed.code, "bridge_not_connected");
  assert.match(problemText(failed.code), /Open the Morrow app/);
  assert.equal(nextError(failed, { source: "status" }), null);
});

test("a failed action keeps its message until the next action, because a background refresh is not its answer", () => {
  const denied = nextError(null, { source: "action", cause: new Error("course_permission_denied") });
  assert.equal(denied.source, "action");
  assert.equal(denied.code, "course_permission_denied");
  assert.equal(nextError(denied, { source: "status" }), denied);
  assert.equal(nextError(denied, { source: "action" }), null);
  const readFailed = nextError(denied, { source: "status", cause: new Error("boom") });
  // A state name Morrow Bridge does not explain is carried, not replaced: the banner shows it.
  assert.equal(readFailed.code, "boom");
  assert.ok(problemText(readFailed.code).includes("boom"));
});

test("each failure the popup can receive names its own state, and only an unnamed one falls back", () => {
  for (const code of ["bridge_not_connected", "bridge_version_mismatch", "course_tab_missing", "course_site_access_required",
    "course_sign_in_required", "course_permission_denied", "course_permission_prompt_missing", "blackboard_browser_unsupported"]) {
    assert.equal(problemCopy(code).known, true, code);
  }
  assert.equal(nextError(null, { source: "action", cause: "course_permission_denied" }).code, "course_permission_denied");
  assert.equal(nextError(null, { source: "action", cause: new Error("edit_policy_binding_stale") }).code, "edit_policy_binding_stale");
  assert.equal(nextError(null, { source: "status", cause: null }), null);
  assert.equal(nextError(null, { source: "status", cause: new Error("Morrow could not complete this request.") }).code, "bridge_request_failed");
  // Chrome's own text for an unreachable extension is named rather than shown as it arrives.
  assert.equal(nextError(null, { source: "status", cause: new Error("Could not establish connection. Receiving end does not exist.") }).code, "bridge_extension_unreachable");
});

// WI-2.4 (D1b): the reviews that wait, as the runtime's ui_state command leaves them in the Bridge.
test("pendingReviews keeps only well-formed entries, and reviewButtonLabel names the change", () => {
  assert.deepEqual(pendingReviews(null), []);
  assert.deepEqual(pendingReviews({}), []);
  assert.deepEqual(pendingReviews({ connected: true, reviews: [] }), []);
  const good = { url: "http://127.0.0.1:9/operations/op-1", label: "Update due date in Anatomy" };
  assert.deepEqual(pendingReviews({ connected: true, reviews: [good, { url: 4, label: "bad url type" }, { label: "no url" }, null] }), [good]);
  // A review belongs to the Morrow connection that sent it, so none shows once Morrow is not connected.
  assert.deepEqual(pendingReviews({ connected: false, paired: false, reviews: [good] }), []);
  assert.equal(reviewButtonLabel(good), "Review: Update due date in Anatomy");
});

// WI-5.8: the popup's own course list keeps D7's exact wording ("Plan. Asks first.", "Edit.
// Routine edits.", and so on), the same text Plan and Edit settings shows, from nothing but
// morrow_edit_policy_status's own bindings array. Edit is not timed, so no state names an end time.
test("courseStateText keeps D7's own wording, from the edit permission alone", () => {
  const canvasRoutineIds = CURATED_CATEGORY_SPECS.filter((spec) => spec.provider === "canvas" && spec.routine === true).map((spec) => spec.id);
  assert.ok(canvasRoutineIds.length > 1, "the catalog fixture needs more than one routine Canvas id for this test to mean anything");

  assert.equal(courseStateText({ provider: "canvas" }), "Plan. Asks first.", "no permission at all");
  assert.equal(courseStateText({ provider: "canvas", editPermission: { enabledCategories: [] } }), "Plan. Asks first.", "an empty selection");
  assert.equal(
    courseStateText({ provider: "canvas", editPermission: { enabledCategories: canvasRoutineIds, expiresAt: Date.now() - 1 } }),
    "Plan. Asks first.",
    "a grant saved while Edit was timed, after its end time",
  );
  assert.equal(courseStateText({ provider: "canvas", editPermission: { enabledCategories: [canvasRoutineIds[0]] } }), "Edit. 1 kind of edit.");
  assert.equal(courseStateText({ provider: "canvas", editPermission: { enabledCategories: canvasRoutineIds } }), "Edit. Routine edits.");
  assert.equal(
    courseStateText({ provider: "canvas", editPermission: { enabledCategories: canvasRoutineIds, expiresAt: Date.now() + 60_000 } }),
    "Edit. Routine edits.",
    "a grant saved while Edit was timed reads as Edit, with no promised end time",
  );
  assert.equal(
    courseStateText({ provider: "canvas", editPermission: { enabledCategories: [...canvasRoutineIds, "canvas_page_content"] } }),
    "Edit. Custom.",
    "more than the routine set, so it is Custom even though it carries every routine id",
  );
});

test("activeEditBindings counts every live Edit grant, with or without a saved end time", () => {
  const categories = ["canvas_page_content"];
  assert.deepEqual(activeEditBindings([
    { sourceBindingId: "untimed", editPermission: { enabledCategories: categories } },
    { sourceBindingId: "legacy", editPermission: { enabledCategories: categories, expiresAt: Date.now() + 60_000 } },
    { sourceBindingId: "lapsed", editPermission: { enabledCategories: categories, expiresAt: Date.now() - 1 } },
    { sourceBindingId: "empty", editPermission: { enabledCategories: [] } },
    { sourceBindingId: "plan" },
  ]).map((binding) => binding.sourceBindingId), ["untimed", "legacy"]);
});

// WI-5.8: "up to 5, then All courses". A binding with no name or id is dropped rather than shown
// blank, because morrow_status can carry a binding the Bridge has not yet named.
test("connectedCourseRows keeps up to 5 named courses and counts the rest", () => {
  assert.deepEqual(connectedCourseRows(null), { shown: [], more: 0 });
  assert.deepEqual(connectedCourseRows([]), { shown: [], more: 0 });
  assert.deepEqual(connectedCourseRows([{ sourceBindingId: "a", provider: "canvas" }]), { shown: [], more: 0 }, "no course name");
  assert.deepEqual(connectedCourseRows([{ courseName: "Anatomy", provider: "canvas" }]), { shown: [], more: 0 }, "no sourceBindingId");
  const seven = Array.from({ length: 7 }, (_, index) => ({ sourceBindingId: `c${index}`, courseName: `Course ${index}`, provider: "canvas" }));
  const { shown, more } = connectedCourseRows(seven);
  assert.equal(shown.length, 5);
  assert.deepEqual(shown.map((row) => row.name), ["Course 0", "Course 1", "Course 2", "Course 3", "Course 4"]);
  assert.deepEqual(shown.map((row) => row.state), Array(5).fill("Plan. Asks first."));
  assert.equal(more, 2);
});

test("a missing Chrome permission prompt reads differently from a refused one", () => {
  const missing = problemText("course_permission_prompt_missing");
  const denied = problemText("course_permission_denied");
  assert.notEqual(missing, denied);
  assert.match(missing, /Chrome did not show/);
  assert.match(missing, /open it again/);
  assert.match(denied, /choose Allow/);
});

test("the Blackboard message states the REST route and its untested state", () => {
  const message = problemText("blackboard_browser_unsupported");
  assert.match(message, /REST connection in the Morrow app/);
  assert.match(message, /No live Blackboard site has been tested/);
  assert.doesNotMatch(message, /verified/i);
});

test("no popup text calls this product a preview", () => {
  const strings = PROBLEM_CODES.map((code) => problemText(code));
  for (const status of statuses) strings.push(statusValue(status), courseValue(status), primaryLabel(status), detailText(status));
  for (const value of strings) assert.doesNotMatch(value, /preview/i, value);
});

test("known connection states keep their own value, label, and detail", () => {
  assert.equal(statusValue(statuses[1]), "Not connected");
  assert.equal(primaryLabel(statuses[1]), "Connect Morrow");
  // Pairing has no waiting state: a status that still carries an older pairing flag reads as unpaired.
  assert.equal(statusValue(statuses[2]), "Not connected");
  assert.equal(primaryLabel(statuses[2]), "Connect Morrow");
  assert.equal(controlState(statuses[2]).primaryDisabled, false);
  assert.match(detailText(statuses[1]), /Connecting does not approve changes to your courses\.$/);
  assert.equal(statusValue(statuses[3]), "Connecting…");
  assert.equal(controlState(statuses[3]).primaryBusy, true);
  assert.equal(statusValue(statuses[4]), "Not available");
  assert.equal(primaryLabel(statuses[4]), "Waiting for your assistant");
  assert.equal(controlState(statuses[4]).primaryDisabled, true);
  assert.equal(courseValue(statuses[6]), "Not connected");
  assert.equal(primaryLabel(statuses[6]), "", "no platform detected: no primary action at all (WI-5.8)");
  assert.equal(controlState(statuses[6]).primaryDisabled, true);
  assert.equal(primaryLabel(statuses[6], "canvas"), "Connect this course", "the wording never names a platform (WI-5.8)");
  assert.equal(controlState(statuses[6], { detectedProvider: "canvas" }).primaryDisabled, false);
  assert.equal(primaryLabel(statuses[6], "moodle"), "Connect this course");
  assert.match(detailText(statuses[6], "moodle"), /detected Moodle.*Connect this course/);
  assert.equal(canChooseCourses(statuses[7]), true);
  assert.equal(courseValue(statuses[7]), "Ready");
  assert.equal(primaryLabel(statuses[7]), "Choose courses");
  assert.equal(controlState(statuses[7]).primaryDisabled, false);
  assert.equal(courseValue(statuses[8]), "Canvas is closed");
  assert.equal(courseValue(statuses[9]), "Connected");
  assert.match(detailText(statuses[9]), /Keep one signed-in Canvas course tab open/);
  assert.equal(courseValue(statuses[10]), "Canvas is closed");
  assert.match(detailText(statuses[10]), /its Canvas tab is no longer open/);
  assert.match(detailText(statuses[10], "moodle"), /selected Canvas course is not open.*detected Moodle.*Open Canvas/);
});

test("the background status announcement names Morrow and course readiness together", () => {
  assert.equal(statusAnnouncement(statuses[3]), "Morrow: Connecting…. Course: Not connected.");
  assert.equal(statusAnnouncement(statuses[9]), "Morrow: Connected. Course: Connected.");
  const markup = readFileSync(new URL("../../connector/extension/popup/popup.html", import.meta.url), "utf8");
  assert.match(markup, /id="status-announcement"[^>]*role="status"[^>]*aria-live="polite"[^>]*aria-atomic="true"/);
  assert.match(markup, /id="error"[^>]*role="alert"/);
});

// The popup message types answer with a code, and the popup reads its words from that code, so the
// codes are a cross-file contract. If this fails, the state the popup explains is no longer one the
// service worker raises. scripts/test/bridge-problem-copy.test.mjs holds the full list.
test("every service-worker failure the popup explains still exists in the service worker", () => {
  const worker = readFileSync(new URL("../../connector/extension/src/service-worker.js", import.meta.url), "utf8");
  for (const code of ["bridge_not_connected", "bridge_version_mismatch", "bridge_request_failed", "course_tab_missing",
    "course_site_access_required", "course_sign_in_required", "blackboard_browser_unsupported"]) {
    assert.ok(worker.includes(`"${code}"`), code);
  }
});

// popup.js is loaded once, against a small stub of the three globals it uses, because the dead end
// this item removes lives in the wiring: refresh() must render a failure state and re-enable the
// controls that popup.html ships disabled.
function stubElement(text = "", hidden = false) {
  const classes = new Set();
  const element = {
    textWrites: [],
    hidden,
    disabled: false,
    attributes: {},
    classes,
    listeners: {},
    classList: { toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)) },
    setAttribute(name, valueText) { this.attributes[name] = valueText; },
    removeAttribute(name) { delete this.attributes[name]; },
    addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); },
  };
  let currentText = text;
  Object.defineProperty(element, "textContent", {
    get() { return currentText; },
    set(next) { currentText = next; element.textWrites.push(next); },
  });
  return element;
}

test("the popup answers a failed first status read with a retry, then clears it when the retry works", async () => {
  const nodes = {
    "#primary": stubElement("Connect Morrow"),
    "#consent-action": stubElement("Agree and continue"),
    "#consent-detail": stubElement("Select Agree and continue to accept this data use."),
    "#connection-content": stubElement("", true),
    "#canvas-action": stubElement("Check or switch course", true),
    "#open-platform-action": stubElement("Open Canvas", true),
    "#disconnect": stubElement("Disconnect Morrow", true),
    "#status-label": stubElement("Morrow"),
    "#status-value": stubElement("Checking…"),
    "#course-label": stubElement("Course"),
    "#canvas-value": stubElement("Checking…"),
    "#pulse": stubElement(),
    "#detail": stubElement("Checking the connection…"),
    "#error": stubElement("", true),
    "#status-announcement": stubElement(),
    "#account": stubElement("", true),
    "#account-label": stubElement(),
    "#account-origin": stubElement(),
    "#account-connected-at": stubElement(),
    "#notice": stubElement("", true),
    ".edit-access": stubElement(),
    "#editing-settings": stubElement("Open Plan and Edit settings"),
    "#setup-guide": stubElement("Open setup guide"),
    "#edit-access-banner": stubElement("", true),
    "#edit-access-banner-text": stubElement(),
    "#ask-first-all-courses": stubElement("Ask first in all courses"),
    "#reviews-waiting": stubElement("", true),
    "#reviews-list": stubElement(),
    "#data-disclosure": stubElement(),
    "#privacy-link": stubElement("What Morrow Bridge can read", true),
    "#courses": stubElement("", true),
    "#courses-list": stubElement(),
    "#all-courses": stubElement("All courses", true),
  };
  nodes["#primary"].disabled = true;
  let respond = async () => { throw new Error("Could not establish connection. Receiving end does not exist."); };
  globalThis.document = { hidden: false, querySelector: (selector) => nodes[selector] || null, addEventListener() {} };
  globalThis.window = { addEventListener() {} };
  let statusListener;
  globalThis.chrome = {
    runtime: { sendMessage: (request) => respond(request), onMessage: { addListener(listener) { statusListener = listener; } }, openOptionsPage() {} },
    storage: { onChanged: { addListener() {} } },
    tabs: { query: async () => [] },
    permissions: { request: async () => false },
  };
  try {
    await import("../../connector/extension/popup/popup.js");
    assert.equal(nodes["#primary"].disabled, false);
    assert.equal(nodes["#primary"].textContent, "Try again");
    assert.equal(nodes["#primary"].hidden, false);
    assert.equal(nodes["#status-value"].textContent, "Not checked");
    assert.notEqual(nodes["#detail"].textContent, "Checking the connection…");
    assert.equal(nodes["#error"].hidden, false);
    assert.equal(nodes["#error"].textContent, problemText("bridge_extension_unreachable"));

    respond = async (request) => request.type === "morrow_status"
      ? { ok: true, result: { paired: true, pairing: false, connecting: false, connected: true, runtimeHealthy: true, bindings: [], bindingCount: 0, siteAnchors: [anchor()] } }
      : { ok: false, error: "unexpected request" };
    await nodes["#primary"].listeners.click[0]();
    assert.equal(nodes["#error"].hidden, true);
    assert.equal(nodes["#error"].textContent, "");
    assert.equal(nodes["#status-value"].textContent, "Connected");
    assert.equal(nodes["#canvas-value"].textContent, "Ready");
    assert.equal(nodes["#primary"].textContent, "Choose courses");
    assert.equal(nodes["#primary"].disabled, false);

    respond = async (request) => request.type === "morrow_status"
      ? { ok: true, result: statuses[3] }
      : { ok: false, error: "unexpected request" };
    statusListener({ type: "morrow_bridge_status_changed" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(nodes["#status-announcement"].textContent, "Morrow: Connecting…. Course: Not connected.");

    respond = async (request) => request.type === "morrow_status"
      ? { ok: true, result: statuses[9] }
      : { ok: false, error: "unexpected request" };
    statusListener({ type: "morrow_bridge_status_changed" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(nodes["#status-announcement"].textContent, "Morrow: Connected. Course: Connected.");
    const writesAfterChange = nodes["#status-announcement"].textWrites.length;
    statusListener({ type: "morrow_bridge_status_changed" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(nodes["#status-announcement"].textWrites.length, writesAfterChange, "an unchanged background status must not be announced twice");
  } finally {
    delete globalThis.document;
    delete globalThis.window;
    delete globalThis.chrome;
  }
});
