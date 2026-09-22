/**
 * What a person sees and does in connector/extension/popup/popup.html.
 *
 * Every check here drives the shipped popup through scripts/test/lib/extension-dom.mjs: its own
 * markup, its own module, and the words it writes. scripts/test/popup-view.test.mjs owns the
 * pure view rules; this file owns what the popup renders from them, what it sends, and what it
 * says when a step fails.
 *
 * A DOM harness is not Chrome. Real rendering and real permission prompts stay with
 * scripts/test/canvas-connector-browser.mjs.
 */

import assert from "node:assert/strict";
import test, { after } from "node:test";
import { DomEvent, clearExtensionGlobals, loadExtensionPage } from "./lib/extension-dom.mjs";
import { problemText } from "../../connector/extension/src/bridge-problem-copy.js";

const LAST_SEEN = Date.UTC(2026, 8, 1, 15, 4, 5);
const COURSE_ORIGIN = "https://canvas.example.edu";

const connection = (fields = {}) => ({
  paired: false, pairing: false, connecting: false, connected: false, bindings: [], siteAnchors: [],
  ...(fields.connected === true && fields.runtimeHealthy === undefined ? { runtimeHealthy: true } : {}),
  ...fields,
});
const anchor = (fields = {}) => ({ siteAnchorId: "canvas:site", provider: "canvas", origin: COURSE_ORIGIN, principalId: "teacher@example.edu", runtimeVerified: true, lastSeenAt: LAST_SEEN, ...fields });
const binding = (fields = {}) => ({ sourceBindingId: "canvas:course-1", provider: "canvas", courseName: "Anatomy", runtimeVerified: true, lastSeenAt: LAST_SEEN, ...fields });
const editPermission = (sourceBindingId, enabledCategories = ["canvas_page_content"]) => ({
  schema: "morrow.bridge.edit-permission.v1", sourceBindingId, revision: 1, scopeDigest: "d".repeat(64), catalogDigest: "c".repeat(64), enabledCategories,
});

async function openPopup({ status, handlers = {}, ...rest } = {}) {
  return await loadExtensionPage("popup/popup.html", { handlers: { morrow_status: () => status(), morrow_detect_course_platform: () => ({ provider: "canvas" }), ...handlers }, ...rest });
}

/** Everything the popup shows a person, read from the rendered page. */
function view(page) {
  return {
    connection: page.text("#status-value"),
    courseLabel: page.text("#course-label"),
    course: page.text("#canvas-value"),
    primary: page.hidden("#primary") ? null : page.text("#primary"),
    primaryDisabled: page.query("#primary").disabled,
    primaryBusy: page.query("#primary").getAttribute("aria-busy"),
    secondary: page.hidden("#canvas-action") ? null : page.text("#canvas-action"),
    openPlatform: page.hidden("#open-platform-action") ? null : page.text("#open-platform-action"),
    disconnect: page.hidden("#disconnect") ? null : page.text("#disconnect"),
    planAndEdit: !page.query(".edit-access").hidden,
    online: page.query("#pulse").classList.contains("online"),
    account: page.hidden("#account") ? null : `${page.text("#account-label")}: ${page.text("#account-origin")}`,
    detail: page.text("#detail"),
  };
}

after(clearExtensionGlobals);

test("the popup requires one clear agreement before it reads connection or course state", async () => {
  let accepted = false;
  const page = await openPopup({
    status: () => accepted ? connection() : { consentRequired: true },
    handlers: { morrow_course_data_consent_accept: () => { accepted = true; return { accepted: true }; } },
  });
  assert.equal(page.hidden("#connection-content"), true);
  assert.equal(page.hidden("#consent-action"), false);
  assert.equal(page.text("#consent-action"), "Agree and continue");
  assert.match(page.text("#consent-detail"), /will not connect to Morrow or read course data before you agree/);
  assert.deepEqual(page.messages().map((message) => message.type), ["morrow_status"]);
  // WI-5.8: the full data-use text shows in full until the person accepts it.
  assert.equal(page.hidden("#data-disclosure"), false);
  assert.match(page.text("#data-disclosure"), /Morrow Bridge reads the Canvas or Moodle pages/);
  assert.equal(page.hidden("#privacy-link"), true);

  await page.click("#consent-action");
  assert.deepEqual(page.messages().map((message) => message.type), [
    "morrow_status",
    "morrow_course_data_consent_accept",
    "morrow_status",
  ]);
  assert.equal(page.hidden("#consent-action"), true);
  assert.equal(page.hidden("#connection-content"), false);
  assert.equal(page.text("#status-value"), "Not connected");
  assert.equal(page.document.activeElement?.getAttribute("id"), "primary");
  // WI-5.8: after acceptance the full text is gone; one link keeps its own name.
  assert.equal(page.hidden("#data-disclosure"), true);
  assert.equal(page.hidden("#privacy-link"), false);
  assert.equal(page.text("#privacy-link"), "What Morrow Bridge can read");
});

