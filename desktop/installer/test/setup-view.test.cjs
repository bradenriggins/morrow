const assert = require("node:assert/strict");
const test = require("node:test");
const { installerState } = require("../shared/contract.cjs");

const view = import("../shared/setup-view.mjs");

const STEPS = ["Assistant", "Morrow Bridge", "Course"];

const BASE = {
  lifecycle: "ready_for_assistant",
  assistants: [],
  selectedAssistantId: null,
  workspaceSelected: true,
  runtimeStatus: "ready",
  bridgeDelivery: "developer_temporary",
  bridgeLoadedInChrome: "unknown",
  bridgeFolderReady: false,
  bridgePaired: "unknown",
  courseSite: "unknown",
  runtimeVerifiedCourseCount: 0,
  selectedCourseName: null
};

const CHATGPT = { id: "codex", title: "ChatGPT", tier: "primary", supported: true, needsWorkspace: true };
const CLAUDE_DESKTOP = { id: "claude-desktop", title: "Claude Desktop", tier: "primary", supported: true, needsWorkspace: true };

const CONFIGURED = {
  lifecycle: "assistant_ready",
  assistants: [{ ...CHATGPT, detected: true, configured: true, selected: true }],
  selectedAssistantId: "codex"
};

const PAIRED = { ...CONFIGURED, bridgeLoadedInChrome: true, bridgeFolderReady: true, bridgePaired: true };

function state(overrides = {}) {
  return installerState({ ...BASE, ...overrides });
}

const CASES = [
  {
    name: "no assistant is chosen",
    state: state({ assistants: [{ ...CHATGPT, detected: true }] }),
    current: "Assistant",
    title: "Choose your assistant."
  },
  {
    name: "Claude Desktop is waiting for approval",
    state: state({
      lifecycle: "assistant_pending",
      assistants: [{ ...CLAUDE_DESKTOP, detected: true, pending: true, selected: true }],
      selectedAssistantId: "claude-desktop"
    }),
    current: "Assistant",
    title: "Finish setting up Claude Desktop."
  },
  {
    name: "the local runtime is not ready",
    state: state({ ...CONFIGURED, runtimeStatus: "uncertain" }),
    current: "Morrow Bridge",
    title: "Morrow is getting ready."
  },
  {
    name: "Bridge delivery is blocked",
    state: state({ ...CONFIGURED, lifecycle: "bridge_delivery_unavailable", bridgeDelivery: "unavailable" }),
    current: "Morrow Bridge",
    title: "Morrow Bridge is not available yet."
  },
  {
    name: "Chrome must reload a staged Bridge update",
    state: state({ ...CONFIGURED, bridgeManualChromeReloadRequired: true }),
    current: "Morrow Bridge",
    title: "Reload Morrow Bridge."
  },
  {
    name: "the Bridge folder is not ready yet",
    state: state({ ...CONFIGURED, bridgeFolderReady: false }),
    current: "Morrow Bridge",
    title: "Morrow Bridge is not ready to open."
  },
  {
    name: "the Bridge folder is ready and Chrome has not confirmed the Bridge",
    state: state({ ...CONFIGURED, bridgeFolderReady: true }),
    current: "Morrow Bridge",
    title: "Add Morrow Bridge."
  },
  {
    name: "the Chrome Web Store route is available",
    state: state({ ...CONFIGURED, bridgeDelivery: "available", bridgeFolderReady: true }),
    current: "Morrow Bridge",
    title: "Install Morrow Bridge."
  },
  {
    name: "Chrome has the Bridge loaded but it is not paired",
    state: state({ ...CONFIGURED, bridgeLoadedInChrome: true, bridgeFolderReady: true }),
    current: "Morrow Bridge",
    title: "Connect Morrow Bridge."
  },
  {
    name: "the Bridge is paired without a course",
    state: state(PAIRED),
    current: "Course",
    title: "Open your course in Chrome."
  },
  {
    name: "a course is verified and the first read is not ready",
    state: state({ ...PAIRED, runtimeVerifiedCourseCount: 1, selectedCourseName: "BIOL 101" }),
    current: "Course",
    title: "Your selected course is connected."
  },
  {
    name: "the first read is ready",
    state: state({ ...PAIRED, runtimeVerifiedCourseCount: 1, selectedCourseName: "BIOL 101", firstPreview: { available: true } }),
    current: "Course",
    title: "Check your course connection."
  },
  {
    name: "the first read is complete",
    state: state({ ...PAIRED, runtimeVerifiedCourseCount: 1, selectedCourseName: "BIOL 101", firstPreview: { available: true, completed: true } }),
    current: null,
    title: "Your course is connected."
  },
  {
    name: "Morrow needs repair",
    state: state({ lifecycle: "repair_required", runtimeStatus: "repair_required" }),
    current: null,
    title: "Repair Morrow before you connect a course."
  }
];

test("every setup state lists the steps in the order the setup actually runs", async () => {
  const { progress } = await view;
  for (const scenario of CASES) {
    assert.deepEqual(progress(scenario.state).map((step) => step.label), STEPS, scenario.name);
  }
});

test("each setup state marks the step the action panel is asking for", async () => {
  const { actionView, progress } = await view;
  for (const scenario of CASES) {
    const current = progress(scenario.state).filter((step) => step.current).map((step) => step.label);
    assert.deepEqual(current, scenario.current ? [scenario.current] : [], scenario.name);
    assert.equal(actionView(scenario.state, { chosenAssistantId: null }).title, scenario.title, scenario.name);
  }
});

