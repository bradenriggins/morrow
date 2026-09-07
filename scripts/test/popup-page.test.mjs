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

const connection = (fields = {}) => ({ paired: false, pairing: false, connecting: false, connected: false, bindings: [], siteAnchors: [], ...fields });
const anchor = (fields = {}) => ({ siteAnchorId: "canvas:site", provider: "canvas", origin: COURSE_ORIGIN, principalId: "teacher@example.edu", runtimeVerified: true, lastSeenAt: LAST_SEEN, ...fields });
const binding = (fields = {}) => ({ sourceBindingId: "canvas:course-1", provider: "canvas", courseName: "Anatomy", runtimeVerified: true, lastSeenAt: LAST_SEEN, ...fields });

async function openPopup({ status, handlers = {}, ...rest } = {}) {
  return await loadExtensionPage("popup/popup.html", { handlers: { morrow_status: () => status(), ...handlers }, ...rest });
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
    disconnect: page.hidden("#disconnect") ? null : page.text("#disconnect"),
    planAndEdit: !page.query(".edit-access").hidden,
    online: page.query("#pulse").classList.contains("online"),
    account: page.hidden("#account") ? null : `${page.text("#account-label")}: ${page.text("#account-origin")}`,
    detail: page.text("#detail"),
  };
}

after(clearExtensionGlobals);

test("before a course site is connected the popup names the state it is in", async () => {
  const states = [
    ["a status read that failed", () => ({ ok: false, code: "bridge_extension_unreachable", error: "bridge_extension_unreachable" }), {
      connection: "Not checked", courseLabel: "Course", course: "Not checked",
      primary: "Try again", primaryDisabled: false, primaryBusy: "false",
      secondary: null, disconnect: null, planAndEdit: false, online: false, account: null,
      detail: "Morrow could not read this connection state. Select Try again. If the state does not change, close this popup and open it again.",
    }],
    ["Morrow is not added to an assistant yet", () => connection(), {
      connection: "Not connected", courseLabel: "Course", course: "Not connected",
      primary: "Connect Morrow", primaryDisabled: false, primaryBusy: "false",
      secondary: null, disconnect: null, planAndEdit: false, online: false, account: null,
      detail: "Add Morrow to your assistant, then open it. Select Connect Morrow to continue.",
    }],
    ["the person has not approved this connection yet", () => connection({ pairing: true }), {
      connection: "Waiting for approval", courseLabel: "Course", course: "Not connected",
      primary: "Waiting for approval", primaryDisabled: true, primaryBusy: "true",
      secondary: null, disconnect: null, planAndEdit: false, online: false, account: null,
      detail: "Confirm this connection on the Morrow page that opens. Then return to this popup.",
    }],
    ["Morrow Bridge is connecting", () => connection({ paired: true, connecting: true }), {
      connection: "Connecting…", courseLabel: "Course", course: "Not connected",
      primary: "Waiting for your assistant", primaryDisabled: true, primaryBusy: "true",
      secondary: null, disconnect: "Disconnect Morrow", planAndEdit: false, online: false, account: null,
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
    ["no course site is connected", () => connection({ paired: true, connected: true }), {
      connection: "Connected", courseLabel: "Course", course: "Not connected",
      primary: "Connect course site", primaryDisabled: false, primaryBusy: "false",
      secondary: null, disconnect: "Disconnect Morrow", planAndEdit: false, online: true, account: null,
      detail: "Morrow is connected. Open a signed-in Canvas or Moodle course in Chrome, then select Connect course site.",
    }],
    ["the saved course site is closed", () => connection({ paired: true, connected: true, siteAnchors: [anchor({ runtimeVerified: false })] }), {
      connection: "Connected", courseLabel: "Course site", course: "Course site tab needed",
      primary: "Connect course site", primaryDisabled: false, primaryBusy: "false",
      secondary: null, disconnect: "Disconnect Morrow", planAndEdit: true, online: true,
      account: "Saved course site: Canvas signed-in site",
      detail: "The saved course site is no longer open. Open a signed-in course from this site in Chrome, then connect the course site again.",
    }],
    ["a signed-in site is connected and no course is chosen", () => connection({ paired: true, connected: true, siteAnchors: [anchor()] }), {
      connection: "Connected", courseLabel: "Course selection", course: "Ready",
      primary: "Choose courses", primaryDisabled: false, primaryBusy: "false",
      secondary: null, disconnect: "Disconnect Morrow", planAndEdit: false, online: true,
      account: "Signed-in course site: Canvas signed-in site",
      detail: "Choose courses in Plan and Edit settings. Plan keeps changes ready for your review.",
    }],
    ["a selected course has no open tab", () => connection({ paired: true, connected: true, bindings: [binding({ runtimeVerified: false })], bindingCount: 1, siteAnchors: [anchor()] }), {
      connection: "Connected", courseLabel: "Selected course", course: "Course site tab needed",
      primary: "Connect course site", primaryDisabled: false, primaryBusy: "false",
      secondary: null, disconnect: "Disconnect Morrow", planAndEdit: true, online: true,
      account: "Selected course: Anatomy",
      detail: "This selected course is connected, but its course site tab is no longer open. Open a signed-in course from this site in Chrome, then select Connect course site.",
    }],
    ["two courses are selected and one site is open", () => connection({ paired: true, connected: true, bindings: [binding()], bindingCount: 2, siteAnchors: [anchor()] }), {
      connection: "Connected", courseLabel: "Selected course", course: "Connected",
      primary: null, primaryDisabled: false, primaryBusy: "false",
      secondary: "Check or switch course", disconnect: "Disconnect Morrow", planAndEdit: true, online: true,
      account: "Selected course: Anatomy · 2 courses selected",
      detail: "This selected course is connected. Keep one signed-in course site tab open while you work in Morrow.",
    }],
  ];
  for (const [name, status, expected] of states) {
    const page = await openPopup({ status });
    assert.deepEqual(view(page), expected, name);
  }
});

test("the popup states when it last saw the course site, or that it cannot say", async () => {
  const page = await openPopup({ status: () => connection({ paired: true, connected: true, bindings: [binding()], bindingCount: 1, siteAnchors: [anchor()] }) });
  assert.equal(page.query("#account-last-checked").getAttribute("datetime"), new Date(LAST_SEEN).toISOString());
  assert.match(page.text("#account-last-checked"), /^Last checked \S/);

  const undated = await openPopup({ status: () => connection({ paired: true, connected: true, bindings: [binding({ lastSeenAt: undefined })], bindingCount: 1, siteAnchors: [] }) });
  assert.equal(undated.text("#account-last-checked"), "Last checked time is not available");
  assert.equal(undated.query("#account-last-checked").getAttribute("datetime"), null);
});

test("connecting a course site asks Chrome for that one site, then opens course selection", async () => {
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

test("a course site Chrome refuses is cancelled, named, and never reported as connected", async () => {
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

  const noTab = await openPopup({ status: () => connection({ paired: true, connected: true }), tabs: [] });
  await noTab.click("#primary");
  assert.deepEqual(noTab.messages("morrow_connect_course_prepare"), []);
  assert.deepEqual(noTab.permissionCalls, []);
  assert.equal(noTab.text("#error"), problemText("course_tab_missing"));
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