test("before a course site is connected the popup names the state it is in", async () => {
  const states = [
    ["a status read that failed", () => ({ ok: false, code: "bridge_extension_unreachable", error: "bridge_extension_unreachable" }), {
      connection: "Not checked", courseLabel: "Course", course: "Not checked",
      primary: "Try again", primaryDisabled: false, primaryBusy: "false",
      secondary: null, openPlatform: null, disconnect: null, planAndEdit: false, online: false, account: null,
      detail: "Morrow could not read this connection state. Select Try again. If the state does not change, close this popup and open it again.",
    }],
    ["Morrow is not added to an assistant yet", () => connection(), {
      connection: "Not connected", courseLabel: "Course", course: "Not connected",
      primary: "Connect Morrow", primaryDisabled: false, primaryBusy: "false",
      secondary: null, openPlatform: null, disconnect: null, planAndEdit: false, online: false, account: null,
      detail: "Add Morrow to your assistant, then open it. Select Connect Morrow to continue.",
    }],
    ["the person has not approved this connection yet", () => connection({ pairing: true }), {
      connection: "Waiting for approval", courseLabel: "Course", course: "Not connected",
      primary: "Waiting for approval", primaryDisabled: true, primaryBusy: "true",
      secondary: null, openPlatform: null, disconnect: null, planAndEdit: false, online: false, account: null,
      detail: "Confirm this connection on the Morrow page that opens. Then return to this popup.",
    }],
    ["Morrow Bridge is connecting", () => connection({ paired: true, connecting: true }), {
      connection: "Connecting…", courseLabel: "Course", course: "Not connected",
      primary: "Waiting for your assistant", primaryDisabled: true, primaryBusy: "true",
      secondary: null, openPlatform: null, disconnect: "Disconnect Morrow", planAndEdit: false, online: false, account: null,
      detail: "Connecting to Morrow. Keep this popup open or return in a moment.",
    }],
  ];
  for (const [name, status, expected] of states) {
    const page = await openPopup({ status });
    assert.deepEqual(view(page), expected, name);
  }
});

