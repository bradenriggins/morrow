import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { installerState } from "../../installer/shared/contract.cjs";
import { actionView, progress, setupUnavailableView } from "../../installer/shared/setup-view.mjs";
import { setupGuideState } from "../../connector/extension/onboarding/onboarding-state.js";
import { courseValue, detailText, primaryLabel, statusValue } from "../../connector/extension/popup/popup-view.js";

/**
 * The gate on `docs/implementation/FIRST-RUN-STATE-INVENTORY.md`. The inventory is useful only while
 * it is exact, so this test runs the same view functions the product runs and requires the inventory
 * to carry what they produce, to list one state per branch those functions have, to cite the line
 * each state's own text is written on, and to name every control on the line that carries it. Every
 * failure names the line to correct.
 */
const root = new URL("../../", import.meta.url);
const read = (relativePath) => readFileSync(new URL(relativePath, root), "utf8");
const lines = (relativePath) => read(relativePath).split("\n");
const INVENTORY = "docs/implementation/FIRST-RUN-STATE-INVENTORY.md";
const inventory = read(INVENTORY);
const CITATION = /`([A-Za-z0-9_./-]+\.(?:mjs|cjs|js|ts|html)):(\d+)(?:-(\d+))?`/g;

/** The rows of the first table under a heading, as {state, sees, source}. */
function rowsUnder(sectionHeading) {
  const start = inventory.indexOf(`\n## ${sectionHeading}`);
  assert.notEqual(start, -1, `${INVENTORY} has no section "${sectionHeading}"`);
  const next = inventory.indexOf("\n## ", start + 1);
  const body = inventory.slice(start, next === -1 ? undefined : next);
  const table = body.slice(body.indexOf("\n| --- "));
  const end = table.indexOf("\n\n");
  return [...(end === -1 ? table : table.slice(0, end)).matchAll(/^\| `([a-z0-9-]+)` \| (.*?) \| (.*?) \| (.*?) \|$/gm)]
    .map(([, state, sees, , source]) => ({ state, sees, source }));
}

/** Fails with the produced text when the inventory does not carry it. */
function carries(value, where) {
  assert.ok(inventory.includes(value), `${INVENTORY} does not carry what ${where} produces: ${JSON.stringify(value)}`);
}

/**
 * Whether one row cites the line the state's own text is written on. Returns the correction to make
 * when it does not, so the failure names the line rather than only the mismatch.
 */
function citationProblem(row, literal) {
  const cited = [...row.source.matchAll(CITATION)];
  assert.ok(cited.length > 0, `${INVENTORY} state \`${row.state}\` cites no source`);
  for (const [, path, from, to] of cited) {
    const text = lines(path);
    for (let line = Number(from); line <= Number(to || from); line += 1) {
      if (text[line - 1]?.includes(literal)) return null;
    }
  }
  const [, path] = cited[0];
  const found = lines(path).findIndex((text) => text.includes(literal)) + 1;
  return found
    ? `\`${row.state}\` must cite ${path}:${found}, which carries ${JSON.stringify(literal)}`
    : `\`${row.state}\` quotes ${JSON.stringify(literal)}, which is in none of the source it cites`;
}

// --- Morrow app setup window -------------------------------------------------------------------

const CHATGPT = Object.freeze({ id: "codex", title: "ChatGPT", tier: "primary", supported: true, needsWorkspace: true });
const CLAUDE_DESKTOP = Object.freeze({ id: "claude-desktop", title: "Claude Desktop", tier: "primary", supported: true, needsWorkspace: true });

function installer(overrides = {}) {
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
    ...overrides,
  });
}

const ASSISTANT_READY = Object.freeze({
  lifecycle: "assistant_ready",
  assistants: [{ ...CHATGPT, detected: true, configured: true, selected: true }],
  selectedAssistantId: "codex",
  bridgeFolderReady: true,
});
const PAIRED = Object.freeze({ ...ASSISTANT_READY, bridgeLoadedInChrome: true, bridgePaired: true });
const COURSE_READY = Object.freeze({ ...PAIRED, runtimeVerifiedCourseCount: 1, selectedCourseName: "BIOL 101" });

