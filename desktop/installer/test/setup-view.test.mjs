import assert from "node:assert/strict";
import test from "node:test";
import { errorDetails, installerState } from "../shared/contract.cjs";
import { actionView, awaitingBridgeFolder, blackboardSetupOffered, escapeHtml, progress, removalAnnouncement, retentionView, setupManagementView, setupUnavailableView, statusSummary, supportView } from "../shared/setup-view.mjs";

const CHATGPT = Object.freeze({ id: "codex", title: "ChatGPT", tier: "primary", supported: true, needsWorkspace: true });
const CLAUDE_DESKTOP = Object.freeze({ id: "claude-desktop", title: "Claude Desktop", tier: "primary", supported: true, needsWorkspace: true });

function state(overrides = {}) {
  return installerState({
    lifecycle: "ready_for_assistant",
    assistants: [],
    selectedAssistantId: null,
    workspaceSelected: true,
    runtimeStatus: "ready",
    bridgeDelivery: "developer_temporary",
    bridgeFolderReady: false,
    bridgeLoadedInChrome: "unknown",
    bridgePaired: "unknown",
    courseSite: "unknown",
    runtimeVerifiedCourseCount: 0,
    selectedCourseName: null,
    ...overrides
  });
}

// Every action the panel body offers, in the order it offers them.
function actions(body) {
  return [...body.matchAll(/data-action="([a-z-]+)"/g)].map((entry) => entry[1]);
}

function step(current, label) {
  const found = progress(current).find((entry) => entry.label === label);
  assert.ok(found, `progress has no ${label} step`);
  return found;
}

// The state fields, not a built state, so a case can spread and extend them.
const READY_ASSISTANT = Object.freeze({
  lifecycle: "assistant_ready",
  assistants: [{ ...CHATGPT, detected: true, configured: true, connected: true, selected: true }],
  selectedAssistantId: "codex",
  bridgeFolderReady: true
});

// Chrome answered the active-folder challenge and the Bridge reached the runtime.
const PAIRED = Object.freeze({ ...READY_ASSISTANT, bridgeLoadedInChrome: true, bridgePaired: true });

const CONNECTED_COURSE = Object.freeze({ ...PAIRED, runtimeVerifiedCourseCount: 1, selectedCourseName: "BIOL 101" });

test("no assistant is chosen yet", () => {
  const current = state({ assistants: [{ ...CHATGPT, detected: true }] });
  const view = actionView(current, { chosenAssistantId: null });
  assert.equal(view.title, "Choose your assistant.");
  assert.match(view.body, /data-action="choose-assistant" data-assistant-id="codex"/);
  assert.match(view.body, /data-action="install-assistant"/);
  assert.equal(statusSummary(current), "Choose your assistant");
  assert.equal(step(current, "Assistant").status, "current");
  assert.equal(step(current, "Assistant").detail, "Choose an installed assistant");
});

test("the chosen assistant is the one the setup button offers", () => {
  const current = state({ assistants: [{ ...CHATGPT, detected: true }, { ...CLAUDE_DESKTOP, detected: true }] });
  assert.match(actionView(current, { chosenAssistantId: "claude-desktop" }).body, /Set up Claude Desktop/);
  assert.match(actionView(current, { chosenAssistantId: "codex" }).body, /Set up ChatGPT/);
  assert.match(actionView(current, {}).body, /Choose an assistant<\/button>/);
});

test("Claude Desktop is waiting for approval", () => {
  const current = state({
    lifecycle: "assistant_pending",
    assistants: [{ ...CLAUDE_DESKTOP, detected: true, configured: false, pending: true, selected: true }],
    selectedAssistantId: "claude-desktop"
  });
  const view = actionView(current, { chosenAssistantId: "claude-desktop" });
  assert.equal(view.title, "Finish setting up Claude Desktop.");
  assert.match(view.body, /data-action="open-claude-desktop"/);
  assert.match(view.body, /data-action="reveal-claude-extension"/);
  assert.match(view.body, /Advanced settings/);
  assert.match(view.body, /Morrow\.mcpb/);
  assert.doesNotMatch(view.copy, /opened Claude Desktop/);
  assert.match(view.body, /data-action="check-claude-desktop"/);
  assert.equal(statusSummary(current), "Finish setting up Claude Desktop");
  assert.equal(step(current, "Assistant").detail, "Finish approval in Claude Desktop");
});

test("Claude Desktop connected and Morrow is still confirming the Claude app, so it says it is checking, not waiting for approval", () => {
  const current = state({
    lifecycle: "assistant_pending",
    assistants: [{ ...CLAUDE_DESKTOP, detected: true, configured: false, pending: true, checking: true, selected: true }],
    selectedAssistantId: "claude-desktop"
  });
  assert.equal(current.assistants[0].checking, true, "the state carries the check");
  const view = actionView(current, { chosenAssistantId: "claude-desktop" });
  assert.equal(view.title, "Morrow is checking the Claude Desktop connection.");
  assert.match(view.copy, /Morrow keeps checking on its own/);
  assert.doesNotMatch(`${view.title} ${view.copy} ${view.body}`, /approv|Install Extension|not connected/i);
  assert.deepEqual(actions(view.body), ["check-claude-desktop", "open-claude-desktop"]);
  assert.equal(statusSummary(current), "Checking the Claude Desktop connection");
  assert.equal(step(current, "Assistant").detail, "Checking the Claude Desktop connection");
  assert.match(setupManagementView(current).body, /Morrow is checking the connection to Claude Desktop\./);
  assert.doesNotMatch(setupManagementView(current).body, /Waiting for your approval/);
  const unchecked = state({ assistants: [{ ...CLAUDE_DESKTOP, detected: true, pending: true, selected: true }] });
  assert.equal(unchecked.assistants[0].checking, false);
});

test("the local runtime is not ready yet", () => {
  const current = state({ ...READY_ASSISTANT, runtimeStatus: "uncertain" });
  const view = actionView(current, { chosenAssistantId: "codex" });
  assert.equal(view.title, "Morrow is getting ready.");
  // The panel offers no step from this state, and no setup management: that
  // moved to the Settings view, reachable regardless (D8).
  assert.deepEqual(actions(view.body), []);
  assert.ok(setupManagementView(current), "Settings still offers the setup to change");
});

test("the Blackboard connection is offered only after an assistant is set up and the runtime is ready", () => {
  // The first screen asks a person to choose an assistant. A five-field
  // credential form is not part of that screen.
  const welcome = state({ assistants: [{ ...CHATGPT, detected: true }] });
  assert.equal(actionView(welcome, {}).title, "Choose your assistant.");
  assert.equal(blackboardSetupOffered(welcome), false);
  assert.equal(actionView(welcome, {}).body.includes("blackboard"), false);

  assert.equal(blackboardSetupOffered(state({ lifecycle: "assistant_pending", assistants: [{ ...CLAUDE_DESKTOP, detected: true, pending: true, selected: true }], selectedAssistantId: "claude-desktop" })), false);
  assert.equal(blackboardSetupOffered(state({ ...READY_ASSISTANT, runtimeStatus: "uncertain" })), false);
  assert.equal(blackboardSetupOffered(state({ ...READY_ASSISTANT, runtimeStatus: "repair_required" })), false);
  assert.equal(blackboardSetupOffered(null), false);
  assert.equal(blackboardSetupOffered(state(READY_ASSISTANT)), true);
});

