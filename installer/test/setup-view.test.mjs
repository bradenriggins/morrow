import assert from "node:assert/strict";
import test from "node:test";
import { installerState } from "../shared/contract.cjs";
import { actionView, blackboardSetupOffered, escapeHtml, progress, removalAnnouncement, retentionView, setupUnavailableView, statusSummary, supportView } from "../shared/setup-view.mjs";

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
  assistants: [{ ...CHATGPT, detected: true, configured: true, selected: true }],
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
  assert.equal(statusSummary(current), "Continue setup");
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

test("the local runtime is not ready yet", () => {
  const current = state({ ...READY_ASSISTANT, runtimeStatus: "uncertain" });
  const view = actionView(current, { chosenAssistantId: "codex" });
  assert.equal(view.title, "Morrow is getting ready.");
  // The panel offers no step from this state. What it does offer is the setup
  // a person can change in every state after setup, and nothing else.
  assert.deepEqual(actions(view.body), ["choose-workspace", "remove-assistant"]);
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
  // Numbered instructions name the Chrome menu path. Morrow opens no browser page.
  assert.match(view.body, /<ol class="instructions">/);
  assert.match(view.body, /<strong>Manage Extensions<\/strong>/);
  assert.doesNotMatch(view.body, /open-bridge-install/);
  assert.doesNotMatch(view.body, /chrome:\/\//);
  assert.equal(statusSummary(current), "Reload Morrow Bridge in Chrome");
  assert.equal(step(current, "Bridge").status, "current");
  assert.equal(step(current, "Bridge").detail, "Reload in Chrome, then check");
});

test("Bridge delivery is unavailable", () => {
  const current = state({ ...READY_ASSISTANT, lifecycle: "bridge_delivery_unavailable", bridgeDelivery: "unavailable" });
  const view = actionView(current, { chosenAssistantId: "codex" });
  assert.equal(view.title, "Morrow Bridge is not available yet.");
  assert.deepEqual(actions(view.body), ["choose-workspace", "remove-assistant"], "no Chrome step is offered from a blocked delivery");
  assert.equal(statusSummary(current), "Morrow Bridge is not available yet");
  assert.equal(step(current, "Bridge").status, "blocked");
  assert.equal(step(current, "Bridge").detail, "Not available yet");
});

test("an unavailable Bridge delivery blocks the action view on its own", () => {
  const current = state({ ...READY_ASSISTANT, bridgeDelivery: "unavailable" });
  assert.equal(actionView(current, { chosenAssistantId: "codex" }).title, "Morrow Bridge is not available yet.");
  assert.equal(step(current, "Bridge").status, "blocked");
});

test("a ready Bridge folder that Chrome has not confirmed still asks for the Chrome step", () => {
  const current = state(READY_ASSISTANT);
  assert.equal(current.bridge.folderReady, true);
  assert.equal(current.bridge.loadedInChrome, "unknown");
  const view = actionView(current, { chosenAssistantId: "codex" });
  assert.equal(view.title, "Add Morrow Bridge.");
  assert.match(view.body, /data-action="reveal-bridge-folder"/);
  assert.equal(statusSummary(current), "Set up Morrow Bridge in Chrome");
  assert.equal(step(current, "Bridge").status, "current");

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
  assert.equal(step(current, "Bridge").status, "current");
});

test("a confirmed load in Chrome moves setup on to the connection", () => {
  const current = state({ ...READY_ASSISTANT, bridgeLoadedInChrome: true });
  const view = actionView(current, { chosenAssistantId: "codex" });
  assert.equal(view.title, "Connect Morrow Bridge.");
  assert.match(view.body, /data-action="check-bridge"/);
  assert.equal(step(current, "Bridge").status, "done");
  assert.equal(step(current, "Bridge").detail, "Installed in Chrome");
  assert.equal(step(current, "Connect").status, "current");
});

test("a paired Bridge without a connected course asks for the course", () => {
  const current = state(PAIRED);
  const view = actionView(current, { chosenAssistantId: "codex" });
  assert.equal(view.title, "Connect your course.");
  assert.equal(statusSummary(current), "Morrow Bridge is connected");
  assert.equal(step(current, "Connect").status, "done");
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
  assert.equal(step(current, "First read").status, "current");
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
    assert.equal(steps.length, 5);
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
  assert.match(windows.body, /select Apps, select Morrow, and select Uninstall/);
  assert.equal(/Trash/.test(windows.body), false);

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

test("the materials folder is named, and can be changed, in every state after setup", () => {
  // Every state a person reaches once an assistant is set up. Each one names
  // the exact folder and offers the change, so the folder is never a choice
  // that can only be made on the first screen.
  const cases = [
    ["assistant is configured", READY_ASSISTANT],
    ["Chrome has the Bridge loaded", { ...READY_ASSISTANT, bridgeLoadedInChrome: true }],
    ["the Bridge is paired", PAIRED],
    ["a course is connected", CONNECTED_COURSE],
    ["the first read is complete", { ...CONNECTED_COURSE, firstPreview: { available: true, completed: true } }]
  ];
  for (const [name, fields] of cases) {
    const current = state({ ...fields, materialsFolder: MATERIALS });
    const view = actionView(current, { chosenAssistantId: "codex" });
    assert.ok(view.body.includes(escapeHtml(MATERIALS)), `${name}: the folder is named`);
    assert.match(view.body, /data-action="choose-workspace">Change folder<\/button>/, name);
    assert.match(view.body, /Changing it writes the new folder into ChatGPT\./, name);
  }
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
  assert.match(unknown.body, /If you continue, Morrow creates its own Materials folder\./);
});

test("the repair state offers the repair alone, with no setup to change", () => {
  const view = actionView(state({
    lifecycle: "repair_required",
    runtimeStatus: "repair_required",
    assistants: [{ ...CHATGPT, detected: true, configured: true, selected: true }],
    materialsFolder: MATERIALS
  }), { chosenAssistantId: null });
  assert.deepEqual(actions(view.body), ["repair", "check-setup-state"]);
  assert.equal(view.body.includes(MATERIALS), false, "the folder cannot be changed from a state Morrow cannot read");
});

const TWO_ASSISTANTS = Object.freeze({
  lifecycle: "ready",
  assistants: [
    { ...CHATGPT, detected: true, configured: true },
    { ...CLAUDE_DESKTOP, detected: true, configured: true, selected: true }
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
  assert.equal(view.title, "Your selected course is connected.");
  assert.equal(step(current, "Assistant").status, "done");
  assert.equal(step(current, "Assistant").detail, "ChatGPT, Claude Desktop");
  assert.match(view.body, /<h3>ChatGPT<\/h3><p>Morrow is set up in this assistant\.<\/p>/);
  assert.match(view.body, /<h3>Claude Desktop<\/h3><p>Morrow is set up in this assistant\.<\/p>/);
  assert.deepEqual(actions(view.body), ["choose-workspace", "remove-assistant", "remove-assistant"]);
  assert.match(view.body, /data-assistant-id="codex" aria-label="Remove Morrow from ChatGPT"/);
  assert.match(view.body, /data-assistant-id="claude-desktop" aria-label="Remove Morrow from Claude Desktop"/);
  // Both assistants are written the new folder, and Claude Desktop needs the
  // approval again that only a person can give.
  assert.match(view.body, /Changing it writes the new folder into ChatGPT and Claude Desktop\. Claude Desktop then asks you to approve Morrow again\./);
});

test("the folder row names every assistant the change writes to, in one sentence", () => {
  const view = actionView(state({
    ...CONNECTED_COURSE,
    assistants: [
      { ...CHATGPT, detected: true, configured: true, selected: true },
      { ...CLAUDE_DESKTOP, detected: true, configured: true },
      { id: "claude-code", title: "Claude Code", tier: "advanced", supported: true, needsWorkspace: true, detected: true, configured: true }
    ],
    materialsFolder: MATERIALS
  }), { chosenAssistantId: "codex" });
  assert.match(view.body, /Changing it writes the new folder into ChatGPT, Claude Desktop and Claude Code\./);
});

test("a second assistant waiting for approval keeps the first assistant's steps", () => {
  // The regression this guards: Claude Desktop is added after ChatGPT is
  // already working, and the whole panel drops back to the approval screen.
  const current = state({
    ...CONNECTED_COURSE,
    lifecycle: "ready",
    assistants: [
      { ...CHATGPT, detected: true, configured: true },
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
  // The approval that is still waiting stays reachable, in the row it belongs to.
  assert.match(view.body, /<h3>Claude Desktop<\/h3><p>Waiting for your approval in Claude Desktop\.<\/p>/);
  assert.deepEqual(actions(view.body), ["run-first-read", "choose-workspace", "remove-assistant", "open-claude-desktop", "reveal-claude-extension", "check-claude-desktop", "remove-assistant"]);
});

test("removing Claude Desktop names the step that is left inside Claude Desktop", () => {
  const view = actionView(state(TWO_ASSISTANTS), { chosenAssistantId: "claude-desktop" });
  assert.match(view.body, /Remove takes away the Morrow extension Morrow made for Claude Desktop\. If Claude Desktop has it installed, remove Morrow there as well, under Settings, Extensions\./);
  // Only Claude Desktop keeps its own copy, so only its row says so.
  assert.equal(view.body.match(/Remove takes away the Morrow extension/g).length, 1);
});

test("an assistant on this computer that is not set up can be set up after setup", () => {
  const current = state({
    ...CONNECTED_COURSE,
    assistants: [
      { ...CHATGPT, detected: true, configured: true, selected: true },
      { ...CLAUDE_DESKTOP, detected: true },
      { id: "claude-code", title: "Claude Code", tier: "advanced", supported: true, needsWorkspace: true, detected: false }
    ],
    materialsFolder: MATERIALS
  });
  const view = actionView(current, { chosenAssistantId: "codex" });
  assert.match(view.body, /data-action="install-assistant" data-assistant-id="claude-desktop">Set up Claude Desktop<\/button>/);
  assert.match(view.body, /<h3>Claude Desktop<\/h3><p>Not set up yet\.<\/p>/);
  // An assistant that is not on this computer is not offered as a choice.
  assert.equal(view.body.includes("Claude Code"), false);
});

// A title states what Morrow does, needs, or has done, so it carries a verb: a
// title that names only a thing tells a person nothing about it. These are the
// verbs the setup views use. A view whose title names no function, action,
// result or constraint fails here until it names one.
const TITLE_VERB = /\b(?:add|approve|are|ask|asks|can|cannot|change|check|choose|complete|completed|configures|confirm|connect|connected|continue|could|did|does|finish|found|get|has|install|is|keeps|leaves|opens|read|reads|ready|reload|remove|removes|repair|restart|returned|set|show|stays|use|uses|was|will|writes)\b/i;

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
  // Morrow opens no web page, so the address is text a person reads, not a link
  // that would do nothing.
  assert.equal(view.body.includes("<a "), false);

  // A state Morrow could not read names no version and no folder, and still
  // says where to write.
  const unknown = supportView(null);
  assert.equal(unknown.body.includes("Morrow version"), false);
  assert.equal(unknown.body.includes("Materials folder"), false);
  assert.ok(unknown.body.includes("https://meetmorrow.app/support"));
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