test("once Morrow is connected the popup names the course state and the one step that follows", async () => {
  const states = [
    ["a signed-in Canvas course is detected", () => connection({ paired: true, connected: true }), {
      connection: "Connected", courseLabel: "Course", course: "Not connected",
      primary: "Connect this course", primaryDisabled: false, primaryBusy: "false",
      secondary: null, openPlatform: null, disconnect: "Disconnect Morrow", planAndEdit: false, online: true, account: null,
      detail: "Morrow Bridge detected Canvas. Select Connect this course to allow access to this signed-in course.",
    }],
    // WI-5.8: one primary action for the present tab. The saved course's own tab is closed, so
    // "Open Canvas" is that one action; the generic "Connect this course" stays hidden here.
    ["the saved Canvas connection is closed", () => connection({ paired: true, connected: true, siteAnchors: [anchor({ runtimeVerified: false })] }), {
      connection: "Connected", courseLabel: "Learning platform", course: "Canvas is closed",
      primary: null, primaryDisabled: false, primaryBusy: "false",
      secondary: null, openPlatform: "Open Canvas", disconnect: "Disconnect Morrow", planAndEdit: true, online: true,
      account: "Saved platform: Canvas",
      detail: "The saved Canvas connection is no longer open. Select Open Canvas to reopen it.",
    }],
    ["a signed-in site is connected and no course is chosen", () => connection({ paired: true, connected: true, siteAnchors: [anchor()] }), {
      connection: "Connected", courseLabel: "Course selection", course: "Ready",
      primary: "Choose courses", primaryDisabled: false, primaryBusy: "false",
      secondary: null, openPlatform: null, disconnect: "Disconnect Morrow", planAndEdit: false, online: true,
      account: "Connected platform: Canvas",
      detail: "Choose courses in Plan and Edit settings. Plan keeps changes ready for your review.",
    }],
    ["a selected course has no open tab", () => connection({ paired: true, connected: true, bindings: [binding({ runtimeVerified: false })], bindingCount: 1, siteAnchors: [anchor()] }), {
      connection: "Connected", courseLabel: "Connection", course: "Canvas is closed",
      primary: null, primaryDisabled: false, primaryBusy: "false",
      secondary: null, openPlatform: "Open Canvas", disconnect: "Disconnect Morrow", planAndEdit: true, online: true,
      account: "Course: Anatomy",
      detail: "This selected course is connected, but its Canvas tab is no longer open. Select Open Canvas to reopen it.",
    }],
    ["two courses are selected and one site is open", () => connection({ paired: true, connected: true, bindings: [binding()], bindingCount: 2, siteAnchors: [anchor()] }), {
      connection: "Connected", courseLabel: "Connection", course: "Connected",
      primary: null, primaryDisabled: false, primaryBusy: "false",
      secondary: "Check or switch course", openPlatform: null, disconnect: "Disconnect Morrow", planAndEdit: true, online: true,
      account: "Course: Anatomy · 2 courses selected",
      detail: "This selected course is connected. Keep one signed-in Canvas course tab open while you work in Morrow.",
    }],
  ];
  for (const [name, status, expected] of states) {
    const page = await openPopup({ status });
    assert.deepEqual(view(page), expected, name);
  }
});

test("Open Canvas opens the saved site itself, with no permission prompt, and asks for sign-in only when it is unverified after", async () => {
  const opened = [];
  const page = await openPopup({
    status: () => connection({ paired: true, connected: true, bindings: [binding({ runtimeVerified: false })], bindingCount: 1, siteAnchors: [anchor()] }),
    handlers: {
      morrow_open_platform: (fields) => { opened.push(fields); return { opened: true, verified: false }; },
    },
  });
  assert.equal(page.text("#open-platform-action"), "Open Canvas");
  await page.click("#open-platform-action");
  assert.deepEqual(opened, [{ type: "morrow_open_platform", siteAnchorId: "canvas:site", sourceBindingId: "canvas:course-1" }]);
  assert.deepEqual(page.permissionCalls, []);
  assert.equal(page.hidden("#error"), true);
  assert.equal(page.hidden("#notice"), false);
  assert.equal(page.text("#notice"), "Sign in to Canvas in the tab that opened. Morrow continues after that.");
});

test("Open Canvas clears its sign-in notice once the reopened site verifies", async () => {
  const page = await openPopup({
    status: () => connection({ paired: true, connected: true, siteAnchors: [anchor({ runtimeVerified: false })] }),
    handlers: { morrow_open_platform: () => ({ opened: true, verified: true }) },
  });
  assert.equal(page.text("#open-platform-action"), "Open Canvas");
  await page.click("#open-platform-action");
  assert.equal(page.hidden("#notice"), true);
});

// WI-F.10: "Open Canvas" shows "Opening Canvas" in the button. Each wait longer than 400 ms shows
// progress within 100 ms; a fast open never flashes it. Matches settings.js's own open-platform test.
test("Open Canvas shows progress only once the wait runs long enough to need it", async () => {
  let resolveOpen;
  const opening = new Promise((resolve) => { resolveOpen = resolve; });
  const page = await openPopup({
    status: () => connection({ paired: true, connected: true, bindings: [binding({ runtimeVerified: false })], bindingCount: 1, siteAnchors: [anchor()] }),
    handlers: { morrow_open_platform: () => opening },
  });
  assert.equal(page.text("#open-platform-action"), "Open Canvas");

  await page.click("#open-platform-action");
  assert.equal(page.query("#open-platform-action").disabled, true, "a second click must not start a second tab");
  assert.equal(page.text("#open-platform-action"), "Open Canvas", "no progress yet: the wait has not run long enough to need it");
  assert.equal(page.query("#open-platform-action").getAttribute("aria-busy"), "false");

  await page.waitFor(() => page.text("#open-platform-action") === "Opening Canvas", "no progress appeared once the wait ran long enough to need it");
  assert.equal(page.query("#open-platform-action").getAttribute("aria-busy"), "true");

  resolveOpen({ opened: true, verified: false });
  await page.waitFor(() => page.query("#open-platform-action").disabled === false, "opening the site never finished");
  assert.equal(page.text("#open-platform-action"), "Open Canvas");
  assert.equal(page.query("#open-platform-action").getAttribute("aria-busy"), "false");
});