// One state per branch of the setup window's action panel, named as the inventory names it.
const INSTALLER_STATES = new Map([
  ["repair", installer({ lifecycle: "repair_required" })],
  ["claude-pending", installer({ assistants: [{ ...CLAUDE_DESKTOP, detected: true, pending: true, selected: true }], selectedAssistantId: "claude-desktop" })],
  ["no-assistant", installer({ assistants: [{ ...CHATGPT, detected: true }] })],
  ["runtime-not-ready", installer({ ...ASSISTANT_READY, runtimeStatus: "starting" })],
  ["delivery-blocked", installer({ ...ASSISTANT_READY, bridgeDelivery: "unavailable" })],
  ["reload-required", installer({ ...ASSISTANT_READY, bridgeManualChromeReloadRequired: true })],
  ["folder-not-ready", installer({ ...ASSISTANT_READY, bridgeFolderReady: false })],
  ["dev-temporary", installer({ ...ASSISTANT_READY })],
  ["store-available", installer({ ...ASSISTANT_READY, bridgeDelivery: "available" })],
  ["not-paired", installer({ ...ASSISTANT_READY, bridgeLoadedInChrome: true })],
  ["no-course", installer({ ...PAIRED })],
  ["preview-ready", installer({ ...COURSE_READY, firstPreview: { available: true } })],
  ["preview-preparing", installer({ ...COURSE_READY })],
  ["preview-completed", installer({ ...COURSE_READY, firstPreview: { available: true, completed: true } })],
]);

// The two states the renderer owns rather than the action panel: the first read, and a read that failed.
const RENDERER_STATES = ["first-paint", "setup-unavailable"];
const INSTALLER_SECTION = "2. Morrow app setup window";

/** The course name and assistant title the inventory writes as placeholders. */
const placeheld = (value) => value.replaceAll("BIOL 101", "<course>").replaceAll("ChatGPT", "<assistant>");

test("the inventory carries what every Morrow app setup state renders", () => {
  const titles = new Set();
  for (const [name, current] of INSTALLER_STATES) {
    const view = actionView(current, { chosenAssistantId: null });
    titles.add(view.title);
    carries(view.title, `the setup window in ${name}`);
    carries(placeheld(view.copy), `the setup window in ${name}`);
  }
  assert.equal(titles.size, INSTALLER_STATES.size, "two setup states render the same title, so one of them covers no branch of its own");
  const unavailable = setupUnavailableView();
  carries(unavailable.title, "setupUnavailableView");
  carries(unavailable.copy, "setupUnavailableView");
  carries(progress(null).map((step) => step.label).join(", "), "the progress rail");
});