test("Morrow cannot read its own installer record", () => {
  const current = state({ lifecycle: "repair_required", runtimeStatus: "repair_required" });
  const view = actionView(current, { chosenAssistantId: null });
  assert.equal(view.title, "Repair Morrow before you connect a course.");
  // The only actions offered from this state are the in-app repair and a
  // re-check. Nothing here can start a course connection or a course action.
  assert.match(view.body, /data-action="repair"/);
  assert.match(view.body, /Repair Morrow<\/button>/);
  assert.deepEqual([...view.body.matchAll(/data-action="([a-z-]+)"/g)].map((entry) => entry[1]), ["repair", "check-setup-state"]);
  assert.equal(statusSummary(current), "Morrow needs repair");
});

test("Chrome must reload a staged Bridge update", () => {
  const current = state({ ...READY_ASSISTANT, bridgeManualChromeReloadRequired: true });
  const view = actionView(current, { chosenAssistantId: "codex" });
  assert.equal(view.title, "Reload Morrow Bridge.");
  assert.match(view.body, /data-action="check-bridge"/);
  assert.match(view.body, /data-action="restore-bridge"/);
  assert.match(view.body, />Restore previous Bridge<\/button>/);
  assert.deepEqual(actions(view.body), ["check-bridge", "restore-bridge"]);
  // Numbered instructions name the Chrome menu path. Morrow opens no browser page.
  assert.match(view.body, /<ol class="instructions">/);
  assert.match(view.body, /<strong>Manage Extensions<\/strong>/);
  assert.doesNotMatch(view.body, /open-bridge-install/);
  assert.doesNotMatch(view.body, /chrome:\/\//);
  assert.equal(statusSummary(current), "Reload Morrow Bridge in Chrome");
  assert.equal(step(current, "Morrow Bridge").status, "current");
  assert.equal(step(current, "Morrow Bridge").detail, "Reload in Chrome, then check");
});

test("a ready installation exposes its sealed Bridge update", () => {
  const current = state({ ...CONNECTED_COURSE, firstPreview: { available: true, completed: true }, bridgeUpdateAvailable: true });
  const view = actionView(current, { chosenAssistantId: "codex" });
  assert.equal(view.title, "Update Morrow Bridge.");
  assert.match(view.copy, /does not change your course/);
  assert.deepEqual(actions(view.body), ["check-bridge"]);
  assert.match(view.body, />Update Bridge<\/button>/);
  assert.equal(statusSummary(current), "Update Morrow Bridge");
  assert.equal(step(current, "Morrow Bridge").status, "current");
  assert.equal(step(current, "Morrow Bridge").detail, "Update available");
});

// Updating a Bridge in Chrome needs a connected Bridge. With none connected,
// Check Bridge on the Chrome steps replaces the folder itself, so those steps
// stay on screen and no panel offers a step that cannot finish.
test("a Bridge update waits for a connected Bridge, and the Chrome steps stay until then", () => {
  const current = state({ ...READY_ASSISTANT, bridgeUpdateAvailable: true, bridgeFolderPath: "/Users/example/Library/Application Support/Morrow/Bridge" });
  assert.equal(current.bridge.updateAvailable, true);
  const view = actionView(current, { chosenAssistantId: "codex", platform: "darwin" });
  assert.equal(view.title, "Add Morrow Bridge.");
  assert.deepEqual(actions(view.body), ["copy-example-prompt", "reveal-bridge-folder", "check-bridge", "repair"]);
  assert.equal(statusSummary(current), "Set up Morrow Bridge in Chrome");
  assert.equal(step(current, "Morrow Bridge").detail, "Add in Chrome");
  assert.equal(awaitingBridgeFolder(current), true, "the folder step is timed as the step on screen");

  for (const connected of [{ bridgeLoadedInChrome: true }, { bridgePaired: true }]) {
    const offered = state({ ...READY_ASSISTANT, ...connected, bridgeUpdateAvailable: true });
    assert.equal(actionView(offered, { chosenAssistantId: "codex" }).title, "Update Morrow Bridge.");
    assert.equal(step(offered, "Morrow Bridge").detail, "Update available");
    assert.equal(awaitingBridgeFolder(offered), false);
  }
});

test("Bridge delivery is unavailable", () => {
  const current = state({ ...READY_ASSISTANT, lifecycle: "bridge_delivery_unavailable", bridgeDelivery: "unavailable" });
  const view = actionView(current, { chosenAssistantId: "codex" });
  assert.equal(view.title, "Morrow Bridge is not available yet.");
  assert.deepEqual(actions(view.body), [], "no Chrome step is offered from a blocked delivery");
  assert.equal(statusSummary(current), "Morrow Bridge is not available yet");
  assert.equal(step(current, "Morrow Bridge").status, "blocked");
  assert.equal(step(current, "Morrow Bridge").detail, "Not available yet");
});

test("an unavailable Bridge delivery blocks the action view on its own", () => {
  const current = state({ ...READY_ASSISTANT, bridgeDelivery: "unavailable" });
  assert.equal(actionView(current, { chosenAssistantId: "codex" }).title, "Morrow Bridge is not available yet.");
  assert.equal(step(current, "Morrow Bridge").status, "blocked");
});

test("a ready Bridge folder that Chrome has not confirmed still asks for the Chrome step", () => {
  const current = state(READY_ASSISTANT);
  assert.equal(current.bridge.folderReady, true);
  assert.equal(current.bridge.loadedInChrome, "unknown");
  const view = actionView(current, { chosenAssistantId: "codex" });
  assert.equal(view.title, "Add Morrow Bridge.");
  assert.match(view.body, /data-action="reveal-bridge-folder"/);
  assert.match(view.body, /data-action="repair"/);
  assert.equal(statusSummary(current), "Set up Morrow Bridge in Chrome");
  assert.equal(step(current, "Morrow Bridge").status, "current");

  // The temporary Developer mode step is numbered, visual, and command-free:
  // Show Bridge folder plus the exact Chrome menu path. Morrow offers no
  // browser-internal address, which Chrome refuses from another application.
  assert.match(view.body, /<ol class="instructions">/);
  assert.match(view.body, /<strong>Show Bridge folder<\/strong>/);
  assert.match(view.body, /<strong>Manage Extensions<\/strong>/);
  assert.match(view.body, /<strong>Developer mode<\/strong>/);
  assert.match(view.body, /<strong>Load unpacked<\/strong>/);
  assert.equal(view.body.match(/<li>/g).length, 5);
  assert.doesNotMatch(view.body, /open-bridge-install/);
  assert.doesNotMatch(view.body, /chrome:\/\//);
  assert.doesNotMatch(view.copy, /chrome:\/\//);
});

test("no Bridge view offers to open a browser page for the person", () => {
  const cases = [
    state(READY_ASSISTANT),
    state({ ...READY_ASSISTANT, bridgeDelivery: "available" }),
    state({ ...READY_ASSISTANT, bridgeManualChromeReloadRequired: true }),
    state({ ...READY_ASSISTANT, bridgeFolderReady: false }),
    state({ ...READY_ASSISTANT, bridgeDelivery: "unavailable" })
  ];
  for (const current of cases) {
    const view = actionView(current, { chosenAssistantId: "codex" });
    assert.doesNotMatch(view.body, /open-bridge-install/, view.title);
    assert.doesNotMatch(view.body, /chrome:\/\//, view.title);
  }
});

test("an unprepared Bridge folder offers repair before the Chrome step", () => {
  const current = state({ ...READY_ASSISTANT, bridgeFolderReady: false });
  const view = actionView(current, { chosenAssistantId: "codex" });
  assert.equal(view.title, "Morrow Bridge is not ready to open.");
  assert.match(view.body, /data-action="repair"/);
  assert.doesNotMatch(view.body, /data-action="reveal-bridge-folder"/);
  assert.equal(step(current, "Morrow Bridge").status, "current");
});

test("a confirmed load in Chrome moves setup on to the connection", () => {
  const current = state({ ...READY_ASSISTANT, bridgeLoadedInChrome: true });
  const view = actionView(current, { chosenAssistantId: "codex" });
  assert.equal(view.title, "Connect Morrow Bridge.");
  assert.match(view.body, /data-action="check-bridge"/);
  assert.equal(step(current, "Morrow Bridge").status, "current");
  assert.equal(step(current, "Morrow Bridge").detail, "Installed; connect to Morrow");
});

test("a paired Bridge without a connected course asks for the course", () => {
  const current = state(PAIRED);
  const view = actionView(current, { chosenAssistantId: "codex" });
  assert.equal(view.title, "Open your course in Chrome.");
  // Every control the steps name exists in Morrow Bridge, and the panel ends with an action.
  for (const label of ["Connect this course", "Open Plan and Edit settings", "Your courses", "Connect", "Check Bridge"]) {
    assert.ok(view.body.includes(`<strong>${label}</strong>`), `the steps name ${label}`);
  }
  for (const missing of ["Connect selected courses in Plan", "Connect Canvas", "Connect Moodle", "Plan and Edit settings</strong>, choose"]) {
    assert.equal(view.body.includes(missing), false, `the steps name a control that does not exist: ${missing}`);
  }
  assert.match(view.body, /data-action="check-bridge"/);
  assert.equal(statusSummary(current), "Morrow Bridge is connected");
  assert.equal(step(current, "Morrow Bridge").status, "done");
  assert.equal(step(current, "Course").status, "current");
});

test("a paired Bridge with a verified course and a ready first read offers the connection check", () => {
  const current = state({ ...CONNECTED_COURSE, firstPreview: { available: true } });
  assert.equal(current.bridge.loadedInChrome, true);
  assert.equal(current.bridge.paired, true);
  assert.equal(current.bridge.runtimeVerifiedCourseCount, 1);
  assert.equal(current.firstPreview.available, true);
  const view = actionView(current, { chosenAssistantId: "codex" });
  assert.equal(view.title, "Check your course connection.");
  assert.match(view.body, /data-action="run-first-read"/);
  assert.equal(statusSummary(current), "First read is ready");
  assert.equal(step(current, "Course").status, "current");
});

test("a paired Bridge Morrow has not confirmed in Chrome still reaches the course steps", () => {
  // The state D1 dead-ended on: the folder is ready, Chrome never answered the
  // challenge, and the Bridge is paired with one verified course.
  const current = state({ ...CONNECTED_COURSE, bridgeLoadedInChrome: "unknown", firstPreview: { available: true } });
  const view = actionView(current, { chosenAssistantId: "codex" });
  assert.equal(view.title, "Check your course connection.");
  assert.match(view.body, /data-action="run-first-read"/);
});

test("the header never announces the first read while the panel asks for the Bridge", () => {
  const cases = [
    state({ ...READY_ASSISTANT, runtimeVerifiedCourseCount: 1, selectedCourseName: "BIOL 101", firstPreview: { available: true } }),
    state({ ...READY_ASSISTANT, runtimeVerifiedCourseCount: 1, selectedCourseName: "BIOL 101", firstPreview: { available: true, completed: true } }),
    state({ ...READY_ASSISTANT, bridgeDelivery: "available", firstPreview: { available: true } })
  ];
  for (const current of cases) {
    const view = actionView(current, { chosenAssistantId: "codex" });
    assert.match(view.title, /^(Add|Install) Morrow Bridge\.$/);
    assert.equal(statusSummary(current), "Set up Morrow Bridge in Chrome");
  }
});

test("every view answers with a title, copy, and body, and no step is both done and current", () => {
  const cases = [
    state({ assistants: [{ ...CHATGPT, detected: true }] }),
    state({ lifecycle: "repair_required", runtimeStatus: "repair_required" }),
    state(READY_ASSISTANT),
    state({ ...READY_ASSISTANT, bridgeDelivery: "unavailable" }),
    state({ ...READY_ASSISTANT, bridgeManualChromeReloadRequired: true }),
    state({ ...READY_ASSISTANT, bridgeLoadedInChrome: true }),
    state(PAIRED),
    state(CONNECTED_COURSE),
    state({ ...CONNECTED_COURSE, firstPreview: { available: true } }),
    state({ ...CONNECTED_COURSE, firstPreview: { available: true, completed: true } })
  ];
  for (const current of cases) {
    const view = actionView(current, { chosenAssistantId: null });
    for (const field of ["title", "copy", "body"]) {
      assert.equal(typeof view[field], "string", `${field} is missing`);
      assert.notEqual(view[field].length, 0, `${field} is empty`);
    }
    assert.equal(typeof statusSummary(current), "string");
    const steps = progress(current);
    assert.equal(steps.length, 3);
    assert.equal(steps.filter((entry) => entry.current).length <= 1, true);
    for (const entry of steps) assert.equal(entry.status === "done" && entry.current, false);
  }
});

const RETENTION_LOCATIONS = [
  { id: "state", label: "Morrow's setup record and local journal", path: "/Morrow/State", removable: true, keptReason: null },
  { id: "materials", label: "Your Morrow materials folder", path: "/Home/Documents/Fall biology", removable: false, keptReason: "outside_morrow_data" },
  { id: "assistant_configuration", label: "ChatGPT settings file", path: "/Home/.codex/config.toml", removable: false, keptReason: "assistant_configuration" }
];

function retention(overrides = {}) {
  return retentionView(state({ retention: { uninstall: "move_to_trash", locations: RETENTION_LOCATIONS, ...overrides } }));
}

test("the data-retention section names every place, what it removes, and the step this computer uses", () => {
  const view = retention();
  assert.equal(view.title, "What stays on this computer");
  assert.match(view.copy, /removes the application only/);
  for (const location of RETENTION_LOCATIONS) {
    assert.ok(view.body.includes(location.path), `the section names ${location.path}`);
    assert.ok(view.body.includes(escapeHtml(location.label)), `the section names ${location.label}`);
  }
  assert.match(view.body, /Morrow can remove these/);
  assert.match(view.body, /Morrow does not remove these/);
  assert.match(view.body, /Your assistant&#39;s own settings file/);
  assert.match(view.body, /Outside the folders Morrow keeps its own files in/);
  assert.match(view.body, /move it to the Trash/);
  assert.match(view.body, /data-action="remove-data"/);

  const windows = retentionView(state({ retention: { uninstall: "windows_settings_apps", locations: RETENTION_LOCATIONS } }));
  // Microsoft's steps: Start > Settings > Apps > Installed apps, then the app's More > Uninstall.
  assert.match(windows.body, /open Settings, select Apps, then Installed apps, find Morrow, select More, and select Uninstall\./);
  assert.equal(/Trash/.test(windows.body), false);

  // Chrome loaded the Bridge from the folder listed above only when Chrome loaded
  // or connected it and that folder is on this computer.
  const bridgeRow = { id: "bridge", label: "The Morrow Bridge folder Chrome loads", path: "/Morrow/Bridge", removable: true, keptReason: null };
  const withBridge = { uninstall: "move_to_trash", locations: [...RETENTION_LOCATIONS, bridgeRow] };
  for (const bridge of [{ bridgeLoadedInChrome: true }, { bridgePaired: true }]) {
    assert.match(retentionView(state({ ...bridge, retention: withBridge })).body, /Chrome loaded Morrow Bridge from the Bridge folder above\. To remove/, "the temporary route loads the Bridge folder");
  }
  const loadedWithoutFolder = retentionView(state({ bridgeLoadedInChrome: true, retention: { uninstall: "move_to_trash", locations: RETENTION_LOCATIONS } }));
  assert.doesNotMatch(loadedWithoutFolder.body, /Chrome loaded Morrow Bridge/, "no Bridge folder is listed above");
  assert.match(loadedWithoutFolder.body, /To remove Morrow Bridge from Chrome, open/);
  for (const unconfirmed of [retention(), retentionView(state({ bridgeLoadedInChrome: false, retention: withBridge }))]) {
    assert.doesNotMatch(unconfirmed.body, /Chrome loaded Morrow Bridge/, "Chrome is not known to have loaded Morrow Bridge");
    assert.match(unconfirmed.body, /If you added <strong>Morrow Bridge<\/strong> in Chrome, remove it there too: open the Chrome <strong>three-dot menu<\/strong>/);
  }
  const store = retentionView(state({ bridgeDelivery: "available", retention: { uninstall: "move_to_trash", locations: RETENTION_LOCATIONS } }));
  assert.doesNotMatch(store.body, /Bridge folder/, "a Chrome Web Store install did not load the Bridge folder");
  assert.match(store.body, /remove <strong>Morrow Bridge<\/strong>/);
  assert.equal(retentionView(state()), null, "a state that names no place shows no section");
  assert.equal(retentionView(null), null);
});

test("the data-retention section reports one removal exactly as the receipt supports it", () => {
  const cancelled = retention({ removal: { status: "cancelled", removed: [], remaining: [], kept: ["/Home/.codex/config.toml"] } });
  assert.match(cancelled.body, /Nothing was removed/);

  const removed = retention({ removal: { status: "removed", removed: ["/Morrow/State"], remaining: [], kept: [] } });
  assert.match(removed.body, /Morrow removed its data/);
  assert.match(removed.body, /quit Morrow before you remove the application/);

  const incomplete = retention({ removal: { status: "incomplete", removed: ["/Morrow/State"], remaining: ["/Morrow/Bridge"], kept: [] } });
  assert.match(incomplete.body, /Morrow could not remove everything/);
  assert.match(incomplete.body, /These are still on this computer/);
  assert.ok(incomplete.body.includes("/Morrow/Bridge"));
  assert.equal(/Morrow removed its data/.test(incomplete.body), false, "an incomplete removal never claims a complete one");
});

const MATERIALS = "/Home/Documents/Fall biology";

test("the materials folder is named, and can be changed, on Settings in every state after setup", () => {
  // Every state a person reaches once an assistant is set up. Each one names
  // the exact folder and offers the change, so the folder is never a choice
  // that can only be made on the first screen. This moved to Settings (D8):
  // Home shows status and example requests only.
  const cases = [
    ["assistant is configured", READY_ASSISTANT],
    ["Chrome has the Bridge loaded", { ...READY_ASSISTANT, bridgeLoadedInChrome: true }],
    ["the Bridge is paired", PAIRED],
    ["a course is connected", CONNECTED_COURSE],
    ["the first read is complete", { ...CONNECTED_COURSE, firstPreview: { available: true, completed: true } }]
  ];
  for (const [name, fields] of cases) {
    const current = state({ ...fields, materialsFolder: MATERIALS });
    const settings = setupManagementView(current);
    assert.equal(settings.title, "Setup you can change", name);
    assert.ok(settings.body.includes(escapeHtml(MATERIALS)), `${name}: the folder is named`);
    assert.match(settings.body, /data-action="choose-workspace">Change folder<\/button>/, name);
    assert.match(settings.body, /Changing it writes the new folder into ChatGPT\./, name);
    // Home carries none of this: status and example requests only (D8).
    const view = actionView(current, { chosenAssistantId: "codex" });
    assert.equal(view.body.includes(escapeHtml(MATERIALS)), false, `${name}: Home does not name the folder`);
    assert.equal(view.body.includes("choose-workspace"), false, `${name}: Home offers no folder change`);
  }
});

// The default folder sits inside a folder macOS and Windows hide (Library, AppData), so the row
// opens it and copies its path, the way the Bridge folder row does.
test("the materials folder row can open the folder and copy its path, before and after setup", () => {
  const copy = `data-action="copy-example-prompt" data-prompt="${escapeHtml(MATERIALS)}" aria-label="Copy the materials folder path">Copy path</button>`;
  const settings = setupManagementView(state({ ...READY_ASSISTANT, materialsFolder: MATERIALS }));
  assert.match(settings.body, /data-action="reveal-materials-folder">Show folder<\/button>/);
  assert.ok(settings.body.includes(copy));
  const welcome = actionView(state({ assistants: [{ ...CHATGPT, detected: true }], materialsFolder: MATERIALS, workspaceSelected: false }), { chosenAssistantId: null });
  assert.match(welcome.body, /data-action="reveal-materials-folder">Show folder<\/button>/);
  assert.ok(welcome.body.includes(copy));
  // With no folder yet there is nothing to open or copy.
  const none = actionView(state({ assistants: [{ ...CHATGPT, detected: true }] }), { chosenAssistantId: null });
  assert.doesNotMatch(none.body, /reveal-materials-folder|Copy path/);
});

test("the folder row before setup asks for a folder and never claims a change it did not make", () => {
  const chosen = actionView(state({ assistants: [{ ...CHATGPT, detected: true }], materialsFolder: MATERIALS, workspaceSelected: false }), { chosenAssistantId: null });
  assert.ok(chosen.body.includes(escapeHtml(MATERIALS)));
  assert.match(chosen.body, /Morrow made this folder for course materials\./);
  assert.match(chosen.body, /data-action="choose-workspace">Choose folder<\/button>/);
  // No assistant is set up, so nothing is written into an assistant.
  assert.doesNotMatch(chosen.body, /Changing it writes the new folder into/);
  assert.doesNotMatch(chosen.body, /data-action="remove-assistant"/);

  const unknown = actionView(state({ assistants: [{ ...CHATGPT, detected: true }] }), { chosenAssistantId: null });
  assert.match(unknown.body, /Otherwise, Morrow creates and uses its own Materials folder\./);
});

test("the repair state offers the repair alone, with no setup to change", () => {
  const current = state({
    lifecycle: "repair_required",
    runtimeStatus: "repair_required",
    assistants: [{ ...CHATGPT, detected: true, configured: true, connected: true, selected: true }],
    materialsFolder: MATERIALS
  });
  const view = actionView(current, { chosenAssistantId: null });
  assert.deepEqual(actions(view.body), ["repair", "check-setup-state"]);
  assert.equal(view.body.includes(MATERIALS), false, "the folder cannot be changed from a state Morrow cannot read");
  // Settings shows nothing to change either, so a repaired computer cannot
  // reach the folder or assistant list through either view.
  assert.equal(setupManagementView(current), null);
});

const TWO_ASSISTANTS = Object.freeze({
  lifecycle: "ready",
  assistants: [
    { ...CHATGPT, detected: true, configured: true, connected: true },
    { ...CLAUDE_DESKTOP, detected: true, configured: true, connected: true, selected: true }
  ],
  selectedAssistantId: "claude-desktop",
  bridgeFolderReady: true,
  bridgeLoadedInChrome: true,
  bridgePaired: true,
  runtimeVerifiedCourseCount: 1,
  selectedCourseName: "BIOL 101",
  materialsFolder: MATERIALS
});

test("two configured assistants are both shown as set up, and the panel keeps the course step", () => {
  const current = state(TWO_ASSISTANTS);
  const view = actionView(current, { chosenAssistantId: "claude-desktop" });
  assert.equal(view.title, "Morrow cannot read your course yet.");
  assert.equal(view.copy, "Open your Canvas or Moodle course in Chrome and make sure you are signed in, then select Check status.");
  assert.doesNotMatch(`${view.title} ${view.copy} ${view.body}`, /is connected|not started/, "a course Morrow cannot read is never called connected");
  assert.equal(step(current, "Assistant").status, "done");
  assert.equal(step(current, "Assistant").detail, "ChatGPT, Claude Desktop");
  // Home carries neither assistant row now: that moved to Settings (D8).
  assert.equal(view.body.includes("<h3>ChatGPT</h3>"), false);
  assert.equal(view.body.includes("remove-assistant"), false);

  const settings = setupManagementView(current);
  assert.match(settings.body, /<h3>ChatGPT<\/h3><p>Morrow is set up in this assistant\.<\/p>/);
  assert.match(settings.body, /<h3>Claude Desktop<\/h3><p>Morrow is set up in this assistant\.<\/p>/);
  assert.deepEqual(actions(settings.body), ["reveal-materials-folder", "copy-example-prompt", "choose-workspace", "remove-assistant", "remove-assistant"]);
  assert.match(settings.body, /data-assistant-id="codex" aria-label="Remove Morrow from ChatGPT"/);
  assert.match(settings.body, /data-assistant-id="claude-desktop" aria-label="Remove Morrow from Claude Desktop"/);
  // Both assistants are written the new folder, and Claude Desktop needs the
  // approval again that only a person can give.
  assert.match(settings.body, /Changing it writes the new folder into ChatGPT and Claude Desktop\. Claude Desktop then asks you to approve Morrow again\./);
});

test("the folder row names every assistant the change writes to, in one sentence", () => {
  const settings = setupManagementView(state({
    ...CONNECTED_COURSE,
    assistants: [
      { ...CHATGPT, detected: true, configured: true, connected: true, selected: true },
      { ...CLAUDE_DESKTOP, detected: true, configured: true, connected: true },
      { id: "claude-code", title: "Claude Code", tier: "advanced", supported: true, needsWorkspace: true, detected: true, configured: true, connected: true }
    ],
    materialsFolder: MATERIALS
  }));
  assert.match(settings.body, /Changing it writes the new folder into ChatGPT, Claude Desktop and Claude Code\./);
});

test("a second assistant waiting for approval keeps the first assistant's steps", () => {
  // The regression this guards: Claude Desktop is added after ChatGPT is
  // already working, and the whole panel drops back to the approval screen.
  const current = state({
    ...CONNECTED_COURSE,
    lifecycle: "ready",
    assistants: [
      { ...CHATGPT, detected: true, configured: true, connected: true },
      { ...CLAUDE_DESKTOP, detected: true, pending: true, selected: true }
    ],
    selectedAssistantId: "claude-desktop",
    materialsFolder: MATERIALS,
    firstPreview: { available: true }
  });
  const view = actionView(current, { chosenAssistantId: "claude-desktop" });
  assert.equal(view.title, "Check your course connection.");
  assert.equal(statusSummary(current), "First read is ready");
  assert.equal(step(current, "Assistant").status, "done");
  assert.equal(step(current, "Assistant").detail, "ChatGPT");
  assert.deepEqual(actions(view.body), ["run-first-read"]);
  // The approval that is still waiting stays reachable, in the row it belongs
  // to, on Settings now.
  const settings = setupManagementView(current);
  assert.match(settings.body, /<h3>Claude Desktop<\/h3><p>Waiting for your approval in Claude Desktop\.<\/p>/);
  assert.deepEqual(actions(settings.body), ["reveal-materials-folder", "copy-example-prompt", "choose-workspace", "remove-assistant", "open-claude-desktop", "reveal-claude-extension", "check-claude-desktop", "remove-assistant"]);
});

test("removing Claude Desktop names the step that is left inside Claude Desktop", () => {
  const settings = setupManagementView(state(TWO_ASSISTANTS));
  assert.match(settings.body, /Remove takes away the Morrow extension Morrow made for Claude Desktop\. If Claude Desktop has it installed, remove Morrow there as well, under Settings, Extensions\./);
  // Only Claude Desktop keeps its own copy, so only its row says so.
  assert.equal(settings.body.match(/Remove takes away the Morrow extension/g).length, 1);
});

test("an assistant on this computer that is not set up can be set up after setup", () => {
  const current = state({
    ...CONNECTED_COURSE,
    assistants: [
      { ...CHATGPT, detected: true, configured: true, connected: true, selected: true },
      { ...CLAUDE_DESKTOP, detected: true },
      { id: "claude-code", title: "Claude Code", tier: "advanced", supported: true, needsWorkspace: true, detected: false }
    ],
    materialsFolder: MATERIALS
  });
  const settings = setupManagementView(current);
  assert.match(settings.body, /data-action="install-assistant" data-assistant-id="claude-desktop">Set up Claude Desktop<\/button>/);
  assert.match(settings.body, /<h3>Claude Desktop<\/h3><p>Not set up yet\.<\/p>/);
  // An assistant that is not on this computer is not offered as a choice.
  assert.equal(settings.body.includes("Claude Code"), false);
});

test("the completed course connection shows the three status lines, then three example requests, each with its own Copy button", () => {
  const current = state({ ...CONNECTED_COURSE, firstPreview: { available: true, completed: true } });
  const view = actionView(current, { chosenAssistantId: "codex" });
  assert.equal(view.title, "Your course is connected.");

  // The status lines (D8) come first: one row per area, one state word, one action.
  const rows = [...view.body.matchAll(/<li class="home-status-row"><span class="home-status-label">(.*?)<\/span><span class="home-status-word">(.*?)<\/span><button class="secondary-button" type="button" data-action="(.*?)">(.*?)<\/button><\/li>/g)]
    .map(([, label, word, action, actionLabel]) => ({ label, word, action, actionLabel }));
  assert.deepEqual(rows, [
    { label: "Assistant", word: "Ready", action: "open-settings", actionLabel: "Manage" },
    { label: "Morrow Bridge", word: "Connected", action: "check-bridge", actionLabel: "Check Bridge" },
    { label: "Courses", word: "Connected", action: "run-first-read", actionLabel: "Check connection" },
  ]);
  assert.ok(view.body.indexOf("home-status") < view.body.indexOf('<div class="prompt">'), "the status lines come before the example requests");

  const prompts = [
    "Find images with no alternative text in this course.",
    "Move the due date of the first assignment one week later.",
    "Summarize the modules in this course and flag anything that needs review."
  ];
  for (const prompt of prompts) {
    assert.ok(view.body.includes(`<div class="prompt"><span class="prompt-text">${prompt}</span>`), `the body names the request in its own text column: ${prompt}`);
    assert.match(
      view.body,
      new RegExp(`data-action="copy-example-prompt" data-prompt="${prompt.replace(/[.]/g, "\\.")}">Copy</button>`),
      `each request gets its own Copy button: ${prompt}`
    );
  }
  assert.deepEqual(actions(view.body), ["open-settings", "check-bridge", "run-first-read", "copy-example-prompt", "copy-example-prompt", "copy-example-prompt"]);
  // Setup management moved to Settings: Home carries none of it.
  assert.equal(view.body.includes("choose-workspace"), false);
});

// A title states what Morrow does, needs, or has done, so it carries a verb: a
// title that names only a thing tells a person nothing about it. These are the
// verbs the setup views use. A view whose title names no function, action,
// result or constraint fails here until it names one.
const TITLE_VERB = /\b(?:add|open|approve|are|ask|asks|can|cannot|change|check|choose|complete|completed|configures|confirm|connect|connected|continue|could|did|does|finish|found|get|has|install|is|keeps|leaves|opens|read|reads|ready|reload|remove|removes|repair|restart|returned|set|show|stays|use|uses|was|will|writes)\b/i;

// Names of things, with nothing said about them. None of them is a title.
const BARE_LABELS = new Set([
  "Updates", "Setup", "Morrow", "Morrow setup", "Your Morrow setup", "Support", "Help", "Assistant", "Assistants",
  "Bridge", "Morrow Bridge", "Connect", "Course", "Courses", "First read", "Materials folder", "Blackboard", "Data", "Retention"
]);

// The lead of an info or blocked box, which is the box's own title.
const boxLeads = (body) => [...body.matchAll(/(?:info|blocked)-box"><strong>([^<]*)<\/strong>/g)].map((entry) => entry[1]);

// Every view a person can reach, with the state that reaches it.
function everyView() {
  const panels = [
    ["no assistant", state({ assistants: [{ ...CHATGPT, detected: true }] })],
    ["no assistant on this computer", state({ assistants: [] })],
    ["Claude Desktop is pending", state({ lifecycle: "assistant_pending", assistants: [{ ...CLAUDE_DESKTOP, detected: true, pending: true, selected: true }], selectedAssistantId: "claude-desktop" })],
    ["the runtime is not ready", state({ ...READY_ASSISTANT, runtimeStatus: "uncertain" })],
    ["Bridge delivery is unavailable", state({ ...READY_ASSISTANT, bridgeDelivery: "unavailable" })],
    ["Chrome must reload the Bridge", state({ ...READY_ASSISTANT, bridgeManualChromeReloadRequired: true })],
    ["the Bridge folder is not ready", state({ ...READY_ASSISTANT, bridgeFolderReady: false })],
    ["the temporary Chrome step", state(READY_ASSISTANT)],
    ["the Chrome Web Store step", state({ ...READY_ASSISTANT, bridgeDelivery: "available" })],
    ["the Bridge is loaded but not paired", state({ ...READY_ASSISTANT, bridgeLoadedInChrome: true })],
    ["no course is connected", state(PAIRED)],
    ["the first read is preparing", state(CONNECTED_COURSE)],
    ["the first read is ready", state({ ...CONNECTED_COURSE, firstPreview: { available: true } })],
    ["the first read is complete", state({ ...CONNECTED_COURSE, firstPreview: { available: true, completed: true } })],
    ["Morrow needs repair", state({ lifecycle: "repair_required", runtimeStatus: "repair_required" })]
  ].map(([name, current]) => [name, actionView(current, { chosenAssistantId: null })]);
  return [
    ...panels,
    ["the setup state is unreadable", setupUnavailableView()],
    ["what stays on this computer", retention()],
    ["a removal that could not finish", retention({ removal: { status: "incomplete", removed: ["/Morrow/State"], remaining: ["/Morrow/Bridge"], kept: [] } })],
    ["where to get help", supportView(state({ ...CONNECTED_COURSE, materialsFolder: MATERIALS }))]
  ];
}

test("every view names a function, action, result or constraint, and no title is a bare label", () => {
  for (const [name, view] of everyView()) {
    for (const field of ["title", "copy", "body"]) {
      assert.equal(typeof view[field], "string", `${name}: ${field} is missing`);
      assert.notEqual(view[field].trim().length, 0, `${name}: ${field} is empty`);
    }
    assert.equal(BARE_LABELS.has(view.title), false, `${name}: the title "${view.title}" names a thing and nothing about it`);
    assert.ok(view.title.trim().split(/\s+/).length >= 3, `${name}: the title "${view.title}" is a label, not a statement`);
    assert.match(view.title, TITLE_VERB, `${name}: the title "${view.title}" names no action, result or constraint`);
    assert.match(view.copy, TITLE_VERB, `${name}: the copy "${view.copy}" names no action, result or constraint`);
    for (const lead of boxLeads(view.body)) {
      assert.notEqual(lead.trim().length, 0, `${name}: a box has an empty lead`);
      assert.match(lead, TITLE_VERB, `${name}: the box lead "${lead}" names no action, result or constraint`);
    }
  }
});

test("the assistant cards carry no eyebrow and promise no step setup does not take", () => {
  const current = state({
    assistants: [
      { ...CHATGPT, detected: true },
      { ...CLAUDE_DESKTOP, detected: true },
      { id: "claude-code", title: "Claude Code", tier: "advanced", supported: true, needsWorkspace: true, detected: true }
    ]
  });
  const view = actionView(current, { chosenAssistantId: "codex" });
  assert.equal(view.body.includes("choice-heading"), false, "the card group carries no eyebrow label");
  assert.equal(view.body.includes("Suggested assistants"), false);
  // Setup asks for a project folder only for the assistants in the disclosure,
  // so no card outside it says that it will.
  assert.equal(view.body.includes("Choose an assistant project when prompted"), false);
  assert.match(view.body, /<summary>Assistants that ask for a project folder<\/summary>/);
  assert.match(view.body, /Morrow asks you to choose that project during setup\./);
  assert.match(view.body, /<span class="assistant-detail">Ready to set up\.<\/span>/);
  assert.match(view.body, /Ready to set up\. You approve it in Claude Desktop\./);
});

test("the support surface names this Morrow, the folders it uses, and where to write", () => {
  const view = supportView(state({
    ...CONNECTED_COURSE,
    materialsFolder: MATERIALS,
    updates: { status: "idle", automatic: true, currentVersion: "1.0.0" },
    retention: { uninstall: "move_to_trash", locations: RETENTION_LOCATIONS }
  }));
  assert.match(view.body, /Morrow version<\/span><span class="support-value">1\.0\.0</);
  assert.ok(view.body.includes(escapeHtml(MATERIALS)), "the support surface names the materials folder");
  assert.ok(view.body.includes("/Morrow/State"), "the support surface names the folder Morrow keeps its setup record in");
  assert.ok(view.body.includes("https://meetmorrow.app/support"));
  // Chrome sandboxing denies in-window navigation, so the support address is a
  // control that asks the main process to open it (D5), not an <a> that would
  // do nothing.
  assert.equal(view.body.includes("<a "), false);
  assert.match(view.body, /<button class="quiet-button" type="button" data-action="open-support">https:\/\/meetmorrow\.app\/support<\/button>/);
  assert.match(view.copy, /Morrow opens its support page\. Select Support to open it, and name the version below when you write\./);
  assert.doesNotMatch(supportView(state({ ...CONNECTED_COURSE })).copy, /version below/, "no version row, so the copy names none");

  // A state Morrow could not read names no version and no folder, and still
  // says where to write.
  const unknown = supportView(null);
  assert.equal(unknown.body.includes("Morrow version"), false);
  assert.equal(unknown.body.includes("Materials folder"), false);
  assert.ok(unknown.body.includes("https://meetmorrow.app/support"));
  assert.match(unknown.body, /data-action="open-support"/);
});

test("a data removal is announced in the words the panel shows", () => {
  const announced = (removal) => removalAnnouncement(state({ retention: { uninstall: "move_to_trash", locations: RETENTION_LOCATIONS, removal } }));
  assert.equal(removalAnnouncement(null), "");
  assert.equal(removalAnnouncement(state()), "", "nothing is announced before a removal runs");
  assert.match(announced({ status: "cancelled", removed: [], remaining: [], kept: [] }), /Morrow removed nothing from this computer\./);
  assert.match(announced({ status: "removed", removed: ["/Morrow/State"], remaining: [], kept: [] }), /Quit Morrow before you remove the application\./);
  const incomplete = announced({ status: "incomplete", removed: ["/Morrow/State"], remaining: ["/Morrow/Bridge"], kept: [] });
  assert.match(incomplete, /Morrow could not remove everything\. One place is still on this computer/);
  assert.equal(/removed its data/.test(incomplete), false, "an incomplete removal never announces a complete one");
  assert.match(announced({ status: "incomplete", removed: [], remaining: ["/Morrow/State", "/Morrow/Bridge"], kept: [] }), /2 places are still on this computer/);
});

test("kept copies of assistant settings, and the entry a data removal takes out, are each explained", () => {
  const view = retentionView(state({ retention: { uninstall: "move_to_trash", locations: [
    ...RETENTION_LOCATIONS,
    { id: "backups", label: "Copies of assistant settings Morrow changed", path: "/Morrow/Assistant settings backups", removable: false, keptReason: "assistant_backup" }
  ] } }));
  assert.match(view.body, /Morrow keeps these copies so you can put a settings file back/);
  assert.match(view.body, /Remove Morrow&#39;s data takes only Morrow&#39;s own entry out of it/);
  assert.match(view.body, /first select Remove Morrow&#39;s data/);
});

test("an assistant card says Claude Desktop is not installed and where to get it", () => {
  const view = actionView(state({ assistants: [{ ...CHATGPT, detected: true }, { ...CLAUDE_DESKTOP, detected: false }] }));
  assert.match(view.body, /Claude Desktop is not installed on this computer\. Get it from claude\.ai\/download, then select Check status\./);
  const button = view.body.match(/<button class="assistant-card"[^>]*data-assistant-id="claude-desktop"[^>]*>/)[0];
  assert.match(button, /disabled/);
});

function connectedCourseFields() {
  return {
    lifecycle: "ready",
    selectedAssistantId: "codex",
    bridgeFolderReady: true,
    bridgeLoadedInChrome: true,
    bridgePaired: true,
    courseSite: true,
    runtimeVerifiedCourseCount: 1,
    selectedCourseName: "BIO 101",
    firstPreviewCourseName: "BIO 101",
    firstPreview: { available: true, completed: true },
  };
}

function connectedCourse(overrides = {}) {
  return state({
    lifecycle: "ready",
    assistants: [{ ...CHATGPT, detected: true, configured: true, connected: true, selected: true, connected: false, ...overrides }],
    selectedAssistantId: "codex",
    bridgeFolderReady: true,
    bridgeLoadedInChrome: true,
    bridgePaired: true,
    courseSite: true,
    runtimeVerifiedCourseCount: 1,
    selectedCourseName: "BIO 101",
    firstPreviewCourseName: "BIO 101",
    firstPreview: { available: true, completed: true },
  });
}

test("setup asks the teacher to quit and reopen the assistant before it says to continue there", () => {
  const waiting = actionView(connectedCourse());
  assert.equal(waiting.title, "Quit and reopen your assistant.");
  assert.match(waiting.body, /data-action="check-assistant-connection"/);
  assert.match(waiting.body, /Check ChatGPT/);
  assert.doesNotMatch(waiting.copy, /Continue in ChatGPT/);
  assert.equal(statusSummary(connectedCourse()), "Quit and reopen ChatGPT");

  const connected = actionView(connectedCourse({ connected: true }));
  assert.equal(connected.title, "Your course is connected.");
  assert.match(connected.copy, /Continue in ChatGPT/);
});

test("a failed assistant check names the button the panel shows, not a Check again button it does not have", () => {
  const panel = actionView(connectedCourse());
  const button = panel.body.match(/data-action="check-assistant-connection">([^<]+)</)[1];
  assert.equal(button, "Check ChatGPT");
  assert.doesNotMatch(panel.body, />Check again</);
  for (const code of ["assistant_not_connected", "assistant_connection_unconfirmed"]) {
    const { recovery } = errorDetails(code);
    assert.doesNotMatch(recovery, /Check again/, code);
    assert.match(recovery, /select the Check button that names your assistant\.$/, code);
  }
});

test("with more than one assistant set up, the reopen panel says Morrow cannot tell which one reopened", () => {
  const CLAUDE_CODE = { id: "claude-code", title: "Claude Code", tier: "advanced", supported: true, detected: true, configured: true, connected: false };
  const one = actionView(connectedCourse());
  assert.doesNotMatch(one.body, /cannot tell which/);
  const two = actionView(state({
    ...connectedCourseFields(),
    assistants: [{ ...CHATGPT, detected: true, configured: true, connected: false, selected: true }, CLAUDE_CODE],
  }));
  assert.equal(two.title, "Quit and reopen your assistant.");
  assert.match(two.body, /Morrow can tell that an assistant opened Morrow, but it cannot tell which one\. Quit and reopen each assistant you set up: ChatGPT and Claude Code\./);
});

test("while the panel says to quit and reopen the assistant, the rail shows the Assistant step as the current one", () => {
  const waiting = connectedCourse();
  assert.equal(step(waiting, "Assistant").status, "current");
  assert.equal(step(waiting, "Assistant").current, true);
  assert.equal(step(waiting, "Assistant").detail, "Quit and reopen ChatGPT");
  assert.deepEqual(progress(waiting).filter((entry) => entry.current).map((entry) => entry.label), ["Assistant"]);
  assert.equal(step(waiting, "Morrow Bridge").status, "done");
  assert.equal(step(waiting, "Course").status, "done");

  const connected = connectedCourse({ connected: true });
  assert.equal(step(connected, "Assistant").status, "done");
  assert.deepEqual(progress(connected).filter((entry) => entry.current), []);
});

test("a Mac Morrow outside Applications offers only the move", () => {
  const view = actionView(state({ lifecycle: "move_required", appLocation: "move_required", assistants: [{ ...CHATGPT, detected: true }] }));
  assert.equal(view.title, "Move Morrow to Applications.");
  assert.match(view.body, /data-action="move-to-applications"/);
  assert.doesNotMatch(view.body, /install-assistant/);
  assert.equal(statusSummary(state({ lifecycle: "move_required", appLocation: "move_required" })), "Move Morrow to Applications");
});

test("an assistant that still starts Morrow from where it was asks for the repair that re-points it", () => {
  const view = actionView(state({ assistantsNeedRepoint: true, assistants: [{ ...CHATGPT, detected: true, configured: false, selected: true }] }));
  assert.equal(view.title, "Update your assistant settings.");
  assert.match(view.body, /data-action="repair"/);
});

function addBridgeState() {
  return state({
    lifecycle: "assistant_ready",
    assistants: [{ ...CHATGPT, detected: true, configured: true, connected: true, selected: true }],
    selectedAssistantId: "codex",
    bridgeFolderReady: true,
    bridgeFolderPath: "/Users/t/Library/Application Support/Morrow/Bridge",
  });
}

test("the Chrome step shows the full Bridge folder path, a Copy button, and the way to reach a hidden folder", () => {
  const mac = actionView(addBridgeState(), { platform: "darwin" });
  assert.equal(mac.title, "Add Morrow Bridge.");
  assert.match(mac.body, /\/Users\/t\/Library\/Application Support\/Morrow\/Bridge/);
  assert.match(mac.body, /data-action="copy-example-prompt" data-prompt="\/Users\/t\/Library\/Application Support\/Morrow\/Bridge"/);
  assert.match(mac.body, /Command\+Shift\+G/);
  const windows = actionView(state({ ...addBridgeStateInput(), bridgeFolderPath: "C:\\Users\\t\\AppData\\Roaming\\Morrow\\Bridge" }), { platform: "win32" });
  assert.match(windows.body, /address bar at the top of the folder picker/);
  assert.doesNotMatch(windows.body, /Command\+Shift\+G/);
  assert.doesNotMatch(mac.body, /Chrome has not loaded Morrow Bridge yet/);

  const late = actionView(addBridgeState(), { platform: "darwin", bridgeWaitExpired: true });
  assert.match(late.body, /Chrome has not loaded Morrow Bridge yet/);
});

function addBridgeStateInput() {
  return {
    lifecycle: "assistant_ready",
    assistants: [{ ...CHATGPT, detected: true, configured: true, connected: true, selected: true }],
    selectedAssistantId: "codex",
    bridgeFolderReady: true,
  };
}

test("the renderer can tell when the Chrome folder step is the one on screen", () => {
  assert.equal(awaitingBridgeFolder(addBridgeState()), true);
  assert.equal(awaitingBridgeFolder(state({ ...addBridgeStateInput(), bridgeLoadedInChrome: true })), false);
  assert.equal(awaitingBridgeFolder(state({ lifecycle: "ready_for_assistant" })), false);
});

// The one line the header's polite live region announces for each panel. A
// screen reader hears the step on screen, never a later or an earlier one.
const PANEL_SUMMARIES = Object.freeze({
  "Move Morrow to Applications.": "Move Morrow to Applications",
  "Repair Morrow before you connect a course.": "Morrow needs repair",
  "Update your assistant settings.": "Update your assistant settings",
  "Finish setting up Claude Desktop.": "Finish setting up Claude Desktop",
  "Choose your assistant.": "Choose your assistant",
  "Morrow is getting ready.": "Morrow is getting ready",
  "Morrow Bridge is not available yet.": "Morrow Bridge is not available yet",
  "Reload Morrow Bridge.": "Reload Morrow Bridge in Chrome",
  "Update Morrow Bridge.": "Update Morrow Bridge",
  "Morrow Bridge is not ready to open.": "Morrow Bridge is not ready to open",
  "Add Morrow Bridge.": "Set up Morrow Bridge in Chrome",
  "Install Morrow Bridge.": "Set up Morrow Bridge in Chrome",
  "Connect Morrow Bridge.": "Connect Morrow Bridge",
  "Open your course in Chrome.": "Morrow Bridge is connected",
  "Morrow cannot read your course yet.": "Morrow cannot read your course yet",
  "Check your course connection.": "First read is ready",
  "Quit and reopen your assistant.": "Quit and reopen ChatGPT",
  "Your course is connected.": "First read complete"
});

test("the header live region announces the same step the action panel shows, for every panel", () => {
  const panels = [
    state({ lifecycle: "move_required", appLocation: "move_required", assistants: [{ ...CHATGPT, detected: true }] }),
    state({ lifecycle: "repair_required", runtimeStatus: "repair_required" }),
    // Morrow moved: the panel asks for the assistant settings even after a first read.
    state({ ...CONNECTED_COURSE, assistantsNeedRepoint: true, firstPreview: { available: true, completed: true } }),
    state({ lifecycle: "assistant_pending", assistants: [{ ...CLAUDE_DESKTOP, detected: true, pending: true, selected: true }], selectedAssistantId: "claude-desktop" }),
    state({ assistants: [{ ...CHATGPT, detected: true }] }),
    state({ ...READY_ASSISTANT, runtimeStatus: "uncertain" }),
    state({ ...READY_ASSISTANT, bridgeDelivery: "unavailable" }),
    state({ ...READY_ASSISTANT, bridgeManualChromeReloadRequired: true }),
    // A connected Bridge has a newer release to take.
    state({ ...PAIRED, bridgeUpdateAvailable: true }),
    // The Bridge folder is not verified.
    state({ ...READY_ASSISTANT, bridgeFolderReady: false }),
    state(READY_ASSISTANT),
    state({ ...READY_ASSISTANT, bridgeDelivery: "available" }),
    // Chrome loaded the Bridge, and it is not paired yet.
    state({ ...READY_ASSISTANT, bridgeLoadedInChrome: true }),
    state(PAIRED),
    state(CONNECTED_COURSE),
    state({ ...CONNECTED_COURSE, firstPreview: { available: true } }),
    connectedCourse(),
    connectedCourse({ connected: true })
  ];
  const seen = new Set();
  for (const current of panels) {
    const view = actionView(current, { chosenAssistantId: null });
    assert.ok(Object.hasOwn(PANEL_SUMMARIES, view.title), `no summary is recorded for "${view.title}"`);
    assert.equal(view.summary, PANEL_SUMMARIES[view.title], `the panel "${view.title}" carries its own summary`);
    assert.equal(statusSummary(current), view.summary, `the header announces "${statusSummary(current)}" while the panel shows "${view.title}"`);
    seen.add(view.title);
  }
  assert.deepEqual([...seen].sort(), Object.keys(PANEL_SUMMARIES).sort(), "every panel is covered");
  assert.equal(statusSummary(null), "Checking setup");
});