test("the popup uses the platform detected in the active course tab", async () => {
  const page = await openPopup({
    status: () => connection({ paired: true, connected: true }),
    tabs: [{ id: 24, url: "https://moodle.example.edu/course/view.php?id=42" }],
    handlers: { morrow_detect_course_platform: () => ({ provider: "moodle" }) },
  });
  assert.equal(page.text("#primary"), "Connect this course");
  assert.equal(page.query("#primary").disabled, false);
  assert.equal(page.text("#detail"), "Morrow Bridge detected Moodle. Select Connect this course to allow access to this signed-in course.");
  assert.deepEqual(page.messages("morrow_detect_course_platform"), [{ type: "morrow_detect_course_platform", tabId: 24 }]);
});

test("a version-mismatched Bridge exposes only setup recovery", async () => {
  const page = await openPopup({
    status: () => connection({ paired: true, connected: true, runtimeHealthy: false, bindings: [binding()], bindingCount: 1, siteAnchors: [anchor()] }),
    handlers: { morrow_open_setup: () => ({ opened: true }) },
  });
  assert.deepEqual(view(page), {
    connection: "Reload needed", courseLabel: "Connection", course: "Not available",
    primary: "Open setup guide", primaryDisabled: false, primaryBusy: "false",
    secondary: null, openPlatform: null, disconnect: "Disconnect Morrow", planAndEdit: false, online: false,
    account: "Course: Anatomy",
    detail: "The Morrow app and Morrow Bridge versions do not match. Open the setup guide, update or repair Morrow Bridge, then reload Morrow Bridge in Chrome.",
  });
  assert.equal(page.hidden("#setup-guide"), true);
  await page.click("#primary");
  assert.deepEqual(page.messages("morrow_open_setup"), [{ type: "morrow_open_setup" }]);
  assert.deepEqual(page.messages("morrow_connect_course_prepare"), []);
});

test("the popup states when it last saw the course site, or that it cannot say", async () => {
  const page = await openPopup({ status: () => connection({ paired: true, connected: true, bindings: [binding()], bindingCount: 1, siteAnchors: [anchor()] }) });
  assert.equal(page.query("#account-last-checked").getAttribute("datetime"), new Date(LAST_SEEN).toISOString());
  assert.match(page.text("#account-last-checked"), /^Last checked \S/);

  const undated = await openPopup({ status: () => connection({ paired: true, connected: true, bindings: [binding({ lastSeenAt: undefined })], bindingCount: 1, siteAnchors: [] }) });
  assert.equal(undated.text("#account-last-checked"), "Last checked time is not available");
  assert.equal(undated.query("#account-last-checked").getAttribute("datetime"), null);
});

test("Connect this course asks Chrome for that one address, then opens course selection", async () => {
  const page = await openPopup({
    status: () => connection({ paired: true, connected: true }),
    tabs: [{ id: 12, url: `${COURSE_ORIGIN}/courses/1` }],
    handlers: {
      morrow_connect_course_prepare: () => ({ id: "intent-1", origins: [`${COURSE_ORIGIN}/*`] }),
      morrow_connect_course_complete: () => ({ siteAnchorId: "canvas:site" }),
    },
  });
  await page.click("#primary");
  assert.deepEqual(page.messages("morrow_connect_course_prepare"), [{ type: "morrow_connect_course_prepare", tabId: 12 }]);
  assert.deepEqual(page.permissionCalls, [{ method: "request", origins: [`${COURSE_ORIGIN}/*`] }]);
  assert.deepEqual(page.messages("morrow_connect_course_complete"), [{ type: "morrow_connect_course_complete", intentId: "intent-1" }]);
  assert.equal(page.optionsPageOpens, 1);
  assert.equal(page.hidden("#error"), true);
  assert.equal(page.hidden("#notice"), true);
  // The state is read again, so the popup shows what the connection is now rather than what it was.
  assert.equal(page.messages("morrow_status").length, 2);
});