test("the inventory lists one Morrow app setup state per branch", () => {
  const source = read("installer/shared/setup-view.mjs");
  const start = source.indexOf("function actionPanel(");
  assert.notEqual(start, -1, "installer/shared/setup-view.mjs no longer declares actionPanel; the inventory names its branches");
  const branches = (source.slice(start, source.indexOf("const UNINSTALL_STEPS")).match(/return \{/g) || []).length;
  assert.equal(
    INSTALLER_STATES.size,
    branches,
    `the action panel has ${branches} branches and this test covers ${INSTALLER_STATES.size}; add the missing state here and in ${INVENTORY}`,
  );
  assert.deepEqual(
    [...rowsUnder(INSTALLER_SECTION).map((row) => row.state)].sort(),
    [...INSTALLER_STATES.keys(), ...RENDERER_STATES].sort(),
    `${INVENTORY} section ${INSTALLER_SECTION} must list exactly these states`,
  );
});

test("every Morrow app setup state cites the line its own title is written on", () => {
  const rows = new Map(rowsUnder(INSTALLER_SECTION).map((row) => [row.state, row]));
  const wrong = [];
  for (const [name, current] of INSTALLER_STATES) {
    wrong.push(citationProblem(rows.get(name), actionView(current, { chosenAssistantId: null }).title));
  }
  wrong.push(citationProblem(rows.get("setup-unavailable"), setupUnavailableView().title));
  wrong.push(citationProblem(rows.get("first-paint"), "Checking Morrow setup…"));
  assert.deepEqual(wrong.filter(Boolean), [], `${INVENTORY} section ${INSTALLER_SECTION} cites source that does not carry the state`);
});

// --- Morrow Bridge popup -----------------------------------------------------------------------

const anchor = (fields = {}) => ({ provider: "canvas", runtimeVerified: true, lastSeenAt: 1, siteAnchorId: "site-1", ...fields });
const binding = (fields = {}) => ({ courseName: "Biology 101", runtimeVerified: true, lastSeenAt: 1, ...fields });
const connection = { paired: false, pairing: false, connecting: false, connected: false, bindings: [], siteAnchors: [] };
const healthyPopup = { paired: true, connected: true, runtimeHealthy: true };

// One state per branch of the popup's detail text.
const POPUP_STATES = new Map([
  ["read-failed", null],
  ["not-paired", { ...connection }],
  ["pairing", { ...connection, pairing: true }],
  ["connecting", { ...connection, paired: true, connecting: true }],
  ["paired-not-connected", { ...connection, paired: true }],
  ["runtime-mismatch", { ...connection, paired: true, connected: true, runtimeHealthy: false }],
  ["connected-no-site", { ...connection, ...healthyPopup }],
  ["site-ready-no-course", { ...connection, ...healthyPopup, siteAnchors: [anchor()] }],
  ["site-stale", { ...connection, ...healthyPopup, siteAnchors: [anchor({ runtimeVerified: false })] }],
  ["course-ready", { ...connection, ...healthyPopup, siteAnchors: [anchor()], bindings: [binding()], bindingCount: 1 }],
  ["course-tab-closed", { ...connection, ...healthyPopup, siteAnchors: [anchor()], bindings: [binding({ runtimeVerified: false })], bindingCount: 1 }],
]);
const POPUP_SECTION = "4. Morrow Bridge popup";

test("the inventory carries what every popup state renders", () => {
  const details = new Set();
  for (const [name, status] of POPUP_STATES) {
    details.add(detailText(status));
    for (const value of [statusValue(status), courseValue(status), primaryLabel(status), detailText(status)]) {
      carries(value, `the popup in ${name}`);
    }
  }
  assert.equal(details.size, POPUP_STATES.size, "two popup states render the same detail, so one of them covers no branch of its own");
});

test("the inventory lists one popup state per branch", () => {
  const source = read("connector/extension/popup/popup-view.js");
  const body = source.slice(source.indexOf("export function detailText"), source.indexOf("export function controlState"));
  // Each guard clause, plus one arm per ternary and the last arm. `?.` is not a ternary.
  const branches = (body.match(/^\s*if\s*\(/gm) || []).length + (body.match(/\?(?!\.)/g) || []).length + 1;
  assert.equal(
    POPUP_STATES.size,
    branches,
    `detailText has ${branches} branches and this test covers ${POPUP_STATES.size}; add the missing state here and in ${INVENTORY}`,
  );
  assert.deepEqual(
    rowsUnder(POPUP_SECTION).map((row) => row.state).sort(),
    [...POPUP_STATES.keys()].sort(),
    `${INVENTORY} section ${POPUP_SECTION} must list exactly these states`,
  );
});

test("every popup state cites the line its own detail is written on", () => {
  const rows = new Map(rowsUnder(POPUP_SECTION).map((row) => [row.state, row]));
  const wrong = [...POPUP_STATES].map(([name, status]) => citationProblem(rows.get(name), detailText(status)));
  assert.deepEqual(wrong.filter(Boolean), [], `${INVENTORY} section ${POPUP_SECTION} cites source that does not carry the state`);
});

// --- Morrow Bridge setup guide -----------------------------------------------------------------

// The version answer and the recorded read the guide's five checks read, as
// connector/extension/src/service-worker.js answers them.
const healthy = { paired: true, connected: true, runtimeHealthy: true };
const firstCourseRead = { provider: "canvas", origin: "https://canvas.example", courseId: "42", courseName: "Biology 101", at: 1 };

const GUIDE_STATES = new Map([
  ["read-failed", null],
  ["not-paired", { ...connection }],
  ["pairing", { ...connection, pairing: true }],
  ["connecting", { ...connection, paired: true, connecting: true }],
  ["paired-not-connected", { ...connection, paired: true }],
  ["runtime-mismatch", { ...connection, paired: true, connected: true }],
  ["connected-no-site", { ...connection, ...healthy }],
  ["site-saved-not-verified", { ...connection, ...healthy, siteAnchors: [anchor({ runtimeVerified: false })] }],
  ["site-ready-no-course", { ...connection, ...healthy, siteAnchors: [anchor()] }],
  ["course-ready", { ...connection, ...healthy, siteAnchors: [anchor()], bindings: [binding()] }],
  ["ready", { ...connection, ...healthy, siteAnchors: [anchor()], bindings: [binding()], firstCourseRead }],
]);
const GUIDE_SECTION = "5. Morrow Bridge setup guide";

test("the inventory carries what every setup guide state renders", () => {
  const titles = new Set();
  for (const [name, status] of GUIDE_STATES) {
    const state = setupGuideState(status);
    titles.add(state.title);
    for (const value of [state.heading, state.summary, state.title, state.detail, ...state.checks.map((check) => check.text)]) {
      carries(value, `the setup guide in ${name}`);
    }
  }
  assert.equal(titles.size, GUIDE_STATES.size, "two setup guide states render the same next step, so one of them covers no branch of its own");
});

test("the inventory lists one setup guide state per branch", () => {
  const source = read("connector/extension/onboarding/onboarding-state.js");
  const readState = source.slice(source.indexOf("function readState("));
  // readState returns one shape per branch, and its course-site branch names two next steps.
  const branches = (readState.match(/return \{/g) || []).length + 1 + 1;
  assert.equal(
    GUIDE_STATES.size,
    branches,
    `the setup guide has ${branches} branches and this test covers ${GUIDE_STATES.size}; add the missing state here and in ${INVENTORY}`,
  );
  assert.deepEqual(
    rowsUnder(GUIDE_SECTION).map((row) => row.state).sort(),
    [...GUIDE_STATES.keys()].sort(),
    `${INVENTORY} section ${GUIDE_SECTION} must list exactly these states`,
  );
});

test("every setup guide state cites the line its own next step is written on", () => {
  const rows = new Map(rowsUnder(GUIDE_SECTION).map((row) => [row.state, row]));
  const wrong = [...GUIDE_STATES].map(([name, status]) => citationProblem(rows.get(name), setupGuideState(status).detail));
  assert.deepEqual(wrong.filter(Boolean), [], `${INVENTORY} section ${GUIDE_SECTION} cites source that does not carry the state`);
});

// --- Every citation in the inventory -------------------------------------------------------------

test("every control name in the inventory is on the line cited beside it", () => {
  const rows = [...inventory.matchAll(/^\| `(.+?)` \| ([^|]+?) \| ((?:`[^`]+`(?:, )?)+) \|$/gm)];
  assert.ok(rows.length > 50, "the terminology tables are missing; the inventory must name every user-facing control");
  const wrong = [];
  for (const [, name, , sources] of rows) {
    for (const [, path, line] of sources.matchAll(CITATION)) {
      const text = lines(path);
      if (text[Number(line) - 1]?.includes(name)) continue;
      const found = text.findIndex((value) => value.includes(name)) + 1;
      wrong.push(found
        ? `"${name}" is at ${path}:${found}, not ${path}:${line}`
        : `"${name}" is not in ${path}; the control was renamed or removed`);
    }
  }
  assert.deepEqual(wrong, [], `${INVENTORY} names a control at a line that does not carry it`);
});

test("every file and line the inventory cites exists", () => {
  const broken = [];
  for (const [, path, from, to] of inventory.matchAll(CITATION)) {
    if (!existsSync(new URL(path, root))) {
      broken.push(`${path} does not exist`);
      continue;
    }
    const total = lines(path).length;
    const last = Number(to || from);
    if (last > total) broken.push(`${path}:${to ? `${from}-${to}` : from} is past the end of the file (${total} lines)`);
  }
  for (const [, path] of inventory.matchAll(/`([A-Za-z0-9_-]+(?:\/[A-Za-z0-9_.-]+)+\.(?:mjs|cjs|js|ts|html))`/g)) {
    if (!existsSync(new URL(path, root))) broken.push(`${path} does not exist`);
  }
  assert.deepEqual(broken, [], `${INVENTORY} cites source that is not there`);
});