test("no step is both done and current, and every view answers with a title, copy, and body", async () => {
  const { actionView, progress, statusSummary } = await view;
  for (const scenario of CASES) {
    const steps = progress(scenario.state);
    assert.equal(steps.length, STEPS.length, scenario.name);
    for (const step of steps) {
      assert.equal(step.status === "done" && step.current, false, `${scenario.name}: ${step.label}`);
      assert.equal(typeof step.detail, "string", `${scenario.name}: ${step.label}`);
      assert.notEqual(step.detail.length, 0, `${scenario.name}: ${step.label}`);
    }
    const panel = actionView(scenario.state, { chosenAssistantId: null });
    for (const field of ["title", "copy", "body"]) {
      assert.equal(typeof panel[field], "string", `${scenario.name}: ${field}`);
      assert.notEqual(panel[field].length, 0, `${scenario.name}: ${field}`);
    }
    assert.equal(typeof statusSummary(scenario.state), "string", scenario.name);
  }
});

test("the Morrow Bridge stage covers installation and pairing", async () => {
  const { progress } = await view;
  const step = (current, label) => progress(current).find((entry) => entry.label === label);
  const temporary = state({ ...CONFIGURED, bridgeFolderReady: true });
  assert.equal(step(temporary, "Morrow Bridge").status, "current");
  assert.equal(step(temporary, "Morrow Bridge").detail, "Add in Chrome");

  const blocked = state({ ...CONFIGURED, bridgeDelivery: "unavailable" });
  assert.equal(step(blocked, "Morrow Bridge").status, "blocked");
  assert.equal(step(blocked, "Morrow Bridge").detail, "Not available yet");

  const installed = state({ ...CONFIGURED, bridgeLoadedInChrome: true, bridgeFolderReady: true });
  assert.equal(step(installed, "Morrow Bridge").status, "current");
  assert.equal(step(installed, "Morrow Bridge").detail, "Installed; connect to Morrow");

  const paired = state(PAIRED);
  assert.equal(step(paired, "Morrow Bridge").status, "done");
  assert.equal(step(paired, "Morrow Bridge").detail, "Connected to Morrow");
});

test("the course stage carries course selection through the first read", async () => {
  const { progress } = await view;
  const firstRead = (overrides) => progress(state({ ...PAIRED, runtimeVerifiedCourseCount: 1, selectedCourseName: "BIOL 101", ...overrides }))
    .find((step) => step.label === "Course");
  assert.equal(firstRead({}).detail, "BIOL 101; first read not started");
  assert.equal(firstRead({ firstPreview: { available: true } }).detail, "BIOL 101; first read ready");
  assert.equal(firstRead({ firstPreview: { available: true, completed: true } }).detail, "BIOL 101; first read complete");
  assert.equal(firstRead({ firstPreview: { available: true, completed: true } }).status, "done");
});

test("the optional Blackboard form is offered only after an assistant is configured and the runtime is ready", async () => {
  const { blackboardSetupOffered } = await view;
  // Every state a person passes through before an assistant is configured. The
  // Blackboard form asks for credentials, so none of these may show it.
  assert.equal(blackboardSetupOffered(null), false, "no setup state");
  assert.equal(blackboardSetupOffered(state({ assistants: [{ ...CHATGPT, detected: true }] })), false, "no assistant chosen");
  assert.equal(blackboardSetupOffered(state({
    lifecycle: "assistant_pending",
    assistants: [{ ...CLAUDE_DESKTOP, detected: true, pending: true, selected: true }],
    selectedAssistantId: "claude-desktop"
  })), false, "an assistant is waiting for approval");
  assert.equal(blackboardSetupOffered(state({ lifecycle: "repair_required", runtimeStatus: "repair_required" })), false, "Morrow needs repair");
  // Saving, listing and removing a connection each read Morrow's own private
  // file access from the local runtime, so none of them is offered before it.
  assert.equal(blackboardSetupOffered(state({ ...CONFIGURED, runtimeStatus: "uncertain" })), false, "the local runtime is not ready");
  // A configured assistant offers it, and every later step keeps it offered.
  assert.equal(blackboardSetupOffered(state(CONFIGURED)), true, "the assistant is configured");
  assert.equal(blackboardSetupOffered(state(PAIRED)), true, "the Bridge is paired");
  assert.equal(blackboardSetupOffered(state({ ...PAIRED, runtimeVerifiedCourseCount: 1, selectedCourseName: "BIOL 101" })), true, "a course is connected");
});

test("a missing setup state claims no progress", async () => {
  const { progress, statusSummary } = await view;
  const steps = progress(null);
  assert.deepEqual(steps.map((step) => step.label), STEPS);
  for (const step of steps) {
    assert.equal(step.status, "pending", step.label);
    assert.equal(step.current, false, step.label);
    assert.equal(step.detail, "Not checked yet", step.label);
  }
  assert.equal(statusSummary(null), "Checking setup");
});

test("the unreadable-state view names the failure and offers one retry", async () => {
  const { setupUnavailableView } = await view;
  const panel = setupUnavailableView();
  assert.equal(panel.title, "Morrow could not read its setup state.");
  assert.equal(panel.summary, "Morrow could not read its setup state");
  assert.match(panel.copy, /No setup step ran\./);
  assert.match(panel.body, /data-action="check-setup-state"/);
  assert.equal(panel.body.match(/data-action=/g).length, 1);
});

test("a problem keeps its own message and falls back to plain recovery text", async () => {
  const { problemView } = await view;
  assert.equal(problemView(null), null);
  assert.deepEqual(problemView({ message: "Morrow could not open Chrome.", recovery: "Open Chrome, then check again." }), {
    message: "Morrow could not open Chrome.",
    recovery: "Open Chrome, then check again."
  });
  assert.deepEqual(problemView({}), {
    message: "Morrow could not complete that step.",
    recovery: "Check the setup state and try again."
  });
});