test("a Canvas address Chrome refuses is cancelled, named, and never reported as connected", async () => {
  const refused = await openPopup({
    status: () => connection({ paired: true, connected: true }),
    tabs: [{ id: 12, url: `${COURSE_ORIGIN}/courses/1` }],
    permission: { onRequest: () => false },
    handlers: {
      morrow_connect_course_prepare: () => ({ id: "intent-1", origins: [`${COURSE_ORIGIN}/*`] }),
      morrow_connect_course_cancel: () => ({ cancelled: true }),
    },
  });
  await refused.click("#primary");
  assert.deepEqual(refused.messages("morrow_connect_course_cancel"), [{ type: "morrow_connect_course_cancel", intentId: "intent-1" }]);
  assert.deepEqual(refused.messages("morrow_connect_course_complete"), []);
  assert.equal(refused.text("#error"), problemText("course_permission_denied"));
  assert.equal(refused.optionsPageOpens, 0);

  const noTab = await openPopup({
    status: () => connection({ paired: true, connected: true }),
    tabs: [],
    handlers: { morrow_detect_course_platform: () => ({ provider: null }) },
  });
  // WI-5.8: nothing detected on the present tab, so the one primary action is none at all.
  assert.equal(noTab.hidden("#primary"), true);
  assert.equal(noTab.query("#primary").disabled, true);
  assert.deepEqual(noTab.messages("morrow_connect_course_prepare"), []);
  assert.deepEqual(noTab.permissionCalls, []);
  assert.equal(noTab.hidden("#error"), true);
});

test("choosing courses opens Plan and Edit settings and asks Chrome for nothing", async () => {
  const page = await openPopup({ status: () => connection({ paired: true, connected: true, siteAnchors: [anchor()] }) });
  await page.click("#primary");
  assert.equal(page.optionsPageOpens, 1);
  assert.deepEqual(page.permissionCalls, []);
  assert.deepEqual(page.messages().map((message) => message.type), ["morrow_status"]);

  await page.click("#editing-settings");
  assert.equal(page.optionsPageOpens, 2);
});

test("a failed action keeps its message until the next action, because a background read is not its answer", async () => {
  const tabs = [];
  const page = await openPopup({
    status: () => connection({ paired: true, connected: true, bindings: [binding()], bindingCount: 1, siteAnchors: [anchor()] }),
    tabs,
    handlers: {
      morrow_connect_course_prepare: () => ({ id: "intent-1", origins: [`${COURSE_ORIGIN}/*`] }),
      morrow_connect_course_complete: () => ({ siteAnchorId: "canvas:site" }),
    },
  });
  await page.click("#canvas-action");
  assert.equal(page.text("#error"), problemText("course_tab_missing"));

  // The service worker writes storage while a person reads the message. That read must not erase it.
  page.listeners.storage[0]({}, "local");
  await page.flush();
  assert.equal(page.hidden("#error"), false);
  assert.equal(page.text("#error"), problemText("course_tab_missing"));

  tabs.push({ id: 12, url: `${COURSE_ORIGIN}/courses/1` });
  await page.click("#canvas-action");
  assert.equal(page.hidden("#error"), true);
  assert.equal(page.text("#error"), "");
});

test("the popup reads the connection again whenever Chrome or the Bridge says it changed", async () => {
  let status = connection({ paired: true, connected: true });
  const page = await openPopup({ status: () => status });
  assert.equal(page.messages("morrow_status").length, 1);
  assert.equal(page.text("#canvas-value"), "Not connected");

  status = connection({ paired: true, connected: true, bindings: [binding()], bindingCount: 1, siteAnchors: [anchor()] });
  page.listeners.message[0]({ type: "morrow_bridge_status_changed" });
  await page.flush();
  assert.equal(page.messages("morrow_status").length, 2);
  assert.equal(page.text("#canvas-value"), "Connected");

  page.document.dispatchEvent(new DomEvent("visibilitychange"));
  await page.flush();
  page.window.dispatchEvent(new DomEvent("focus"));
  await page.flush();
  assert.equal(page.messages("morrow_status").length, 4);
});

