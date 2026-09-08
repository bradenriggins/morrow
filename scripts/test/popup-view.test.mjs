import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PROBLEM_CODES, problemCopy, problemText } from "../../connector/extension/src/bridge-problem-copy.js";
import {
  canChooseCourses,
  controlState,
  courseValue,
  detailText,
  nextError,
  primaryLabel,
  runtimeNeedsReload,
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
  { paired: true, pairing: false, connecting: false, connected: true, runtimeHealthy: true, bindings: [], siteAnchors: [] },
  { paired: true, pairing: false, connecting: false, connected: true, runtimeHealthy: true, bindings: [], siteAnchors: [anchor()] },
  { paired: true, pairing: false, connecting: false, connected: true, runtimeHealthy: true, bindings: [], siteAnchors: [anchor({ runtimeVerified: false })] },
  { paired: true, pairing: false, connecting: false, connected: true, runtimeHealthy: true, bindings: [binding()], siteAnchors: [anchor()], bindingCount: 1 },
  { paired: true, pairing: false, connecting: false, connected: true, runtimeHealthy: true, bindings: [binding({ runtimeVerified: false })], siteAnchors: [anchor()], bindingCount: 1 },
];

test("a connected socket with an unhealthy runtime asks for a Bridge reload", () => {
  const status = { ...statuses[8], runtimeHealthy: false };
  assert.equal(runtimeNeedsReload(status), true);
  assert.equal(statusValue(status), "Reload needed");
  assert.equal(courseValue(status), "Not available");
  assert.equal(primaryLabel(status), "Open setup guide");
  assert.equal(canChooseCourses(status), false);
  assert.equal(controlState(status).primaryDisabled, false);
  assert.match(detailText(status), /versions do not match/i);
  assert.match(detailText(status), /reload Morrow Bridge/i);
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
  assert.equal(statusValue(statuses[2]), "Waiting for approval");
  assert.equal(controlState(statuses[2]).primaryDisabled, true);
  assert.equal(statusValue(statuses[3]), "Connecting…");
  assert.equal(controlState(statuses[3]).primaryBusy, true);
  assert.equal(statusValue(statuses[4]), "Not available");
  assert.equal(primaryLabel(statuses[4]), "Waiting for your assistant");
  assert.equal(controlState(statuses[4]).primaryDisabled, true);
  assert.equal(courseValue(statuses[5]), "Not connected");
  assert.equal(primaryLabel(statuses[5]), "Open Canvas or Moodle");
  assert.equal(controlState(statuses[5]).primaryDisabled, true);
  assert.equal(primaryLabel(statuses[5], "canvas"), "Connect Canvas");
  assert.equal(controlState(statuses[5], { detectedProvider: "canvas" }).primaryDisabled, false);
  assert.equal(primaryLabel(statuses[5], "moodle"), "Connect Moodle");
  assert.match(detailText(statuses[5], "moodle"), /detected Moodle.*Connect Moodle/);
  assert.equal(canChooseCourses(statuses[6]), true);
  assert.equal(courseValue(statuses[6]), "Ready");
  assert.equal(primaryLabel(statuses[6]), "Choose courses");
  assert.equal(controlState(statuses[6]).primaryDisabled, false);
  assert.equal(courseValue(statuses[7]), "Canvas tab needed");
  assert.equal(courseValue(statuses[8]), "Connected");
  assert.match(detailText(statuses[8]), /Keep one signed-in Canvas course tab open/);
  assert.equal(courseValue(statuses[9]), "Canvas tab needed");
  assert.match(detailText(statuses[9]), /its Canvas tab is no longer open/);
  assert.match(detailText(statuses[9], "moodle"), /selected Canvas course is not open.*detected Moodle.*Connect Moodle/);
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
  return {
    textContent: text,
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
}

test("the popup answers a failed first status read with a retry, then clears it when the retry works", async () => {
  const nodes = {
    "#primary": stubElement("Connect Morrow"),
    "#consent-action": stubElement("Agree and continue"),
    "#consent-detail": stubElement("Select Agree and continue to accept this data use."),
    "#connection-content": stubElement("", true),
    "#canvas-action": stubElement("Check or switch course", true),
    "#disconnect": stubElement("Disconnect Morrow", true),
    "#status-label": stubElement("Morrow"),
    "#status-value": stubElement("Checking…"),
    "#course-label": stubElement("Course"),
    "#canvas-value": stubElement("Checking…"),
    "#pulse": stubElement(),
    "#detail": stubElement("Checking the connection…"),
    "#error": stubElement("", true),
    "#account": stubElement("", true),
    "#account-label": stubElement(),
    "#account-origin": stubElement(),
    "#account-last-checked": stubElement(),
    "#notice": stubElement("", true),
    ".edit-access": stubElement(),
    "#editing-settings": stubElement("Open Plan and Edit settings"),
    "#setup-guide": stubElement("Open setup guide"),
  };
  nodes["#primary"].disabled = true;
  let respond = async () => { throw new Error("Could not establish connection. Receiving end does not exist."); };
  globalThis.document = { hidden: false, querySelector: (selector) => nodes[selector] || null, addEventListener() {} };
  globalThis.window = { addEventListener() {} };
  globalThis.chrome = {
    runtime: { sendMessage: (request) => respond(request), onMessage: { addListener() {} }, openOptionsPage() {} },
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
  } finally {
    delete globalThis.document;
    delete globalThis.window;
    delete globalThis.chrome;
  }
});