test("an older status response cannot replace a newer Bridge state", async () => {
  let call = 0;
  let resolveOlder;
  const older = new Promise((resolve) => { resolveOlder = resolve; });
  const page = await openPopup({ status: () => {
    call += 1;
    if (call === 1) return connection({ paired: true, connected: true });
    if (call === 2) return older;
    return connection({ paired: true, connected: true, bindings: [binding()], bindingCount: 1, siteAnchors: [anchor()] });
  } });

  page.window.dispatchEvent(new DomEvent("focus"));
  page.window.dispatchEvent(new DomEvent("focus"));
  await page.waitFor(() => page.messages("morrow_status").length === 3 && page.text("#canvas-value") === "Connected",
    "the newer status response did not render");
  resolveOlder(connection({ paired: true, connected: true }));
  await page.flush();
  assert.equal(page.text("#canvas-value"), "Connected");
  assert.equal(page.text("#account-origin"), "Anatomy");
});

test("Disconnect says plainly when Chrome still holds site access", async () => {
  let permissionsRevoked = false;
  const page = await openPopup({
    status: () => connection({ paired: true, connected: true, bindings: [binding()], bindingCount: 1, siteAnchors: [anchor()] }),
    handlers: { morrow_disconnect: () => ({ permissionsRevoked }) },
  });
  await page.click("#disconnect");
  assert.deepEqual(page.messages("morrow_disconnect"), [{ type: "morrow_disconnect" }]);
  assert.equal(page.hidden("#notice"), false);
  assert.equal(page.text("#notice"), "Morrow is disconnected. Chrome site access still needs removal in this extension's settings.");
  assert.equal(page.hidden("#error"), true);

  permissionsRevoked = true;
  await page.click("#disconnect");
  assert.equal(page.hidden("#notice"), true);
  assert.equal(page.text("#notice"), "");
});

test("the setup guide opens from the popup, and says so when it cannot", async () => {
  const page = await openPopup({
    status: () => connection({ paired: true, connected: true }),
    handlers: { morrow_open_setup: () => ({ opened: true }) },
  });
  await page.click("#setup-guide");
  assert.deepEqual(page.messages("morrow_open_setup"), [{ type: "morrow_open_setup" }]);
  assert.equal(page.hidden("#error"), true);

  const refused = await openPopup({
    status: () => connection({ paired: true, connected: true }),
    handlers: { morrow_open_setup: () => ({ ok: false, code: "bridge_not_connected", error: "bridge_not_connected" }) },
  });
  await refused.click("#setup-guide");
  assert.equal(refused.text("#error"), problemText("bridge_not_connected"));
});

// WI-1.4: morrow_status carries no editPermission per binding, so the popup reads
// morrow_edit_policy_status once it is connected, the same command the settings page uses.
test("the popup's banner offers to ask first in all courses, and the result is announced", async () => {
  let permission = editPermission("canvas:course-1");
  const revoked = [];
  const page = await openPopup({
    status: () => connection({ paired: true, connected: true, bindings: [binding()], bindingCount: 1, siteAnchors: [anchor()] }),
    handlers: {
      morrow_edit_policy_status: () => ({ bindings: [{ sourceBindingId: "canvas:course-1", ...(permission ? { editPermission: permission } : {}) }] }),
      morrow_edit_policy_revoke: ({ sourceBindingId }) => {
        revoked.push(sourceBindingId);
        permission = null;
        return { revoked: true };
      },
    },
  });
  assert.equal(page.hidden("#edit-access-banner"), false);
  assert.equal(page.text("#edit-access-banner-text"), "Morrow can make some changes with no review in 1 course.");
  assert.equal(page.query("#ask-first-all-courses").disabled, false);

  await page.click("#ask-first-all-courses");
  await page.waitFor(() => page.text("#notice") !== "", "the popup never reported the result");
  assert.deepEqual(revoked, ["canvas:course-1"]);
  assert.equal(page.text("#notice"), "Done. Morrow asks first in all courses.");
  assert.equal(page.hidden("#edit-access-banner"), true);
});

// WI-5.8: the popup as home. Up to 5 connected courses with their own D7 state, then "All courses",
// which opens the same Plan and Edit settings page Options does.
test("the popup lists up to 5 connected courses with their own state, then All courses", async () => {
  const bindings = Array.from({ length: 7 }, (_, index) => ({
    sourceBindingId: `canvas:course-${index}`,
    courseName: `Course ${index}`,
    provider: "canvas",
    ...(index === 0 ? { editPermission: { enabledCategories: ["canvas_page_content"] } } : {}),
  }));
  const page = await openPopup({
    status: () => connection({ paired: true, connected: true, bindings: [binding()], bindingCount: 1, siteAnchors: [anchor()] }),
    handlers: { morrow_edit_policy_status: () => ({ bindings }) },
  });
  assert.equal(page.hidden("#courses"), false);
  const rows = page.queryAll("#courses-list .course-row-name").map((node) => node.textContent);
  assert.deepEqual(rows, ["Course 0", "Course 1", "Course 2", "Course 3", "Course 4"]);
  const states = page.queryAll("#courses-list .course-row-state").map((node) => node.textContent);
  assert.equal(states[0], "Edit. 1 kind of edit.");
  assert.equal(states[1], "Plan. Asks first.");
  assert.equal(page.hidden("#all-courses"), false);

  await page.click("#all-courses");
  assert.equal(page.optionsPageOpens, 1);
});

test("with no connected courses the popup shows no course list", async () => {
  const page = await openPopup({ status: () => connection({ paired: true, connected: true, siteAnchors: [anchor()] }) });
  assert.equal(page.hidden("#courses"), true);
  assert.equal(page.hidden("#all-courses"), true);
});

// WI-2.4 (D1b): the popup lists the reviews the runtime pushed through ui_state; it never opens one
// by itself. A click opens the named address, reusing an already open tab rather than collecting a
// second one for the same review.
test("the popup lists the reviews that wait, and a click opens the named one", async () => {
  const page = await openPopup({
    status: () => connection({
      paired: true, connected: true, bindings: [binding()], bindingCount: 1, siteAnchors: [anchor()],
      reviews: [
        { url: "http://127.0.0.1:44210/operations/op-1", label: "Update due date in Anatomy" },
        { url: "http://127.0.0.1:44210/batches/batch-1", label: "Update 3 pages in Anatomy" },
      ],
    }),
  });
  assert.equal(page.hidden("#reviews-waiting"), false);
  const buttons = page.queryAll("#reviews-list button");
  assert.deepEqual(buttons.map((button) => button.textContent), [
    "Review: Update due date in Anatomy",
    "Review: Update 3 pages in Anatomy",
  ]);

  buttons[0].click();
  await page.flush();
  assert.deepEqual(page.tabsCreated, [{ url: "http://127.0.0.1:44210/operations/op-1" }]);
  assert.deepEqual(page.tabsUpdated, []);
});

test("a review tab already open is made active instead of opening a second one", async () => {
  const tabs = [{ id: 7, url: "http://127.0.0.1:44210/operations/op-1" }];
  const page = await openPopup({
    status: () => connection({
      paired: true, connected: true, bindings: [binding()], bindingCount: 1, siteAnchors: [anchor()],
      reviews: [{ url: "http://127.0.0.1:44210/operations/op-1", label: "Update due date in Anatomy" }],
    }),
    tabs,
  });
  await page.click("#reviews-list button");
  assert.deepEqual(page.tabsUpdated, [{ tabId: 7, properties: { active: true } }]);
  assert.deepEqual(page.tabsCreated, []);
});

test("no reviews waiting keeps the section out of the page entirely", async () => {
  const page = await openPopup({
    status: () => connection({ paired: true, connected: true, bindings: [binding()], bindingCount: 1, siteAnchors: [anchor()] }),
  });
  assert.equal(page.hidden("#reviews-waiting"), true);
  assert.equal(page.query("#reviews-list").children.length, 0);
});

test("the popup's banner stays hidden with no active Edit access, and asks nothing while choosing courses", async () => {
  const noEdit = await openPopup({
    status: () => connection({ paired: true, connected: true, bindings: [binding()], bindingCount: 1, siteAnchors: [anchor()] }),
    handlers: { morrow_edit_policy_status: () => ({ bindings: [{ sourceBindingId: "canvas:course-1" }] }) },
  });
  assert.equal(noEdit.hidden("#edit-access-banner"), true);

  const choosing = await openPopup({
    status: () => connection({ paired: true, connected: true, siteAnchors: [anchor()] }),
  });
  assert.equal(choosing.hidden("#edit-access-banner"), true);
  assert.deepEqual(choosing.messages("morrow_edit_policy_status"), []);
});
