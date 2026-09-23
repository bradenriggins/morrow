/**
 * What a person sees and does on connector/extension/settings/settings.html.
 *
 * Every check here drives the shipped page through scripts/test/lib/extension-dom.mjs: the page's
 * own markup, its own module, and the words it writes. Renaming a constant inside settings.js
 * breaks nothing here; changing a rendered state, a message payload or a sentence does. The last
 * check also loads connector/extension/src/service-worker.js, because what a person reads after
 * Disconnect Morrow is the state that worker leaves behind.
 *
 * A DOM harness is not Chrome. Real rendering, focus order and real permission prompts stay with
 * scripts/test/canvas-connector-browser.mjs and scripts/test/canvas-file-optional-permission-proof.mjs.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after } from "node:test";
import { clearExtensionGlobals, loadExtensionPage } from "./lib/extension-dom.mjs";
import { problemText } from "../../connector/extension/src/bridge-problem-copy.js";
import { CURATED_CATEGORY_SPECS } from "../../connector/extension/src/edit-policy.js";

const root = new URL("../../", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("connector/extension/manifest.json", root), "utf8"));

const ONE_HOUR_MS = 60 * 60 * 1_000;
const CATALOG_DIGEST = "c".repeat(64);
const SCOPE_DIGEST = "d".repeat(64);
const COURSE_FILE_ACCESS_KEY = "courseFileStorageAccessEnabled";

// WI-5.3: the D7 row state text distinguishes "Routine edits" from "Custom" by comparing a
// binding's enabledCategories against the full routine set for its provider. Read from the same
// source settings.js does, so this pin cannot drift from it by hand.
const CANVAS_ROUTINE_IDS = CURATED_CATEGORY_SPECS.filter((spec) => spec.provider === "canvas" && spec.routine === true).map((spec) => spec.id);

/** WI-5.4: the real curated label for an id, so the detail's allowed-list pin cannot drift from
 * edit-policy.js by hand. */
const curatedLabel = (id) => CURATED_CATEGORY_SPECS.find((spec) => spec.id === id)?.label;

const CHECKED_ACTION = Object.freeze({ id: "canvas_page_content", group: "Focused Canvas repairs", label: "Page content", description: "Rewrite reviewed page content.", availability: "edit", destructive: false, verification: "checked", area: "pages" });
const UNCHECKED_ACTION = Object.freeze({ id: "action:canvas:canvas_add_course_to_favorites", group: "Canvas actions", label: "Add course to favorites", description: "Mark a course as a favorite.", availability: "edit", destructive: false, verification: "unchecked", verificationReason: "Morrow cannot check this change after it is saved: the route returns no saved record. Morrow reports the saved result as unconfirmed.", area: "pages" });
const DESTRUCTIVE_ACTION = Object.freeze({ id: "action:canvas:canvas_delete_page", group: "Canvas actions", label: "Delete page", description: "Remove one page from a course.", availability: "edit", destructive: true, verification: "checked", area: "pages" });
const REVIEW_ONLY_ACTION = Object.freeze({ id: "action:canvas:canvas_update_quiz_item", group: "Canvas actions", label: "Update New Quiz item", description: "Change one New Quiz question.", availability: "review", destructive: false, reviewReason: "New Quizzes matches the parts of a question by id, so this change needs the delete-then-add contract." });
// F10, WI-3.4: a generated option with more than 8 changeable fields is published with
// allowedChangedFields: [], so a checkbox on it alone grants nothing. `canvas_edit_assignment` is a
// real key of settings.js's FIELD_SELECTION_BUNDLES table; `canvas_update_wide_thing` is not, so it
// proves the other branch of the message. Both fixture bundles carry the real `area` WI-3.1 gives
// their real-world counterpart, so WI-5.5's area grouping places them the way production data would.
const FIELD_SELECTION_BUNDLE = Object.freeze({ id: "canvas_assignment_text", group: "Canvas task bundles", label: "Edit assignment titles and instructions", description: "Change an assignment's title or instructions.", availability: "edit", destructive: false, verification: "checked", routine: true, rememberable: true, area: "assignments" });
// WI-4.5 (D2a): a second routine bundle, same group as FIELD_SELECTION_BUNDLE, alphabetically after
// it, so the switch's sorted "Morrow can make" list and save request have one fixed, checkable order.
const ROUTINE_BUNDLE_B = Object.freeze({ id: "canvas_pages_text", group: "Canvas task bundles", label: "Edit page text and titles", description: "Change the title or body text of an existing Canvas Page.", availability: "edit", destructive: false, verification: "checked", routine: true, rememberable: true, area: "pages" });
const FIELD_SELECTION_WITH_BUNDLE = Object.freeze({ id: "action:canvas:canvas_edit_assignment", group: "Canvas actions", label: "Edit an assignment", description: "Change an existing Canvas Assignment.", availability: "edit", destructive: false, verification: "checked", requiresFieldSelection: true, area: "assignments" });
const FIELD_SELECTION_NO_BUNDLE = Object.freeze({ id: "action:canvas:canvas_update_wide_thing", group: "Canvas actions", label: "Update a wide thing", description: "Change many settings at once.", availability: "edit", destructive: false, verification: "checked", requiresFieldSelection: true, area: "assignments" });

function canvasCourse(id, courseName, fields = {}) {
  return {
    sourceBindingId: `canvas:course-${id}`, siteAnchorId: "canvas:site-1", provider: "canvas", origin: "https://canvas.example.edu",
    siteUrl: "https://canvas.example.edu", principalId: "teacher@example.edu", courseId: String(id),
    courseName, runtimeVerified: true, editPolicyRevision: 0, ...fields,
  };
}

// WI-5.6: a Moodle course, the other half of a mixed Canvas and Moodle selection.
function moodleCourse(id, courseName, fields = {}) {
  return {
    sourceBindingId: `moodle:course-${id}`, siteAnchorId: "moodle:site-1", provider: "moodle", origin: "https://moodle.example.edu",
    siteUrl: "https://moodle.example.edu", principalId: "teacher@example.edu", courseId: String(id),
    courseName, runtimeVerified: true, editPolicyRevision: 0, ...fields,
  };
}

const ANATOMY = canvasCourse(1, "Anatomy");
const PHYSIOLOGY = canvasCourse(2, "Physiology");
// WI-5.6: the real curated routine bundle ids for each provider (read from edit-policy.js, so this
// cannot drift from it by hand), the shape a mixed selection's own options carry.
const CANVAS_ROUTINE_OPTIONS = CURATED_CATEGORY_SPECS.filter((spec) => spec.provider === "canvas" && spec.routine === true && spec.hiddenFromUi !== true)
  .map((spec) => ({ id: spec.id, group: spec.group, label: spec.label, description: spec.description, availability: "edit", destructive: false, verification: "checked", routine: true, rememberable: true, area: spec.area }));
const MOODLE_ROUTINE_OPTIONS = CURATED_CATEGORY_SPECS.filter((spec) => spec.provider === "moodle" && spec.routine === true)
  .map((spec) => ({ id: spec.id, group: spec.group, label: spec.label, description: spec.description, availability: "edit", destructive: false, verification: "checked", routine: true, rememberable: true }));

function statusFixture(bindings, fields = {}) {
  return { bindings, catalogDigest: CATALOG_DIGEST, siteAnchors: [], bindingLimit: 500, ...fields };
}

function optionsFixture(sourceBindingId, options, fields = {}) {
  return { schema: "morrow.bridge.edit-options.v1", sourceBindingId, provider: "canvas", catalogDigest: CATALOG_DIGEST, policyRevision: 0, runtimeVerified: true, options, ...fields };
}

/** A saved Edit grant's summary. Edit is not timed, so only a grant saved while it was carries `expiresAt`. */
function editPermissionSummary(sourceBindingId, fields = {}) {
  return { schema: "morrow.bridge.edit-permission.v1", sourceBindingId, revision: 1, scopeDigest: SCOPE_DIGEST, catalogDigest: CATALOG_DIGEST, ...fields };
}


/** Loads Plan and Edit settings with the answers the service worker would give. */
async function openSettings({ status, options = () => null, handlers = {}, ...rest } = {}) {
  return await loadExtensionPage("settings/settings.html", {
    handlers: {
      morrow_edit_policy_status: () => status(),
      morrow_edit_policy_options: ({ sourceBindingId }) => options(sourceBindingId),
      morrow_edit_policy_save: ({ sourceBindingId, enabledCategories }) => ({
        editPermission: { ...editPermissionSummary(sourceBindingId), enabledCategories },
      }),
      morrow_edit_policy_revoke: () => ({ revoked: true }),
      ...handlers,
    },
    ...rest,
  });
}

const listedCourses = (page) => page.queryAll(".course-row .course-select").map((input) => input.getAttribute("aria-label"));
const listedActions = (page) => page.queryAll("#category-list .category-option").map((option) => option.querySelector("strong").textContent);
const actionInput = (page, id) => page.query(`#category-list input[value="${id}"]`);

/** WI-5.3: "Select" shows the checkbox on each connected course. Idempotent: a second call while
 * already in select mode does nothing. */
async function ensureSelectMode(page) {
  if (page.query("#course-select-mode").getAttribute("aria-pressed") !== "true") await page.click("#course-select-mode");
}

/** Selects one connected course (turning on "Select" first) and waits for the actions the page then reads. */
async function selectCourse(page, sourceBindingId) {
  await ensureSelectMode(page);
  await page.click(`[data-binding-id="${sourceBindingId}"] .course-select`);
  await page.waitFor(() => page.messages("morrow_edit_policy_options").some((message) => message.sourceBindingId === sourceBindingId)
    && !page.text("#category-list").includes("Reading the current individual actions"),
    `the page never finished reading the actions for ${sourceBindingId}`);
}

/** One connected course selected, its actions read, and Edit chosen. */
async function openEditStage(actions, bindings = [ANATOMY, PHYSIOLOGY]) {
  const page = await openSettings({
    status: () => statusFixture(bindings),
    options: (sourceBindingId) => optionsFixture(sourceBindingId, actions),
  });
  await selectCourse(page, bindings[0].sourceBindingId);
  await page.click("#mode-edit");
  return page;
}

/** WI-5.5: every area and every kind in the Customize view starts closed. A test that needs to see
 * or click a leaf action opens its area, then its kind, first (idempotent: already-open is a no-op). */
async function openCustomizeGroup(page, areaId, kind) {
  const areaToggle = page.query(`[data-area-toggle="${areaId}"]`);
  if (areaToggle.getAttribute("aria-expanded") !== "true") await page.click(`[data-area-toggle="${areaId}"]`);
  const kindToggle = page.query(`[data-kind-toggle="${areaId}/${kind}"]`);
  if (kindToggle.getAttribute("aria-expanded") !== "true") await page.click(`[data-kind-toggle="${areaId}/${kind}"]`);
}

after(clearExtensionGlobals);

test("with no connected course the page states that, and offers no course to act on", async () => {
  const page = await openSettings({ status: () => statusFixture([]) });
  assert.equal(page.text("#connection-status"), "No course is connected yet.");
  // WI-F.10: pin changed from "No connected courses are available. Choose a signed-in site above to
  // find courses you can connect." to the composed empty message. No site is saved here, so it
  // carries no action.
  assert.equal(page.text("#course-list"), "Open a course in Canvas or Moodle. Morrow Bridge finds it.");
  assert.equal(page.queryAll("#course-list button").length, 0);
  assert.equal(page.query("#course-list").getAttribute("aria-busy"), "false");
  assert.equal(page.text("#selection-summary"), "No course selected. Select a course above, then choose Plan or Edit.");
  assert.equal(page.query("#course-select-mode").disabled, true);
  assert.equal(page.hidden("#permission-actions"), true);
  assert.equal(page.hidden("#course-show-more-row"), true);
  assert.equal(page.hidden("#course-bulk-bar"), true);
  assert.equal(page.hidden("#error"), true);
  assert.equal(page.text("#announcement"), "No course is connected yet.");
});

test("the course list shows three skeleton rows while the first read is outstanding, not a sentence", async () => {
  let resolveStatus;
  const pending = new Promise((resolve) => { resolveStatus = resolve; });
  const loading = loadExtensionPage("settings/settings.html", {
    handlers: {
      morrow_edit_policy_status: () => pending,
      morrow_edit_policy_save: () => ({}),
      morrow_edit_policy_revoke: () => ({}),
    },
  });
  // The status read stays outstanding, so the module's own top-level `await refresh()` cannot
  // finish. Its synchronous work, including the skeleton render, still runs: wait for it the same
  // way loadExtensionPage's own waitFor does, rather than assuming one tick is enough.
  for (let attempt = 0; attempt < 2_000 && globalThis.document?.querySelectorAll("#course-list .course-card-skeleton").length !== 3; attempt += 1) {
    await new Promise((resolve) => { setTimeout(resolve, 1); });
  }
  assert.equal(globalThis.document.querySelectorAll("#course-list .course-card-skeleton").length, 3);
  assert.equal(globalThis.document.querySelector("#course-list").getAttribute("aria-busy"), "true");
  assert.equal(globalThis.document.querySelector("#course-list").querySelectorAll("p").length, 0);

  resolveStatus(statusFixture([]));
  const page = await loading;
  assert.equal(page.queryAll("#course-list .course-card-skeleton").length, 0);
});

test("the empty course list offers one composed message, and the WI-1.1 open action once a site is saved", async () => {
  const opened = [];
  const closedSite = { siteAnchorId: "canvas-site-1", provider: "canvas", origin: "https://canvas.example.edu", principalId: "teacher@example.edu", runtimeVerified: false };
  const page = await openSettings({
    status: () => statusFixture([], { siteAnchors: [closedSite] }),
    handlers: {
      morrow_open_platform: ({ siteAnchorId }) => { opened.push(siteAnchorId); return { opened: true, verified: true }; },
    },
  });
  assert.equal(page.query("#course-list p").textContent, "Open a course in Canvas or Moodle. Morrow Bridge finds it.");
  assert.equal(page.text("#open-platform-empty"), "Open Canvas");

  await page.click("#open-platform-empty");
  assert.deepEqual(opened, ["canvas-site-1"]);
  assert.equal(page.hidden("#error"), true);
  // A fast open never shows progress text: the 400 ms reveal timer is cleared before it can fire.
  assert.notEqual(page.text("#open-platform-empty"), "Opening Canvas");
});

test("opening a saved but closed site shows progress only once the wait runs long enough to need it", async () => {
  let resolveOpen;
  const opening = new Promise((resolve) => { resolveOpen = resolve; });
  const closedSite = { siteAnchorId: "moodle-site-1", provider: "moodle", origin: "https://moodle.example.edu", principalId: "teacher@example.edu", runtimeVerified: false };
  const page = await openSettings({
    status: () => statusFixture([], { siteAnchors: [closedSite] }),
    handlers: { morrow_open_platform: () => opening },
  });
  assert.equal(page.text("#open-platform-empty"), "Open Moodle");

  await page.click("#open-platform-empty");
  assert.equal(page.query("#open-platform-empty").disabled, true, "a second click must not start a second tab");
  assert.equal(page.text("#open-platform-empty"), "Open Moodle", "no progress yet: the wait has not run long enough to need it");

  await page.waitFor(() => page.text("#open-platform-empty") === "Opening Moodle", "no progress appeared once the wait ran long enough to need it");

  resolveOpen({ opened: true, verified: true });
  await page.waitFor(() => page.query("#open-platform-empty").disabled === false, "opening the site never finished");
  assert.equal(page.text("#open-platform-empty"), "Open Moodle");
});

test("the connected-course summary counts only runtime-verified eligible courses as ready", async () => {
  const unverified = { ...PHYSIOLOGY, runtimeVerified: false };
  // A course Morrow can no longer identify: it holds no course id, name, site, or origin.
  const unidentified = { sourceBindingId: "canvas:course-3", provider: "canvas", runtimeVerified: true, editPolicyRevision: 0 };
  let bindings = [ANATOMY];
  const page = await openSettings({ status: () => statusFixture(bindings) });
  assert.equal(page.text("#connection-status"), "1 connected course is ready to use.");

  const reread = async (next, expected) => {
    bindings = next;
    await page.click("#refresh");
    await page.waitFor(() => page.text("#connection-status") === expected, `the page never read the courses again: ${page.text("#connection-status")}`);
  };
  await reread([ANATOMY, unverified],
    "1 connected course is ready to use. 1 saved course needs an open course tab or a reconnected site.");
  await reread([unidentified],
    "0 connected courses are ready to use. 1 saved course needs an open course tab or a reconnected site.");
  await reread([], "No course is connected yet.");
  // WI-F.10 pin: see "with no connected course the page states that, and offers no course to act on".
  assert.equal(page.text("#course-list"), "Open a course in Canvas or Moodle. Morrow Bridge finds it.");
});

// WI-5.3: a course loses its checkbox and moves to "Needs attention" the moment its site closes; a
// live status event carries that through without a manual refresh.
test("a Bridge course-tab status event refreshes the rendered course state", async () => {
  let bindings = [ANATOMY];
  const page = await openSettings({ status: () => statusFixture(bindings) });
  assert.equal(page.text("#connection-status"), "1 connected course is ready to use.");
  bindings = [{ ...ANATOMY, runtimeVerified: false }];

  page.listeners.message[0]({ type: "morrow_bridge_status_changed" });
  await page.waitFor(
    () => page.text("#connection-status") === "0 connected courses are ready to use. 1 saved course needs an open course tab or a reconnected site.",
    "settings did not refresh after the Bridge invalidated the course tab",
  );
  assert.equal(page.text(`[data-open-platform="${ANATOMY.sourceBindingId}"]`), "Open Canvas");
  assert.equal(page.queryAll(".course-select").length, 0);
});

test("an older settings response cannot replace a newer connected-course state", async () => {
  let call = 0;
  let resolveOlder;
  const older = new Promise((resolve) => { resolveOlder = resolve; });
  const page = await openSettings({ status: () => {
    call += 1;
    if (call === 1) return statusFixture([ANATOMY]);
    if (call === 2) return older;
    return statusFixture([]);
  } });
  page.listeners.storage[0]({}, "local");
  page.listeners.storage[0]({}, "local");
  await page.waitFor(() => page.messages("morrow_edit_policy_status").length === 3 && page.text("#connection-status") === "No course is connected yet.",
    "the newer settings response did not render");
  resolveOlder(statusFixture([PHYSIOLOGY]));
  await page.flush();
  assert.equal(page.text("#connection-status"), "No course is connected yet.");
  assert.deepEqual(listedCourses(page), []);
});

// WI-5.3: no pagination. A search narrows the one merged list; clearing it restores every row.
test("a course search narrows the list, with no pagination", async () => {
  const courses = ["Anatomy", "Physiology", "Pharmacology", "Microbiology", "Nutrition", "Pathology", "Genetics", "Immunology"]
    .map((name, index) => canvasCourse(index + 1, name));
  const page = await openSettings({ status: () => statusFixture(courses) });
  // "8 courses or fewer" (WI-5.3): the scope tabs and the platform and term menus stay hidden.
  assert.equal(page.queryAll(".course-row").length, 8);
  assert.equal(page.hidden("#course-scope"), true);
  assert.equal(page.hidden(".platform-field"), true);
  assert.equal(page.hidden(".term-field"), true);
  assert.equal(page.hidden("#course-show-more-row"), true);
  assert.equal(page.text("#announcement"), "8 courses.");

  await page.type("#course-filter", "phys");
  assert.deepEqual(page.queryAll(".course-row-name").map((el) => el.textContent), ["Physiology"]);
  assert.equal(page.text("#announcement"), "Search matches 1 course.");

  await page.type("#course-filter", "astronomy");
  assert.equal(page.queryAll(".course-row").length, 0);
  assert.equal(page.text("#course-list"), "No course matches this search or filter. Clear it to view every course in this list.");

  await page.type("#course-filter", "");
  assert.equal(page.queryAll(".course-row").length, 8);
});

// WI-5.3: past the "8 courses or fewer" threshold, the scope tabs show, each with its own count,
// and choosing one narrows the list without touching the other filters.
test("past 8 courses the scope tabs appear, each with a count, and narrow the list", async () => {
  const courses = Array.from({ length: 9 }, (unused, index) => canvasCourse(index + 1, `Course ${index + 1}`));
  const attention = { ...canvasCourse(10, "Closed Course"), runtimeVerified: false };
  const page = await openSettings({ status: () => statusFixture([...courses, attention]) });
  assert.equal(page.hidden("#course-scope"), false);
  const tabText = (id) => page.query(`#course-scope-${id}`).textContent;
  assert.equal(tabText("all"), "All10");
  assert.equal(tabText("connected"), "Connected9");
  assert.equal(tabText("attention"), "Needs attention1");
  assert.equal(tabText("available"), "Not connected0");
  assert.equal(page.query("#course-scope-all").getAttribute("aria-pressed"), "true");

  await page.click("#course-scope-connected");
  assert.equal(page.query("#course-scope-connected").getAttribute("aria-pressed"), "true");
  assert.equal(page.queryAll(".course-row").length, 9);
  assert.equal(page.queryAll('.course-row[data-row-kind="attention"]').length, 0);
});

// WI-5.3: "Select" shows a checkbox on each connected course (never on an attention or an
// available row) and the bulk bar, with its two shortcut actions.
test("Select shows a checkbox on each connected course and the bulk bar", async () => {
  const attention = { ...canvasCourse(3, "Closed Course"), runtimeVerified: false };
  const page = await openSettings({
    status: () => statusFixture([ANATOMY, PHYSIOLOGY, attention]),
    options: (sourceBindingId) => optionsFixture(sourceBindingId, [CHECKED_ACTION]),
  });
  assert.equal(page.hidden("#course-bulk-bar"), true);
  assert.equal(page.queryAll(".course-select").length, 0);

  await page.click("#course-select-mode");
  assert.equal(page.query("#course-select-mode").textContent, "Done");
  assert.equal(page.queryAll(".course-select").length, 2);
  assert.deepEqual(listedCourses(page), [
    "Select Canvas course Anatomy (course ID 1)",
    "Select Canvas course Physiology (course ID 2)",
  ]);
  assert.equal(page.hidden("#course-bulk-bar"), true);

  await page.click(`[data-binding-id="${ANATOMY.sourceBindingId}"] .course-select`);
  await page.click(`[data-binding-id="${PHYSIOLOGY.sourceBindingId}"] .course-select`);
  assert.equal(page.hidden("#course-bulk-bar"), false);
  assert.equal(page.text("#course-bulk-count"), "2 courses selected. Canvas and Moodle courses can be selected together.");
  assert.equal(page.text("#course-bulk-plan"), "Plan. Ask first.");
  assert.equal(page.text("#course-bulk-routine"), "Edit. Routine edits.");

  await page.click("#course-select-mode");
  assert.equal(page.query("#course-select-mode").textContent, "Select");
  assert.equal(page.queryAll(".course-select").length, 0);
});

// WI-5.3, D2a: the bulk bar's Edit shortcut always grants the full routine set. Edit is not timed.
test("the bulk bar's Edit shortcut saves the routine set for every selected course, with no end time", async () => {
  const page = await openSettings({
    status: () => statusFixture([ANATOMY, PHYSIOLOGY]),
    options: (sourceBindingId) => optionsFixture(sourceBindingId, [FIELD_SELECTION_BUNDLE, ROUTINE_BUNDLE_B]),
  });
  await page.click("#course-select-mode");
  await page.click(`[data-binding-id="${ANATOMY.sourceBindingId}"] .course-select`);
  await page.click(`[data-binding-id="${PHYSIOLOGY.sourceBindingId}"] .course-select`);
  await page.waitFor(() => page.query("#course-bulk-routine").disabled === false, "the routine shortcut never became available");

  await page.click("#course-bulk-routine");
  await page.waitFor(() => page.messages("morrow_edit_policy_save").length === 2, "the page never saved Edit access for both courses");
  assert.deepEqual(page.messages("morrow_edit_policy_save"), [
    { type: "morrow_edit_policy_save", sourceBindingId: ANATOMY.sourceBindingId, enabledCategories: [FIELD_SELECTION_BUNDLE.id, ROUTINE_BUNDLE_B.id] },
    { type: "morrow_edit_policy_save", sourceBindingId: PHYSIOLOGY.sourceBindingId, enabledCategories: [FIELD_SELECTION_BUNDLE.id, ROUTINE_BUNDLE_B.id] },
  ]);
  assert.equal(page.text("#course-bulk-routine"), "Edit. Routine edits.");
  assert.equal(page.query("#mode-edit").checked, true);
});

// WI-5.6: Canvas ids and Moodle ids never match, so the bulk bar's Edit shortcut resolves the
// platform-neutral "Routine edits" level to each connection's own ids, not one shared literal list.
test("the bulk bar's Edit shortcut grants each connection its own routine actions for a mixed Canvas and Moodle selection", async () => {
  const chemistry = moodleCourse(1, "Chemistry");
  const page = await openSettings({
    status: () => statusFixture([ANATOMY, chemistry]),
    options: (sourceBindingId) => optionsFixture(
      sourceBindingId,
      sourceBindingId.startsWith("moodle:") ? MOODLE_ROUTINE_OPTIONS : CANVAS_ROUTINE_OPTIONS,
      { provider: sourceBindingId.startsWith("moodle:") ? "moodle" : "canvas" },
    ),
  });
  await page.click("#course-select-mode");
  await page.click(`[data-binding-id="${ANATOMY.sourceBindingId}"] .course-select`);
  await page.click(`[data-binding-id="${chemistry.sourceBindingId}"] .course-select`);
  assert.equal(page.text("#course-bulk-count"), "2 courses selected. Canvas and Moodle courses can be selected together.");
  await page.waitFor(() => page.query("#course-bulk-routine").disabled === false, "the routine shortcut never became available for the mixed selection");

  await page.click("#course-bulk-routine");
  await page.waitFor(() => page.messages("morrow_edit_policy_save").length === 2, "the page never saved Edit access for both courses");
  const saved = page.messages("morrow_edit_policy_save");
  const forCanvas = saved.find((message) => message.sourceBindingId === ANATOMY.sourceBindingId);
  const forMoodle = saved.find((message) => message.sourceBindingId === chemistry.sourceBindingId);
  assert.deepEqual([...forCanvas.enabledCategories].sort(), CANVAS_ROUTINE_OPTIONS.map((option) => option.id).sort());
  assert.deepEqual([...forMoodle.enabledCategories].sort(), MOODLE_ROUTINE_OPTIONS.map((option) => option.id).sort());
  assert.equal(Object.hasOwn(forCanvas, "expiresInMs"), false);
  assert.equal(Object.hasOwn(forMoodle, "expiresInMs"), false);
  assert.equal(page.hidden("#error"), true);
  assert.equal(page.query("#mode-edit").checked, true);
});

// WI-5.6: in the Customize view, a mixed selection shows the platform-neutral bundle only, not a
// single action (a single action needs one platform).
test("Customize shows a platform-neutral bundle for a mixed Canvas and Moodle selection, not single actions", async () => {
  const chemistry = moodleCourse(2, "Chemistry");
  const page = await openSettings({
    status: () => statusFixture([ANATOMY, chemistry]),
    options: (sourceBindingId) => optionsFixture(
      sourceBindingId,
      sourceBindingId.startsWith("moodle:") ? MOODLE_ROUTINE_OPTIONS : CANVAS_ROUTINE_OPTIONS,
      { provider: sourceBindingId.startsWith("moodle:") ? "moodle" : "canvas" },
    ),
  });
  await page.click("#course-select-mode");
  await page.click(`[data-binding-id="${ANATOMY.sourceBindingId}"] .course-select`);
  await page.click(`[data-binding-id="${chemistry.sourceBindingId}"] .course-select`);
  await page.waitFor(() => page.query("#course-bulk-routine").disabled === false, "the mixed selection's options never finished loading");

  await page.click("#mode-edit");
  await openCustomizeGroup(page, "other", "edit");
  assert.deepEqual(listedActions(page), ["Routine edits"]);
});

// The Routine edits promise is the list of changes Morrow makes with no review. Each field a
// routine rule may change maps to the words that name it, and the one thing the routine set
// creates is named as the only exception to "always asks before it creates".
const ROUTINE_FIELD_WORDS = new Map([
  ...["content", "name", "instructions", "wiki_page_body", "wiki_page_title", "module_name", "module_item_title",
    "assignment_description", "assignment_name", "message", "title", "quiz_description", "quiz_title"].map((field) => [field, "text and titles"]),
  ["module_position", "reorder"],
  ["module_item_position", "reorder"],
  ["module_item_indent", "indent"],
  ["module_item_external_url", "module item links"],
  ["module_item_new_tab", "how they open"],
  ["module_item_module_id", "move"],
  ["parent_folder_id", "move"],
  ["parent_folder_path", "move"],
]);

test("the Routine edits promise names every change the routine set makes with no review", async () => {
  const rules = CURATED_CATEGORY_SPECS.filter((spec) => spec.routine === true).flatMap((spec) => spec.rules || []);
  const unnamed = [...new Set(rules.flatMap((rule) => rule.allowedChangedFields || []))].filter((field) => !ROUTINE_FIELD_WORDS.has(field));
  assert.deepEqual(unnamed, [], "a routine field the Routine edits promise does not name");
  const created = [...new Set(rules.map((rule) => /^(?:canvas|moodle)_create_([a-z]+)/u.exec(rule.toolName)?.[1]).filter(Boolean))];
  assert.deepEqual(created, ["folder"], "the routine set creates something new; name it in the Routine edits promise");
  assert.equal(CURATED_CATEGORY_SPECS.some((spec) => spec.routine === true && spec.id === "canvas_alt_text"), true);

  const routine = canvasCourse(1, "Anatomy", { editPermission: { ...editPermissionSummary("canvas:course-1"), enabledCategories: CANVAS_ROUTINE_IDS } });
  const routinePage = await openSettings({ status: () => statusFixture([routine]) });
  const lead = (await openCourseDetail(routinePage, routine.sourceBindingId)).querySelector(".field-help").textContent;

  const chemistry = moodleCourse(2, "Chemistry");
  const page = await openSettings({
    status: () => statusFixture([ANATOMY, chemistry]),
    options: (sourceBindingId) => optionsFixture(
      sourceBindingId,
      sourceBindingId.startsWith("moodle:") ? MOODLE_ROUTINE_OPTIONS : CANVAS_ROUTINE_OPTIONS,
      { provider: sourceBindingId.startsWith("moodle:") ? "moodle" : "canvas" },
    ),
  });
  await page.click("#course-select-mode");
  await page.click(`[data-binding-id="${ANATOMY.sourceBindingId}"] .course-select`);
  await page.click(`[data-binding-id="${chemistry.sourceBindingId}"] .course-select`);
  await page.waitFor(() => page.query("#course-bulk-routine").disabled === false, "the mixed selection's options never finished loading");
  await page.click("#mode-edit");
  await openCustomizeGroup(page, "other", "edit");
  const family = page.query("#category-list .category-option small").textContent;
  const summaries = [page.text("#routine-switch .routine-toggle small"), family];
  for (const summary of summaries) {
    for (const words of new Set(ROUTINE_FIELD_WORDS.values())) assert.match(summary, new RegExp(words, "iu"), summary);
    assert.match(summary, /\bcreates? folders\b/u, summary);
    assert.match(summary, /alternative text/u, summary);
  }
  for (const promise of [...summaries, lead]) {
    assert.match(promise, /creates anything other than a folder/u, promise);
    assert.doesNotMatch(promise, /(?:before it|never) creates,/u, promise);
  }
});

// WI-5.3: the bulk bar's Plan shortcut reuses returnToPlan, the same handler "Return selected
// courses to Plan" uses.
test("the bulk bar's Plan shortcut returns every selected course to Plan", async () => {
  const revoked = [];
  const page = await openSettings({
    status: () => statusFixture([ANATOMY, PHYSIOLOGY]),
    options: (sourceBindingId) => optionsFixture(sourceBindingId, [CHECKED_ACTION]),
    handlers: { morrow_edit_policy_revoke: ({ sourceBindingId }) => { revoked.push(sourceBindingId); return { revoked: true }; } },
  });
  await page.click("#course-select-mode");
  await page.click(`[data-binding-id="${ANATOMY.sourceBindingId}"] .course-select`);
  await page.click(`[data-binding-id="${PHYSIOLOGY.sourceBindingId}"] .course-select`);
  await page.click("#course-bulk-plan");
  await page.waitFor(() => page.text("#notice") !== "", "the page never reported the returned courses");
  assert.deepEqual(revoked.sort(), [ANATOMY.sourceBindingId, PHYSIOLOGY.sourceBindingId].sort());
});

// Canvas and Moodle courses can be selected together, so a selection with no Edit action in common
// is named for what it is, not blamed on the platforms.
test("courses that share no Edit action say so, and name the step that helps", async () => {
  const page = await openSettings({
    status: () => statusFixture([ANATOMY, PHYSIOLOGY]),
    options: (sourceBindingId) => optionsFixture(sourceBindingId, sourceBindingId === ANATOMY.sourceBindingId ? [CHECKED_ACTION] : [ROUTINE_BUNDLE_B]),
  });
  await selectCourse(page, ANATOMY.sourceBindingId);
  await selectCourse(page, PHYSIOLOGY.sourceBindingId);
  await page.click("#mode-edit");
  assert.equal(page.text("#selection-summary"), "2 courses selected. These courses share no Edit action.");
  assert.equal(page.text("#action-help"), "These courses share no Edit action. Select fewer courses, then choose Edit.");
  assert.doesNotMatch(page.text("#mode-panel"), /platform/i);
});

test("Edit actions stay closed until a course is selected and Edit is chosen", async () => {
  const page = await openSettings({
    status: () => statusFixture([ANATOMY]),
    options: (sourceBindingId) => optionsFixture(sourceBindingId, [CHECKED_ACTION]),
  });
  assert.equal(page.query("#mode-plan").disabled, true);
  assert.equal(page.query("#mode-edit").disabled, true);
  assert.equal(page.hidden("#category-fieldset"), true);
  assert.equal(page.text("#edit-stage-hint"), "Select courses, then choose Edit to review the available actions.");
  // A person can click Edit while it is off; Chrome answers nothing, and so does the page.
  await page.click("#mode-edit");
  assert.equal(page.query("#mode-edit").checked, false);
  assert.equal(page.hidden("#category-fieldset"), true);

  await selectCourse(page, ANATOMY.sourceBindingId);
  assert.equal(page.query("#mode-edit").disabled, false);
  assert.equal(page.hidden("#category-fieldset"), true);
  assert.equal(page.text("#edit-stage-hint"), "Choose Edit to review and select the actions Morrow may apply.");
  assert.equal(page.hidden("#permission-actions"), false);
  assert.equal(page.hidden("#save-edit"), true);

  await page.click("#mode-edit");
  assert.equal(page.query("#mode-plan").checked, false);
  assert.equal(page.hidden("#category-fieldset"), false);
  assert.equal(page.hidden("#edit-stage-hint"), true);
  assert.equal(page.hidden("#save-edit"), false);
  assert.equal(page.query("#save-edit").disabled, true);
  assert.equal(page.text("#action-help"), "Choose at least one action. Unchecked actions stay in Plan for your review.");

  await page.click("#mode-plan");
  assert.equal(page.hidden("#category-fieldset"), true);
  assert.equal(page.hidden("#save-edit"), true);
  assert.equal(page.text("#action-help"), "To remove any saved Edit access, return the selected courses to Plan.");
});

test("Plan and Edit reads the individual actions for a course only when that course is selected", async () => {
  const page = await openSettings({
    status: () => statusFixture([ANATOMY, PHYSIOLOGY]),
    options: (sourceBindingId) => optionsFixture(sourceBindingId, [CHECKED_ACTION]),
  });
  assert.deepEqual(page.messages("morrow_edit_policy_options"), []);
  assert.equal(page.text("#category-list"), "Select a course to read its available Edit and Review-only actions.");

  await selectCourse(page, ANATOMY.sourceBindingId);
  assert.deepEqual(page.messages("morrow_edit_policy_options"),
    [{ type: "morrow_edit_policy_options", sourceBindingId: ANATOMY.sourceBindingId }]);
  await page.click("#mode-edit");
  await openCustomizeGroup(page, "pages", "edit");
  assert.deepEqual(listedActions(page), [CHECKED_ACTION.label]);
});

// WI-5.3: an options response that comes back unverified moves the course out of the connected,
// selectable rows and into "Needs attention", where it shows the Open action, not a checkbox.
test("an options response that is not runtime verified moves the course to site recovery", async () => {
  const page = await openSettings({
    status: () => statusFixture([ANATOMY]),
    options: (sourceBindingId) => optionsFixture(sourceBindingId, [CHECKED_ACTION], { runtimeVerified: false }),
  });
  await page.click("#course-select-mode");
  await page.click(`[data-binding-id="${ANATOMY.sourceBindingId}"] .course-select`);
  await page.waitFor(() => page.messages("morrow_edit_policy_options").length === 1 && !page.text("#category-list").includes("Reading the current individual actions"),
    "the unverified options response did not settle");
  assert.equal(page.query("#mode-edit").disabled, true);
  assert.deepEqual(listedActions(page), []);
  assert.equal(page.hidden("#error"), true);
  assert.equal(page.text("#category-list"), "Open each selected course in Canvas or Moodle, then refresh this page before you choose Edit.");
  // WI-1.1 pin: "Course tab needed" became "Canvas is closed", now the row's own note.
  assert.equal(page.queryAll(`[data-binding-id="${ANATOMY.sourceBindingId}"]`).length, 0);
  assert.match(page.text(`[data-open-platform="${ANATOMY.sourceBindingId}"]`), /^Open Canvas$/);
});

test("a closed course row offers its own Open Canvas action, targeted at that exact course", async () => {
  const opened = [];
  const closed = { ...ANATOMY, runtimeVerified: false };
  const page = await openSettings({
    status: () => statusFixture([closed]),
    handlers: {
      morrow_open_platform: (fields) => { opened.push(fields); return { opened: true, verified: true }; },
    },
  });
  const row = page.query('[data-row-kind="attention"]');
  assert.match(row.querySelector(".course-row-note").textContent, /^Canvas is closed\. Morrow Bridge can open it for you\.$/);
  assert.equal(page.text(`[data-open-platform="${closed.sourceBindingId}"]`), "Open Canvas");

  await page.click(`[data-open-platform="${closed.sourceBindingId}"]`);
  assert.deepEqual(opened, [{ type: "morrow_open_platform", siteAnchorId: "canvas:site-1", sourceBindingId: closed.sourceBindingId }]);
  assert.equal(page.hidden("#error"), true);
});

test("a closed course row whose saved site is gone says so when Open Canvas is selected", async () => {
  const { siteAnchorId: _siteAnchorId, ...closed } = { ...ANATOMY, runtimeVerified: false };
  const page = await openSettings({ status: () => statusFixture([closed]) });
  await page.click(`[data-open-platform="${closed.sourceBindingId}"]`);
  assert.deepEqual(page.messages("morrow_open_platform"), []);
  assert.equal(page.hidden("#error"), false);
  assert.equal(page.text("#error"), problemText("platform_open_anchor_missing"));
});

// Every recovery step the page names is one the person can take from a control that exists.
test("recovery text names the Open and Connect controls that exist, not a reconnect step", async () => {
  const unnamed = { sourceBindingId: "canvas:unnamed", provider: "canvas", runtimeVerified: true, editPolicyRevision: 0 };
  const page = await openSettings({ status: () => statusFixture([unnamed]) });
  assert.equal(page.text('[data-row-kind="attention"] .course-row-note'), "Morrow cannot identify this course. Open it in Canvas or Moodle and select Connect this course in the Morrow Bridge popup.");
  assert.match(page.text(".access-rules-list"), /If a course needs sign-in again, select Open Canvas or Open Moodle on its row, and sign in if asked\./);
  assert.doesNotMatch(page.text("body"), /reconnect it from the Morrow popup|Open and reconnect/i);
});

test("a closed course's Open Canvas shows a sign-in notice when the reopened site is still unverified", async () => {
  const closed = { ...ANATOMY, runtimeVerified: false };
  const page = await openSettings({
    status: () => statusFixture([closed]),
    handlers: { morrow_open_platform: () => ({ opened: true, verified: false }) },
  });
  await page.click(`[data-open-platform="${closed.sourceBindingId}"]`);
  assert.equal(page.hidden("#notice"), false);
  assert.equal(page.text("#notice"), "Sign in to Canvas in the tab that opened. Morrow continues after that.");
});

// WI-5.5: "Review-only options. Not in the picker." One line names the count and lists them in a
// read-only disclosure instead of the per-item Edit-style card the flat picker used to render.
test("an action published for review only is not in the picker, and is named on the review-only line", async () => {
  const page = await openEditStage([CHECKED_ACTION, REVIEW_ONLY_ACTION]);
  assert.equal(page.query(".review-only-line summary").textContent, "1 action always waits for your review");
  const item = page.query(".review-only-line li");
  assert.equal(item.querySelector("strong").textContent, REVIEW_ONLY_ACTION.label);
  assert.equal(item.querySelector("span").textContent, REVIEW_ONLY_ACTION.reviewReason);
  assert.equal(page.queryAll(`#category-list input[value="${REVIEW_ONLY_ACTION.id}"]`).length, 0);

  await openCustomizeGroup(page, "pages", "edit");
  assert.equal(actionInput(page, CHECKED_ACTION.id).disabled, false);
});

// F10, WI-3.4: an option that would grant nothing (allowedChangedFields: []) never gets an active
// checkbox. It names the bundle that covers its tool when one is offered, else it says Morrow
// always asks first.
test("an option that grants nothing alone gets no checkbox, and names the covering bundle, or says Morrow always asks first", async () => {
  const page = await openEditStage([CHECKED_ACTION, FIELD_SELECTION_BUNDLE, FIELD_SELECTION_WITH_BUNDLE, FIELD_SELECTION_NO_BUNDLE]);
  await openCustomizeGroup(page, "assignments", "edit");
  const options = page.queryAll("#category-list .category-option");
  const fieldSelectionOptions = options.filter((option) => option.classList.contains("field-selection"));
  assert.equal(fieldSelectionOptions.length, 2);

  const withBundle = fieldSelectionOptions.find((option) => option.querySelector("strong").textContent === FIELD_SELECTION_WITH_BUNDLE.label);
  assert.equal(withBundle.querySelector("input"), null);
  assert.equal(withBundle.querySelector("small").textContent,
    `${FIELD_SELECTION_WITH_BUNDLE.description} Morrow can change this only through a bundle: ${FIELD_SELECTION_BUNDLE.label}.`);

  const noBundle = fieldSelectionOptions.find((option) => option.querySelector("strong").textContent === FIELD_SELECTION_NO_BUNDLE.label);
  assert.equal(noBundle.querySelector("input"), null);
  assert.equal(noBundle.querySelector("small").textContent, `${FIELD_SELECTION_NO_BUNDLE.description} Morrow always asks before this change.`);

  assert.equal(page.queryAll(`#category-list input[value="${FIELD_SELECTION_WITH_BUNDLE.id}"]`).length, 0);
  assert.equal(page.queryAll(`#category-list input[value="${FIELD_SELECTION_NO_BUNDLE.id}"]`).length, 0);
  // The bundle itself keeps its ordinary, active checkbox: only the field-capped single action loses it.
  assert.equal(actionInput(page, FIELD_SELECTION_BUNDLE.id).disabled, false);
});

// WI-3.4, F10: settings.js keeps its own table naming, for each tool, the curated bundles that cover
// it (the public option carries no rule detail). This proves that table names exactly the bundles
// CURATED_CATEGORY_SPECS gives each tool, for every tool any visible bundle covers, so the two lists
// (the project keeps such lists in two places by hand, `src/edit-policy.js:15`) cannot silently drift.
test("the bundle names a field-selection option shows match src/edit-policy.js's curated bundle rules for every tool a visible bundle covers", async () => {
  const visible = CURATED_CATEGORY_SPECS.filter((spec) => spec.hiddenFromUi !== true && (spec.provider === "canvas" || spec.provider === "moodle"));
  const labelById = new Map(visible.map((spec) => [spec.id, spec.label]));
  const bundleIdsByTool = new Map();
  for (const spec of visible) {
    for (const rule of spec.rules) {
      if (!bundleIdsByTool.has(rule.toolName)) bundleIdsByTool.set(rule.toolName, new Set());
      bundleIdsByTool.get(rule.toolName).add(spec.id);
    }
  }
  // area: "other" for every fixture here: this test is about bundle-name matching, not area
  // grouping, so one shared area/kind group is enough to see everything with one openCustomizeGroup.
  const bundleCategories = visible.map((spec) => ({
    id: spec.id, group: spec.group, label: spec.label, description: spec.description,
    availability: "edit", destructive: false, verification: "checked", area: "other",
  }));
  const toolLabel = (toolName) => `Field-capped: ${toolName}`;
  const toolActions = [...bundleIdsByTool.keys()].map((toolName) => ({
    id: `action:${toolName.startsWith("moodle_") ? "moodle" : "canvas"}:${toolName}`,
    group: "Field-capped actions", label: toolLabel(toolName), description: `${toolName} description.`,
    availability: "edit", destructive: false, verification: "checked", requiresFieldSelection: true, area: "other",
  }));

  const page = await openEditStage([...bundleCategories, ...toolActions], [ANATOMY]);
  await openCustomizeGroup(page, "other", "edit");
  const rendered = page.queryAll("#category-list .category-option").filter((option) => option.classList.contains("field-selection"));
  assert.equal(rendered.length, toolActions.length);

  for (const [toolName, bundleIds] of bundleIdsByTool) {
    const option = rendered.find((entry) => entry.querySelector("strong").textContent === toolLabel(toolName));
    assert.ok(option, `no rendered field-selection option for ${toolName}`);
    // A bundle label can itself hold a comma ("Rename and move files, create folders"), so the
    // expected text is built in the same insertion order this tool's rules appear in
    // CURATED_CATEGORY_SPECS and compared whole, rather than split back apart from the rendering.
    const expectedText = `${toolName} description. Morrow can change this only through a bundle: ${[...bundleIds].map((id) => labelById.get(id)).join(", ")}.`;
    assert.equal(option.querySelector("small").textContent, expectedText, toolName);
  }
});

// WI-5.5: search matches labels, hides an area with no match, and opens an area (and its kind) with
// a match, so a matching action needs no manual disclosure click; a review-only action is never in
// the picker at all (it only ever appears on the review-only line, checked separately above).
test("the action search and the checked-only filter change which actions a person can choose", async () => {
  const page = await openEditStage([CHECKED_ACTION, UNCHECKED_ACTION, REVIEW_ONLY_ACTION]);
  assert.equal(page.query(".review-only-line summary").textContent, "1 action always waits for your review");
  await openCustomizeGroup(page, "pages", "edit");
  assert.deepEqual(listedActions(page).sort(), [UNCHECKED_ACTION.label, CHECKED_ACTION.label].sort());

  await page.type("#action-filter", "favorite");
  assert.deepEqual(listedActions(page), [UNCHECKED_ACTION.label]);

  await page.type("#action-filter", "shibboleth");
  assert.equal(page.text("#category-list"), "No individual action matches this search.");

  await page.type("#action-filter", "");
  await openCustomizeGroup(page, "pages", "edit");
  await page.click("#action-checked-only");
  assert.deepEqual(listedActions(page), [CHECKED_ACTION.label]);

  await page.click("#action-checked-only");
  assert.equal(listedActions(page).includes(UNCHECKED_ACTION.label), true);
});

// Edit is not timed: it stays on until the educator returns the course to Plan. The page offers no
// length, sends none, and promises no end time.
test("Edit access has no length to choose and saves one exact request for each selected course", async () => {
  const page = await openEditStage([CHECKED_ACTION]);
  assert.equal(page.queryAll("#edit-duration, select[data-end-duration]").length, 0);
  assert.doesNotMatch(page.text("main"), /ends after|hours|minutes/);

  await selectCourse(page, PHYSIOLOGY.sourceBindingId);
  await openCustomizeGroup(page, "pages", "edit");
  await page.click(`#category-list input[value="${CHECKED_ACTION.id}"]`);
  assert.equal(page.text("#selection-summary"), "1 action in 1 area, no removal, 2 courses");
  assert.equal(page.text("#action-help"), "Morrow can apply only the checked actions in these courses until you return them to Plan. Save again if available actions change.");

  await page.click("#save-edit");
  await page.waitFor(() => page.messages("morrow_edit_policy_save").length === 2, "the page never saved Edit access for both courses");
  assert.deepEqual(page.messages("morrow_edit_policy_save"), [
    { type: "morrow_edit_policy_save", sourceBindingId: ANATOMY.sourceBindingId, enabledCategories: [CHECKED_ACTION.id] },
    { type: "morrow_edit_policy_save", sourceBindingId: PHYSIOLOGY.sourceBindingId, enabledCategories: [CHECKED_ACTION.id] },
  ]);
  assert.equal(page.text("#notice"), "Edit access saved for 2 courses. Allowed actions: Page content. It stays on until you return these courses to Plan.");
});

// WI-4.5 (D2): the "Routine edits" switch is offered only when a routine bundle exists for every
// selected course, hidden otherwise.
test("the Routine edits switch stays hidden with no routine bundle available", async () => {
  const page = await openEditStage([CHECKED_ACTION]);
  assert.equal(page.hidden("#routine-switch"), true);
  assert.equal(page.hidden("#category-list"), false);
});

// WI-4.5 (D2, D2a, P2): the switch selects every routine bundle, lists them under itself with no
// disclosure, and hides manual Customize browsing while it is engaged.
test("the Routine edits switch selects every routine bundle and lists them with no disclosure", async () => {
  const page = await openEditStage([CHECKED_ACTION, FIELD_SELECTION_BUNDLE, ROUTINE_BUNDLE_B], [ANATOMY]);
  assert.equal(page.hidden("#routine-switch"), false);
  assert.equal(page.query("#routine-edits").checked, false);
  assert.equal(page.text("#routine-bundle-list"), "");

  await page.click("#routine-edits");
  assert.equal(page.query("#routine-edits").checked, true);
  assert.equal(page.hidden("#category-list"), true);
  assert.equal(page.hidden("#action-filter-field"), true);
  assert.equal(page.hidden("#action-checked-only-field"), true);
  assert.equal(page.query("#routine-bundle-list").closest("details"), null);
  const items = page.queryAll("#routine-bundle-list .routine-bundle-item span").map((span) => span.textContent);
  assert.deepEqual(items, [FIELD_SELECTION_BUNDLE.label, ROUTINE_BUNDLE_B.label]);
  // FIELD_SELECTION_BUNDLE is area "assignments", ROUTINE_BUNDLE_B is area "pages": 2 areas.
  assert.equal(page.text("#selection-summary"), "2 actions in 2 areas, no removal, 1 course");

  await page.click("#save-edit");
  await page.waitFor(() => page.messages("morrow_edit_policy_save").length === 1, "the page never saved Edit access");
  assert.deepEqual(page.messages("morrow_edit_policy_save")[0], {
    type: "morrow_edit_policy_save", sourceBindingId: ANATOMY.sourceBindingId,
    enabledCategories: [FIELD_SELECTION_BUNDLE.id, ROUTINE_BUNDLE_B.id],
  });
});

// WI-4.5 (P2): "Remove" beside a listed bundle narrows the grant the same way an unchecked
// Customize checkbox would, without leaving the always-visible list.
test("Remove beside a routine bundle narrows the switch's grant", async () => {
  const page = await openEditStage([FIELD_SELECTION_BUNDLE, ROUTINE_BUNDLE_B], [ANATOMY]);
  await page.click("#routine-edits");
  await page.click(`[data-remove-routine="${FIELD_SELECTION_BUNDLE.id}"]`);
  assert.deepEqual(page.queryAll("#routine-bundle-list .routine-bundle-item span").map((span) => span.textContent), [ROUTINE_BUNDLE_B.label]);
  assert.equal(page.query("#routine-edits").checked, true);

  await page.click("#save-edit");
  await page.waitFor(() => page.messages("morrow_edit_policy_save").length === 1, "the page never saved Edit access");
  assert.deepEqual(page.messages("morrow_edit_policy_save")[0].enabledCategories, [ROUTINE_BUNDLE_B.id]);
});

// WI-4.5: turning the switch off clears its selection and returns to manual Customize browsing.
test("turning the Routine edits switch off clears its selection and restores manual browsing", async () => {
  const page = await openEditStage([FIELD_SELECTION_BUNDLE, ROUTINE_BUNDLE_B], [ANATOMY]);
  await page.click("#routine-edits");
  await page.click("#routine-edits");
  assert.equal(page.query("#routine-edits").checked, false);
  assert.equal(page.hidden("#category-list"), false);
  assert.equal(page.text("#routine-bundle-list"), "");
  assert.equal(page.query("#save-edit").disabled, true);
});

test("the save notice caps the list of allowed actions at six, then counts the rest", async () => {
  const manyActions = Array.from({ length: 8 }, (_, index) => ({
    id: `canvas_action_${index + 1}`, group: "Focused Canvas repairs", label: `Action ${index + 1}`,
    description: `Action ${index + 1} description.`, availability: "edit", destructive: false, verification: "checked", area: "pages",
  }));
  const page = await openEditStage(manyActions, [ANATOMY]);
  await openCustomizeGroup(page, "pages", "edit");
  for (const action of manyActions) {
    await page.click(`#category-list input[value="${action.id}"]`);
  }
  await page.click("#save-edit");
  await page.waitFor(() => page.messages("morrow_edit_policy_save").length === 1, "the page never saved Edit access");
  assert.match(page.text("#notice"),
    /^Edit access saved for 1 course\. Allowed actions: Action 1, Action 2, Action 3, Action 4, Action 5, Action 6, and 2 more actions\. It stays on until you return the course to Plan\.$/);
});

test("saving Edit access for several courses shows progress only once the wait runs long enough to need it", async () => {
  const releases = [];
  const page = await openSettings({
    status: () => statusFixture([ANATOMY, PHYSIOLOGY]),
    options: (sourceBindingId) => optionsFixture(sourceBindingId, [CHECKED_ACTION]),
    handlers: {
      morrow_edit_policy_save: ({ sourceBindingId, enabledCategories }) => new Promise((resolve) => {
        releases.push(() => resolve({ editPermission: { ...editPermissionSummary(sourceBindingId), enabledCategories } }));
      }),
    },
  });
  await page.click("#course-select-mode");
  await page.click(`[data-binding-id="${ANATOMY.sourceBindingId}"] .course-select`);
  await page.waitFor(() => page.messages("morrow_edit_policy_options").some((message) => message.sourceBindingId === ANATOMY.sourceBindingId), "the first course's actions were never read");
  await page.click(`[data-binding-id="${PHYSIOLOGY.sourceBindingId}"] .course-select`);
  await page.waitFor(() => page.messages("morrow_edit_policy_options").some((message) => message.sourceBindingId === PHYSIOLOGY.sourceBindingId), "the second course's actions were never read");
  await page.click("#mode-edit");
  await openCustomizeGroup(page, "pages", "edit");
  await page.click(`#category-list input[value="${CHECKED_ACTION.id}"]`);
  assert.equal(page.text("#save-edit"), "Review and save");

  await page.click("#save-edit");
  await page.waitFor(() => releases.length === 1, "the first course save never started");
  assert.equal(page.text("#save-edit"), "Review and save", "no progress yet: the wait has not run long enough to need it");
  await page.waitFor(() => page.text("#save-edit") === "Saving 1 of 2 courses", "no progress appeared once the save ran long enough to need it");

  releases[0]();
  await page.waitFor(() => releases.length === 2, "the second course save never started");
  await page.waitFor(() => page.text("#save-edit") === "Saving 2 of 2 courses", "progress never advanced to the second course");

  releases[1]();
  await page.waitFor(() => !page.hidden("#notice"), "the save never finished");
  assert.match(page.text("#notice"), /^Edit access saved for 2 courses\./);
  // The progress text is gone: the button reads its ordinary label again, not the last progress line.
  assert.equal(page.text("#save-edit"), "Review and save");
});

test("an action Morrow cannot check, or one that removes content, is confirmed by name before it is saved", async () => {
  const page = await openEditStage([CHECKED_ACTION, UNCHECKED_ACTION, DESTRUCTIVE_ACTION]);
  await openCustomizeGroup(page, "pages", "edit");
  await openCustomizeGroup(page, "pages", "remove");
  const flags = (id) => page.query(`#category-list input[value="${id}"]`).closest(".category-option").querySelectorAll(".action-flag").map((flag) => flag.textContent);
  assert.deepEqual(flags(UNCHECKED_ACTION.id), ["Saved result not checked"]);
  assert.deepEqual(flags(DESTRUCTIVE_ACTION.id), ["Removes content"]);
  assert.deepEqual(flags(CHECKED_ACTION.id), []);
  assert.equal(actionInput(page, UNCHECKED_ACTION.id).closest(".category-option").querySelector("small").textContent,
    `${UNCHECKED_ACTION.description} ${UNCHECKED_ACTION.verificationReason}`);

  await page.click(`#category-list input[value="${UNCHECKED_ACTION.id}"]`);
  await page.click(`#category-list input[value="${DESTRUCTIVE_ACTION.id}"]`);
  await page.click("#save-edit");
  assert.equal(page.hidden("#save-confirmation"), false);
  assert.equal(page.document.activeElement?.getAttribute("id"), "cancel-save");
  assert.equal(page.text("#save-confirmation-detail"),
    "1 selected action removes course content: Delete page."
    + " Morrow cannot check the saved result for 1 selected action: Add course to favorites. Morrow reports those results as unconfirmed."
    + " Save Edit access anyway, or keep reviewing to change the selection.");
  assert.deepEqual(page.messages("morrow_edit_policy_save"), []);

  await page.click("#cancel-save");
  assert.equal(page.hidden("#save-confirmation"), true);
  assert.equal(page.document.activeElement?.getAttribute("id"), "save-edit");
  assert.deepEqual(page.messages("morrow_edit_policy_save"), []);

  await page.click("#save-edit");
  assert.equal(page.hidden("#save-confirmation"), false);
  await page.click("#confirm-save");
  await page.waitFor(() => page.messages("morrow_edit_policy_save").length > 0, "confirming never saved the Edit access");
  assert.deepEqual(page.messages("morrow_edit_policy_save")[0].enabledCategories, [UNCHECKED_ACTION.id, DESTRUCTIVE_ACTION.id]);
  await page.waitFor(() => page.text("#notice").startsWith("Edit access saved for 1 course."), "the saved access was never confirmed on the page");
  assert.match(page.text("#notice"), /Allowed actions: Add course to favorites, Delete page\./);
  assert.equal(page.hidden("#save-confirmation"), true);
});

// WI-5.5, D6: an area's own "select all" checkbox is always in the DOM (it is in the area's header,
// not its collapsible body), and it selects the "Create and edit" and "Publish and organize" kinds
// only, never "Remove content". CHECKED_ACTION and ROUTINE_BUNDLE_B are both area "pages" kind
// "edit" (neither is destructive); DESTRUCTIVE_ACTION is area "pages" kind "remove".
test("an area's select all selects its non-remove kinds only, and leaves removal off", async () => {
  const page = await openEditStage([CHECKED_ACTION, ROUTINE_BUNDLE_B, DESTRUCTIVE_ACTION]);
  const areaBox = page.query('[data-area-select="pages"]');
  assert.equal(areaBox.checked, false);
  assert.equal(page.text('[data-area-count="pages"]'), "0 of 2");
  assert.equal(page.text('[data-area-removal="pages"]'), "Removal off");

  await page.click('[data-area-select="pages"]');
  assert.equal(page.query('[data-area-select="pages"]').checked, true);
  assert.equal(page.query('[data-area-select="pages"]').indeterminate, false);
  assert.equal(page.text('[data-area-count="pages"]'), "2 of 2");
  assert.equal(page.text('[data-area-removal="pages"]'), "Removal off");

  await page.click("#save-edit");
  await page.waitFor(() => page.messages("morrow_edit_policy_save").length === 1, "the page never saved Edit access");
  assert.deepEqual(page.messages("morrow_edit_policy_save")[0].enabledCategories.sort(), [CHECKED_ACTION.id, ROUTINE_BUNDLE_B.id].sort());
});

// WI-5.5: a checkbox on each area or kind is a mixed state (indeterminate, aria-checked="mixed")
// when some but not all of what it covers is selected.
test("a partly selected kind is a mixed checkbox, and so is its area", async () => {
  const page = await openEditStage([CHECKED_ACTION, ROUTINE_BUNDLE_B]);
  await openCustomizeGroup(page, "pages", "edit");
  await page.click(`#category-list input[value="${CHECKED_ACTION.id}"]`);

  const kindBox = page.query('[data-kind-select="pages/edit"]');
  assert.equal(kindBox.checked, false);
  assert.equal(kindBox.indeterminate, true);
  assert.equal(kindBox.getAttribute("aria-checked"), "mixed");
  assert.equal(page.text('[data-kind-count="pages/edit"]'), "1 of 2");

  const areaBox = page.query('[data-area-select="pages"]');
  assert.equal(areaBox.checked, false);
  assert.equal(areaBox.indeterminate, true);
  assert.equal(areaBox.getAttribute("aria-checked"), "mixed");
});

// WI-5.5: "A change to one checkbox updates counts and states in the DOM. It must not render the
// list again, because that moves focus and scroll." A full render (innerHTML rebuild) replaces every
// element with a new object, so identical object references before and after prove no rebuild ran.
test("a checkbox change inside Customize updates in place, with no second render of the list", async () => {
  const page = await openEditStage([CHECKED_ACTION, ROUTINE_BUNDLE_B]);
  await openCustomizeGroup(page, "pages", "edit");
  const areaBefore = page.query('[data-area="pages"]');
  const kindBefore = page.query('[data-kind="pages/edit"]');

  await page.click(`#category-list input[value="${CHECKED_ACTION.id}"]`);
  assert.equal(page.query('[data-area="pages"]'), areaBefore);
  assert.equal(page.query('[data-kind="pages/edit"]'), kindBefore);
  assert.equal(actionInput(page, CHECKED_ACTION.id).checked, true);
  assert.equal(page.query('[data-kind-select="pages/edit"]').indeterminate, true);

  await page.click('[data-area-select="pages"]');
  assert.equal(page.query('[data-area="pages"]'), areaBefore);
  assert.equal(page.query('[data-kind="pages/edit"]'), kindBefore);
  assert.equal(actionInput(page, ROUTINE_BUNDLE_B.id).checked, true);
});

// WI-5.5: the summary bar states the grant in one sentence, always visible above "Review and save",
// before a person saves it.
test("the summary bar states the grant in one sentence before save", async () => {
  const page = await openEditStage([CHECKED_ACTION, ROUTINE_BUNDLE_B, DESTRUCTIVE_ACTION]);
  await openCustomizeGroup(page, "pages", "edit");
  await openCustomizeGroup(page, "pages", "remove");
  await page.click(`#category-list input[value="${CHECKED_ACTION.id}"]`);
  await page.click(`#category-list input[value="${DESTRUCTIVE_ACTION.id}"]`);
  assert.equal(page.text("#selection-summary"), "2 actions in 1 area, 1 action remove content, 1 course");
  assert.equal(page.text("#save-edit"), "Review and save");
});

// WI-5.3, D7: the row's own state text, read straight from the saved editPermission summary (no
// options fetch needed). "Custom" and "1 kind of edit" are told apart from "Routine edits" by
// comparing the saved set against every routine bundle for that provider.
test("a saved Edit access names its state on the row, and a saved grant past its old end time reads as Plan", async () => {
  const oneKind = canvasCourse(1, "Anatomy", { editPermission: { ...editPermissionSummary("canvas:course-1"), enabledCategories: [CHECKED_ACTION.id] } });
  const routine = canvasCourse(2, "Physiology", { editPermission: { ...editPermissionSummary("canvas:course-2"), enabledCategories: CANVAS_ROUTINE_IDS } });
  const custom = canvasCourse(3, "Genetics", { editPermission: { ...editPermissionSummary("canvas:course-3", { expiresAt: Date.now() + ONE_HOUR_MS }), enabledCategories: [CHECKED_ACTION.id, "canvas_publish_state"] } });
  const ended = canvasCourse(4, "Immunology", { editPermission: { ...editPermissionSummary("canvas:course-4", { expiresAt: Date.now() - 1_000 }), enabledCategories: [CHECKED_ACTION.id] } });
  const page = await openSettings({ status: () => statusFixture([oneKind, routine, custom, ended]) });
  const state = (sourceBindingId) => page.query(`[data-binding-id="${sourceBindingId}"] .course-row-state`).textContent;
  assert.equal(state("canvas:course-1"), "Edit. 1 kind of edit.");
  assert.equal(state("canvas:course-2"), "Edit. Routine edits.");
  assert.equal(state("canvas:course-3"), "Edit. Custom.", "a grant saved while Edit was timed promises no end time");
  assert.equal(state("canvas:course-4"), "Plan. Asks first.");
  assert.equal(page.query('[data-binding-id="canvas:course-1"] .course-row-state').classList.contains("on"), true);
  assert.equal(page.query('[data-binding-id="canvas:course-4"] .course-row-state').classList.contains("on"), false);
});

// WI-5.3: a course whose available actions changed (stale) reads as Plan on the row: Edit is
// paused until it is reviewed and saved again.
test("a course whose available actions changed is paused until it is saved again", async () => {
  const stale = canvasCourse(1, "Anatomy", {
    staleEditPermission: editPermissionSummary("canvas:course-1", { catalogDigest: "a".repeat(64) }),
  });
  const page = await openSettings({ status: () => statusFixture([stale]) });
  assert.equal(page.query('[data-binding-id="canvas:course-1"] .course-row-state').textContent, "Plan. Asks first.");
});

// WI-5.4: the course detail opens in place under a connected row when its name button is clicked.
async function openCourseDetail(page, sourceBindingId) {
  const button = page.query(`[data-toggle-course="${sourceBindingId}"]`);
  await page.click(`[data-toggle-course="${sourceBindingId}"]`);
  return page.query(`#${button.getAttribute("aria-controls")}`);
}

test("a connected row's name button opens and closes its detail in place", async () => {
  const page = await openSettings({ status: () => statusFixture([ANATOMY]) });
  const button = () => page.query(`[data-toggle-course="${ANATOMY.sourceBindingId}"]`);
  assert.equal(button().getAttribute("aria-expanded"), "false");
  const detailId = button().getAttribute("aria-controls");
  assert.equal(page.text(`#${detailId}`), "");

  await page.click(`[data-toggle-course="${ANATOMY.sourceBindingId}"]`);
  assert.equal(button().getAttribute("aria-expanded"), "true");
  assert.notEqual(page.text(`#${detailId}`), "");

  await page.click(`[data-toggle-course="${ANATOMY.sourceBindingId}"]`);
  assert.equal(button().getAttribute("aria-expanded"), "false");
  assert.equal(page.text(`#${detailId}`), "");
});

// WI-5.4: a Plan-level course's detail states what Morrow may do, with no allowed list (there is
// nothing allowed to list).
test("a Plan-level course's detail states what Morrow may do, with no allowed list", async () => {
  const page = await openSettings({ status: () => statusFixture([ANATOMY]) });
  const detail = await openCourseDetail(page, ANATOMY.sourceBindingId);
  assert.equal(detail.querySelector('[data-set-level="plan"]').getAttribute("aria-pressed"), "true");
  assert.equal(detail.querySelector('[data-set-level="routine"]').getAttribute("aria-pressed"), "false");
  assert.equal(detail.querySelector('[data-open-customize="1"][aria-pressed]'), null);
  assert.equal(detail.querySelector("[data-end-duration]"), null);
  assert.equal(detail.querySelector(".routine-bundle-list"), null);
  assert.match(detail.textContent, /Morrow asks before each change\./);
  assert.notEqual(detail.querySelector('[data-open-customize="1"]'), null);
  assert.notEqual(detail.querySelector('[data-disconnect="1"]'), null);
});

// WI-5.4, D7: a Routine-level course's detail shows the routine set (with Remove for each), from
// the saved summary alone (no options fetch needed to show it). Edit is not timed, so the detail
// offers no end time.
test("a Routine-level course's detail lists the routine bundles with Remove, and no end time", async () => {
  const routine = canvasCourse(1, "Anatomy", { editPermission: { ...editPermissionSummary("canvas:course-1"), enabledCategories: CANVAS_ROUTINE_IDS } });
  const page = await openSettings({ status: () => statusFixture([routine]) });
  const detail = await openCourseDetail(page, routine.sourceBindingId);
  assert.equal(detail.querySelector('[data-set-level="routine"]').getAttribute("aria-pressed"), "true");
  assert.match(detail.textContent, /Morrow makes the routine edits below without another approval until you choose Plan\./);
  assert.deepEqual(detail.querySelectorAll(".routine-bundle-item span").map((el) => el.textContent), CANVAS_ROUTINE_IDS.map(curatedLabel));
  assert.equal(detail.querySelector("[data-end-duration]"), null);
  assert.equal(detail.querySelector("select"), null);
});

// WI-5.4: a saved list that is neither empty nor the full routine set reads as "custom", with its
// own third pressed chip and its own allowed list.
test("a custom-level course's detail shows the Custom chip and its own allowed list", async () => {
  const ids = ["canvas_assignment_text", "canvas_publish_state"];
  const custom = canvasCourse(1, "Anatomy", { editPermission: { ...editPermissionSummary("canvas:course-1"), enabledCategories: ids } });
  const page = await openSettings({ status: () => statusFixture([custom]) });
  const detail = await openCourseDetail(page, custom.sourceBindingId);
  assert.equal(detail.querySelector('[data-open-customize="1"][aria-pressed="true"]').textContent, "Custom");
  assert.deepEqual(detail.querySelectorAll(".routine-bundle-item span").map((el) => el.textContent), ids.map(curatedLabel));
  assert.match(detail.textContent, /Morrow makes the changes you selected in Customize until you choose Plan\. It asks before every other change\./);
});

test("the detail's own Plan button returns just that course to Plan", async () => {
  const revoked = [];
  const routine = canvasCourse(1, "Anatomy", { editPermission: { ...editPermissionSummary("canvas:course-1"), enabledCategories: CANVAS_ROUTINE_IDS } });
  const page = await openSettings({
    status: () => statusFixture([routine]),
    handlers: { morrow_edit_policy_revoke: ({ sourceBindingId }) => { revoked.push(sourceBindingId); return { revoked: true }; } },
  });
  const detail = await openCourseDetail(page, routine.sourceBindingId);
  await page.click(`#${detail.getAttribute("id")} [data-set-level="plan"]`);
  await page.waitFor(() => page.text("#notice") !== "", "the page never reported the Plan return");
  assert.deepEqual(revoked, [routine.sourceBindingId]);
  assert.equal(page.text("#notice"), "Anatomy is in Plan. Morrow asks first.");
});

// D2: the detail's own Edit shortcut is always the full routine set, for this one course only (the
// same rule the bulk bar's Edit shortcut already applies).
test("the detail's own Edit. Routine edits. button turns on the routine set for that course", async () => {
  const plan = canvasCourse(1, "Anatomy");
  const page = await openSettings({
    status: () => statusFixture([plan]),
    options: (sourceBindingId) => optionsFixture(sourceBindingId, [FIELD_SELECTION_BUNDLE, ROUTINE_BUNDLE_B]),
  });
  const detail = await openCourseDetail(page, plan.sourceBindingId);
  await page.click(`#${detail.getAttribute("id")} [data-set-level="routine"]`);
  await page.waitFor(() => page.messages("morrow_edit_policy_save").length === 1, "the page never saved routine edits for this course");
  assert.deepEqual(page.messages("morrow_edit_policy_save")[0], {
    type: "morrow_edit_policy_save", sourceBindingId: plan.sourceBindingId,
    enabledCategories: [FIELD_SELECTION_BUNDLE.id, ROUTINE_BUNDLE_B.id],
  });
  await page.waitFor(() => page.text("#notice") !== "", "the page never confirmed routine edits");
  assert.equal(page.text("#notice"), "Routine edits are on for Anatomy. They stay on until you choose Plan.");
});

// WI-5.4: "Remove" saves the list without that bundle.
test("Remove saves the list without that bundle", async () => {
  const custom = canvasCourse(1, "Anatomy", { editPermission: { ...editPermissionSummary("canvas:course-1"), enabledCategories: ["canvas_assignment_text", "canvas_publish_state"] } });
  const page = await openSettings({ status: () => statusFixture([custom]) });
  const detail = await openCourseDetail(page, custom.sourceBindingId);
  await page.click(`#${detail.getAttribute("id")} [data-remove-category="canvas_publish_state"]`);
  await page.waitFor(() => page.messages("morrow_edit_policy_save").length === 1, "the page never saved the reduced list");
  assert.deepEqual(page.messages("morrow_edit_policy_save")[0], {
    type: "morrow_edit_policy_save", sourceBindingId: custom.sourceBindingId,
    enabledCategories: ["canvas_assignment_text"],
  });
  await page.waitFor(() => page.text("#notice") !== "", "the page never confirmed the removal");
  assert.equal(page.text("#notice"), `Removed. Morrow asks again before it changes ${curatedLabel("canvas_publish_state").toLowerCase()} in Anatomy.`);
});

// WI-5.4: the protocol refuses an empty enabledCategories list, so removing the last bundle
// returns the course to Plan instead, exactly what an empty allowed list means everywhere else (D7).
test("Remove on the last remaining bundle returns the course to Plan", async () => {
  const oneKind = canvasCourse(1, "Anatomy", { editPermission: { ...editPermissionSummary("canvas:course-1"), enabledCategories: ["canvas_assignment_text"] } });
  const revoked = [];
  const page = await openSettings({
    status: () => statusFixture([oneKind]),
    handlers: { morrow_edit_policy_revoke: ({ sourceBindingId }) => { revoked.push(sourceBindingId); return { revoked: true }; } },
  });
  const detail = await openCourseDetail(page, oneKind.sourceBindingId);
  await page.click(`#${detail.getAttribute("id")} [data-remove-category="canvas_assignment_text"]`);
  await page.waitFor(() => page.text("#notice") !== "", "the page never reported the Plan return");
  assert.deepEqual(revoked, [oneKind.sourceBindingId]);
  assert.equal(page.text("#notice"), "Anatomy is in Plan. Morrow asks first.");
  assert.equal(page.messages("morrow_edit_policy_save").length, 0);
});

// WI-5.4: "Customize" (and the "Custom" chip) select only that one course, so a visit cannot
// change any other course's Edit access, and switch to Edit in the Course access panel below
// (WI-5.5 gives that panel the Customize view's own areas, kinds and actions).
test("Customize selects only that course and switches to Edit in Course access below", async () => {
  const optionsRequested = [];
  const page = await openSettings({
    status: () => statusFixture([ANATOMY, PHYSIOLOGY]),
    options: (sourceBindingId) => { optionsRequested.push(sourceBindingId); return optionsFixture(sourceBindingId, [CHECKED_ACTION]); },
  });
  const detail = await openCourseDetail(page, ANATOMY.sourceBindingId);
  await page.click(`#${detail.getAttribute("id")} [data-open-customize="1"]`);
  await page.waitFor(() => optionsRequested.length > 0, "the page never read this course's own actions");
  assert.equal(page.query("#mode-edit").checked, true);
  assert.deepEqual(optionsRequested, [ANATOMY.sourceBindingId]);
  assert.equal(page.text("#notice"), "Choose the changes for Anatomy in Course access, below.");
});

// WI-5.4: Disconnect removes this one course, with its Edit access, after the person confirms it
// in place. Keeping the course changes nothing.
test("Disconnect asks once in place, then disconnects just that course", async () => {
  const routine = canvasCourse(1, "Anatomy", { editPermission: { ...editPermissionSummary("canvas:course-1"), enabledCategories: CANVAS_ROUTINE_IDS } });
  let bindings = [routine, PHYSIOLOGY];
  const page = await openSettings({
    status: () => statusFixture(bindings),
    handlers: {
      morrow_course_disconnect: ({ sourceBindingId }) => {
        bindings = bindings.filter((binding) => binding.sourceBindingId !== sourceBindingId);
        return { disconnected: true, sourceBindingId };
      },
    },
  });
  const detail = await openCourseDetail(page, routine.sourceBindingId);
  const detailId = detail.getAttribute("id");
  await page.click(`#${detailId} [data-disconnect="1"]`);
  assert.equal(page.messages("morrow_course_disconnect").length, 0, "one click must not disconnect");
  assert.equal(page.text(`#${detailId} .course-disconnect-confirm p`), "Disconnect Anatomy? Morrow stops reading and changing this course, and its Edit access is removed. Your course in Canvas is not changed. You can connect it again from this list.");
  await page.click(`#${detailId} [data-disconnect-cancel="1"]`);
  assert.equal(page.queryAll(`#${detailId} .course-disconnect-confirm`).length, 0);
  assert.equal(page.messages("morrow_course_disconnect").length, 0);

  await page.click(`#${detailId} [data-disconnect="1"]`);
  await page.click(`#${detailId} [data-disconnect-confirm="1"]`);
  await page.waitFor(() => page.text("#notice") !== "", "the page never reported the disconnected course");
  assert.deepEqual(page.messages("morrow_course_disconnect"), [{ type: "morrow_course_disconnect", sourceBindingId: routine.sourceBindingId }]);
  assert.equal(page.text("#notice"), "Anatomy is disconnected. Its Edit access was removed.");
  await page.waitFor(() => page.queryAll(`[data-binding-id="${routine.sourceBindingId}"]`).length === 0, "the disconnected course still shows as connected");
  assert.equal(page.queryAll(`[data-binding-id="${PHYSIOLOGY.sourceBindingId}"]`).length, 1);
});

test("a refused Disconnect names the problem and leaves the course connected", async () => {
  const page = await openSettings({
    status: () => statusFixture([ANATOMY]),
    handlers: { morrow_course_disconnect: () => ({ ok: false, code: "edit_policy_binding_missing", error: "edit_policy_binding_missing" }) },
  });
  const detail = await openCourseDetail(page, ANATOMY.sourceBindingId);
  await page.click(`#${detail.getAttribute("id")} [data-disconnect="1"]`);
  await page.click(`#${detail.getAttribute("id")} [data-disconnect-confirm="1"]`);
  await page.waitFor(() => !page.hidden("#error"), "the refused disconnect was not reported");
  assert.equal(page.text("#error"), problemText("edit_policy_binding_missing"));
  assert.equal(page.queryAll(`[data-binding-id="${ANATOMY.sourceBindingId}"][data-row-kind="connected"]`).length, 1);
});

test("returning courses to Plan removes each access, and says how far it got when one is refused", async () => {
  const revoked = [];
  let holdRefresh = null;
  const page = await openSettings({
    status: () => (holdRefresh ? holdRefresh.then(() => statusFixture([ANATOMY, PHYSIOLOGY])) : statusFixture([ANATOMY, PHYSIOLOGY])),
    options: (sourceBindingId) => optionsFixture(sourceBindingId, [CHECKED_ACTION]),
    handlers: {
      morrow_edit_policy_revoke: ({ sourceBindingId }) => {
        revoked.push(sourceBindingId);
        return { revoked: sourceBindingId === ANATOMY.sourceBindingId };
      },
    },
  });
  await selectCourse(page, ANATOMY.sourceBindingId);
  await page.click("#return-plan");
  await page.waitFor(() => page.text("#notice") !== "", "the page never reported the returned course");
  assert.deepEqual(revoked, [ANATOMY.sourceBindingId]);
  assert.equal(page.text("#notice"), "1 course returned to Plan. Edit access was removed immediately.");
  assert.equal(page.query("#mode-plan").checked, true);
  assert.equal(page.hidden("#error"), true);

  // Physiology refuses. The message is read at the moment the page writes it, because the refresh
  // that follows a Plan return reads the status again and clears the error region.
  revoked.length = 0;
  await selectCourse(page, PHYSIOLOGY.sourceBindingId);
  let release = () => {};
  holdRefresh = new Promise((resolve) => { release = resolve; });
  await page.click("#return-plan");
  await page.waitFor(() => page.text("#error") !== "", "the page never reported the refused removal");
  assert.deepEqual(revoked, [ANATOMY.sourceBindingId, PHYSIOLOGY.sourceBindingId]);
  assert.equal(page.text("#error"), `1 course returned to Plan. ${problemText("edit_policy_revoke_unconfirmed")}`);
  release();
  holdRefresh = null;
  await page.flush();
});

// WI-1.4: the banner offers the one-click "stop all access" budget row, without first selecting
// any course. It reuses returnToPlan (the same handler "Return selected courses to Plan" uses), so
// only its own result text and count differ from that flow.
test("a banner offers to ask first in all courses while any connection can act with no review, and clears once none can", async () => {
  let editingPermission = { ...editPermissionSummary("canvas:course-1"), enabledCategories: [CHECKED_ACTION.id] };
  const planOnly = canvasCourse(2, "Physiology");
  const revoked = [];
  const page = await openSettings({
    status: () => statusFixture([
      canvasCourse(1, "Anatomy", editingPermission ? { editPermission: editingPermission } : {}),
      planOnly,
    ]),
    handlers: {
      morrow_edit_policy_revoke: ({ sourceBindingId }) => {
        revoked.push(sourceBindingId);
        editingPermission = null;
        return { revoked: true };
      },
    },
  });
  assert.equal(page.hidden("#edit-access-banner"), false);
  assert.equal(page.text("#edit-access-banner-text"), "Morrow can make some changes with no review in 1 course.");
  assert.equal(page.query("#ask-first-all-courses").disabled, false);

  await page.click("#ask-first-all-courses");
  await page.waitFor(() => page.text("#notice") !== "", "the page never reported the result");
  assert.deepEqual(revoked, ["canvas:course-1"]);
  assert.equal(page.text("#notice"), "Done. Morrow asks first in all courses.");
  assert.equal(page.text("#announcement"), "Done. Morrow asks first in all courses.");
  assert.equal(page.hidden("#edit-access-banner"), true);
});

test("the banner counts every connection that can act with no review, and ignores a saved grant past its old end time", async () => {
  const first = canvasCourse(1, "Anatomy", { editPermission: { ...editPermissionSummary("canvas:course-1"), enabledCategories: [CHECKED_ACTION.id] } });
  const second = canvasCourse(2, "Physiology", { editPermission: { ...editPermissionSummary("canvas:course-2", { expiresAt: Date.now() + ONE_HOUR_MS }), enabledCategories: [CHECKED_ACTION.id] } });
  const ended = canvasCourse(3, "Genetics", { editPermission: { ...editPermissionSummary("canvas:course-3", { expiresAt: Date.now() - 1_000 }), enabledCategories: [CHECKED_ACTION.id] } });
  const page = await openSettings({ status: () => statusFixture([first, second, ended]) });
  assert.equal(page.text("#edit-access-banner-text"), "Morrow can make some changes with no review in 2 courses.");

  const none = await openSettings({ status: () => statusFixture([canvasCourse(4, "History")]) });
  assert.equal(none.hidden("#edit-access-banner"), true);
});

test("a state the page cannot read is named as itself, with the next action", async () => {
  const page = await openSettings({
    status: () => ({ ok: false, code: "bridge_extension_unreachable", error: "bridge_extension_unreachable" }),
  });
  assert.equal(page.hidden("#error"), false);
  assert.equal(page.text("#error"), problemText("bridge_extension_unreachable"));
  assert.equal(page.text("#connection-status"), "Connected courses were not checked.");
  assert.equal(page.text("#course-list"), "Connected courses were not checked. Select Refresh connected courses.");
  assert.equal(page.text("#selection-summary"), "Course access was not checked. Select Refresh connected courses.");
  assert.equal(page.query("#refresh").disabled, false);

  const unreadable = await openSettings({ status: () => ({ bindings: "none" }) });
  assert.equal(unreadable.text("#error"), problemText("edit_policy_status_unreadable"));
  assert.equal(unreadable.text("#connection-status"), "Connected courses were not checked.");
});

// WI-5.3: connecting is per row now ("Connect"), not a multi-select-then-bulk-connect flow.
test("available Canvas course IDs remain exact decimal strings through selection and readback", async () => {
  const site = {
    siteAnchorId: "canvas-site-1", provider: "canvas", origin: "https://canvas.example.edu",
    principalId: "teacher@example.edu", sessionGeneration: 4, runtimeVerified: true,
  };
  const discovery = {
    ...site,
    discoveryReceiptId: "discovery-1",
    expiresAt: Date.now() + 60_000,
    courses: [{ id: "42", name: "Small ID" }, { id: "9007199254740993", name: "64-bit ID" }],
    pageNumber: 1, complete: true, courseCount: 2,
  };
  const saved = [];
  const page = await openSettings({
    status: () => statusFixture([], { siteAnchors: [site] }),
    handlers: {
      morrow_course_discovery_start: () => discovery,
      morrow_course_selection_save: ({ siteAnchorId, courseIds }) => {
        saved.push(courseIds);
        return { siteAnchorId, bindings: courseIds.map((courseId) => ({ provider: "canvas", courseId })) };
      },
    },
  });
  // WI-5.2: discovery for a signed-in site now starts by itself, with no "Find courses" click.
  await page.waitFor(() => page.queryAll("[data-connect-row]").length === 2, "the available Canvas courses did not render");
  // WI-5.3 order: neither course is a favorite, so they sort by name ("64-bit ID" before "Small ID").
  assert.deepEqual(page.queryAll(".course-row-name").map((el) => el.textContent), ["64-bit ID", "Small ID"]);

  await page.click('[data-connect-row="https://canvas.example.edu|42"]');
  await page.waitFor(() => saved.length === 1, "the first available course was never sent to connect");
  assert.deepEqual(saved[0], ["42"]);
  assert.equal(typeof saved[0][0], "string");
  assert.equal(page.hidden("#error"), true);

  await page.click('[data-connect-row="https://canvas.example.edu|9007199254740993"]');
  await page.waitFor(() => saved.length === 2, "the 64-bit-id available course was never sent to connect");
  assert.deepEqual(saved[1], ["9007199254740993"]);

  const malformed = await openSettings({
    status: () => statusFixture([], { siteAnchors: [site] }),
    handlers: {
      morrow_course_discovery_start: () => ({
        ...discovery,
        discoveryReceiptId: "discovery-invalid",
        courses: [{ id: "01", name: "Noncanonical ID" }],
        courseCount: 1,
      }),
    },
  });
  await malformed.waitFor(() => !malformed.hidden("#error"), "the malformed Canvas course ID was not refused");
  assert.equal(malformed.text("#error"), problemText("course_discovery_failed"));
  assert.equal(malformed.queryAll("[data-connect-row]").length, 0);
});

// WI-5.1: normalizeDiscovery accepts the optional code, term, role, favorite and published fields
// courseSummary (canvas-content.js) and discoveryCourses (service-worker.js) may send. A course
// carrying them, or carrying one with the wrong type, is neither rejected nor dropped: only the
// mistyped field itself is left off. WI-5.3: the row's meta line shows code, term, platform, role.
test("discovery accepts a course's optional fields, and drops one with the wrong type instead of refusing the course", async () => {
  const site = {
    siteAnchorId: "canvas-site-2", provider: "canvas", origin: "https://canvas.example.edu",
    principalId: "teacher@example.edu", sessionGeneration: 4, runtimeVerified: true,
  };
  const discovery = {
    ...site,
    discoveryReceiptId: "discovery-optional-fields",
    expiresAt: Date.now() + 60_000,
    courses: [
      { id: "10", name: "Anatomy", code: "BIO-201", term: "Fall 2026", role: "TeacherEnrollment", favorite: true, published: false },
      { id: "11", name: "Physiology", term: 12345, favorite: "yes" },
    ],
    pageNumber: 1, complete: true, courseCount: 2,
  };
  const page = await openSettings({
    status: () => statusFixture([], { siteAnchors: [site] }),
    handlers: { morrow_course_discovery_start: () => discovery },
  });
  await page.waitFor(() => page.queryAll("[data-connect-row]").length === 2, "the discovered courses carrying optional fields did not render");
  assert.equal(page.hidden("#error"), true);
  const rows = page.queryAll('.course-row[data-row-kind="available"]');
  // Anatomy is a favorite: it sorts first and carries the star.
  assert.equal(rows[0].querySelector(".course-row-name").textContent, "★Anatomy");
  assert.equal(rows[0].querySelector(".course-row-meta").textContent, "BIO-201 · Fall 2026 · Canvas · TeacherEnrollment");
  // A numeric term and a string "yes" for favorite are dropped, not refused: Physiology renders
  // with no code, no term, and no star.
  assert.equal(rows[1].querySelector(".course-row-name").textContent, "Physiology");
  assert.equal(rows[1].querySelector(".course-row-meta").textContent, "Canvas");
});

// WI-5.2: the "Find courses" button is gone. Discovery for a signed-in, runtime-verified site now
// starts as soon as the page reads its status, with no click required.
test("discovery for a signed-in site starts by itself, with no click", async () => {
  const site = {
    siteAnchorId: "canvas-site-auto", provider: "canvas", origin: "https://canvas.example.edu",
    principalId: "teacher@example.edu", sessionGeneration: 1, runtimeVerified: true,
  };
  const started = [];
  const page = await openSettings({
    status: () => statusFixture([], { siteAnchors: [site] }),
    handlers: {
      morrow_course_discovery_start: ({ siteAnchorId }) => {
        started.push(siteAnchorId);
        return {
          ...site, discoveryReceiptId: "discovery-auto", expiresAt: Date.now() + 60_000,
          courses: [{ id: "7", name: "Anatomy" }], pageNumber: 1, complete: true, courseCount: 1,
        };
      },
    },
  });
  await page.waitFor(() => started.length === 1, "discovery never started on its own");
  assert.deepEqual(started, ["canvas-site-auto"]);
  await page.waitFor(() => page.queryAll("[data-connect-row]").length === 1, "the discovered course did not render");
});

// WI-5.2, WI-5.3: an empty discovery result never takes over the page: it just adds nothing to the
// "Not connected" part of the one merged list, so the connected rows keep showing with no
// disruption.
test("an empty discovery result leaves the connected course list showing", async () => {
  const site = {
    siteAnchorId: "canvas-site-empty", provider: "canvas", origin: "https://canvas.example.edu",
    principalId: "teacher@example.edu", sessionGeneration: 1, runtimeVerified: true,
  };
  const page = await openSettings({
    status: () => statusFixture([ANATOMY], { siteAnchors: [site] }),
    handlers: {
      morrow_course_discovery_start: () => ({
        ...site, discoveryReceiptId: "discovery-empty", expiresAt: Date.now() + 60_000,
        courses: [], pageNumber: 1, complete: true, courseCount: 0,
      }),
    },
  });
  await page.waitFor(() => page.messages("morrow_course_discovery_start").length === 1, "discovery never started on its own");
  await page.flush();
  assert.equal(page.queryAll("[data-connect-row]").length, 0);
  assert.equal(page.queryAll(".course-row-name").map((el) => el.textContent).includes("Anatomy"), true);
});

function discoverySite(siteAnchorId, provider = "canvas") {
  return {
    siteAnchorId, provider, origin: provider === "moodle" ? "https://moodle.example.edu" : "https://canvas.example.edu",
    principalId: "teacher@example.edu", sessionGeneration: 1, runtimeVerified: true,
  };
}

function discoveryResult(site, receiptId, courses, fields = {}) {
  return { ...site, discoveryReceiptId: receiptId, expiresAt: Date.now() + 60_000, courses, pageNumber: 1, complete: true, courseCount: courses.length, ...fields };
}

// Each signed-in site keeps its own list of available courses, so a second site never replaces
// the first, and Connect on a row uses that row's own site and list.
test("every signed-in site lists its own available courses, and Connect uses that row's own site", async () => {
  const canvas = discoverySite("canvas-site-a");
  const moodle = discoverySite("moodle-site-b", "moodle");
  const saved = [];
  const page = await openSettings({
    status: () => statusFixture([], { siteAnchors: [canvas, moodle] }),
    handlers: {
      morrow_course_discovery_start: ({ siteAnchorId }) => siteAnchorId === canvas.siteAnchorId
        ? discoveryResult(canvas, "discovery-canvas", [{ id: "7", name: "Anatomy" }])
        : discoveryResult(moodle, "discovery-moodle", [{ id: "8", name: "Chemistry" }]),
      morrow_course_selection_save: ({ siteAnchorId, discoveryReceiptId, courseIds }) => {
        saved.push({ siteAnchorId, discoveryReceiptId, courseIds });
        return { siteAnchorId, bindings: courseIds.map((courseId) => ({ courseId })) };
      },
    },
  });
  await page.waitFor(() => page.queryAll("[data-connect-row]").length === 2, "both sites' available courses never showed together");
  assert.deepEqual(page.queryAll('.course-row[data-row-kind="available"] .course-row-name').map((el) => el.textContent), ["Anatomy", "Chemistry"]);
  await page.click('[data-connect-row="https://moodle.example.edu|8"]');
  await page.waitFor(() => saved.length === 1, "Connect never reached the Moodle site");
  assert.deepEqual(saved[0], { siteAnchorId: moodle.siteAnchorId, discoveryReceiptId: "discovery-moodle", courseIds: ["8"] });
});

test("available courses sort by number within a name, not character by character", async () => {
  const site = discoverySite("canvas-site-numbered");
  const page = await openSettings({
    status: () => statusFixture([], { siteAnchors: [site] }),
    handlers: {
      morrow_course_discovery_start: () => discoveryResult(site, "discovery-numbered",
        ["Course 10", "Course 2", "Course 100", "Course 1", "Course 11"].map((name, index) => ({ id: String(index + 1), name }))),
    },
  });
  await page.waitFor(() => page.queryAll("[data-connect-row]").length === 5, "the available courses never showed");
  assert.deepEqual(page.queryAll('.course-row[data-row-kind="available"] .course-row-name').map((el) => el.textContent),
    ["Course 1", "Course 2", "Course 10", "Course 11", "Course 100"]);
});

test("a section heading counts every course in that section, not only the rows shown", async () => {
  const canvas = discoverySite("canvas-site-large");
  const moodle = discoverySite("moodle-site-large", "moodle");
  const courses = (prefix) => Array.from({ length: 60 }, (_, index) => ({ id: String(index + 1), name: `${prefix} ${index + 1}` }));
  const page = await openSettings({
    status: () => statusFixture([], { siteAnchors: [canvas, moodle] }),
    handlers: {
      morrow_course_discovery_start: ({ siteAnchorId }) => siteAnchorId === canvas.siteAnchorId
        ? discoveryResult(canvas, "discovery-canvas-large", courses("Anatomy"))
        : discoveryResult(moodle, "discovery-moodle-large", courses("Chemistry")),
    },
  });
  await page.waitFor(() => page.queryAll("[data-connect-row]").length === 100, "the first 100 available courses never showed");
  assert.deepEqual(page.queryAll(".listhead").map((el) => el.textContent), ["Not connected · 120"]);
});

// A list of available courses is good for a few minutes only. The rows stay, and Connect reads
// the list again first, so a person never has to find the courses again by hand.
test("Connect on a list that expired reads that site's list again, then connects from the new list", async () => {
  const site = discoverySite("canvas-site-expiring");
  let reads = 0;
  const saved = [];
  const page = await openSettings({
    status: () => statusFixture([], { siteAnchors: [site] }),
    handlers: {
      morrow_course_discovery_start: () => {
        reads += 1;
        return discoveryResult(site, `discovery-${reads}`, [{ id: "7", name: "Anatomy" }], reads === 1 ? { expiresAt: Date.now() + 40 } : {});
      },
      morrow_course_selection_save: ({ siteAnchorId, discoveryReceiptId, courseIds }) => {
        saved.push(discoveryReceiptId);
        return { siteAnchorId, bindings: courseIds.map((courseId) => ({ courseId })) };
      },
    },
  });
  await page.waitFor(() => page.queryAll("[data-connect-row]").length === 1, "the available course never showed");
  await new Promise((resolve) => setTimeout(resolve, 60));
  await page.click('[data-connect-row="https://canvas.example.edu|7"]');
  await page.waitFor(() => saved.length === 1, "Connect never ran after the list expired");
  assert.equal(reads, 2);
  assert.deepEqual(saved, ["discovery-2"]);
  assert.equal(page.hidden("#error"), true);
  assert.equal(page.text("#notice"), "Anatomy is connected in Plan. Morrow asks before each change.");
});

test("Connect that the Bridge answers with an old or missing list reads the list again and tries once more", async () => {
  for (const code of ["course_discovery_receipt_stale", "course_discovery_receipt_missing"]) {
    const site = discoverySite(`canvas-site-${code}`);
    let reads = 0;
    const saved = [];
    const page = await openSettings({
      status: () => statusFixture([], { siteAnchors: [site] }),
      handlers: {
        morrow_course_discovery_start: () => {
          reads += 1;
          return discoveryResult(site, `discovery-${reads}`, [{ id: "7", name: "Anatomy" }]);
        },
        morrow_course_selection_save: ({ siteAnchorId, discoveryReceiptId, courseIds }) => {
          saved.push(discoveryReceiptId);
          if (saved.length === 1) return { ok: false, code, error: code };
          return { siteAnchorId, bindings: courseIds.map((courseId) => ({ courseId })) };
        },
      },
    });
    await page.waitFor(() => page.queryAll("[data-connect-row]").length === 1, "the available course never showed");
    await page.click('[data-connect-row="https://canvas.example.edu|7"]');
    await page.waitFor(() => saved.length === 2, `Connect was not tried again after ${code}`);
    assert.deepEqual(saved, ["discovery-1", "discovery-2"], code);
    await page.waitFor(() => page.text("#notice") !== "", "the connection was never reported");
    assert.equal(page.hidden("#error"), true, code);
  }
});

// A failed read is not tried again on every background refresh. Refresh connected courses reads
// every site's list again, the one next step the failure copy names.
test("a failed list of available courses is read again when the person selects Refresh connected courses", async () => {
  const site = discoverySite("canvas-site-failing");
  let reads = 0;
  const page = await openSettings({
    status: () => statusFixture([], { siteAnchors: [site] }),
    handlers: {
      morrow_course_discovery_start: () => {
        reads += 1;
        if (reads === 1) return { ok: false, code: "course_discovery_failed", error: "course_discovery_failed" };
        return discoveryResult(site, "discovery-after-refresh", [{ id: "7", name: "Anatomy" }]);
      },
    },
  });
  await page.waitFor(() => !page.hidden("#error"), "the failed read was not reported");
  assert.equal(page.text("#error"), problemText("course_discovery_failed"));
  assert.match(page.text("#error"), /Refresh connected courses/);
  page.listeners.message[0]({ type: "morrow_bridge_status_changed" });
  await page.flush();
  assert.equal(reads, 1, "a background refresh must not retry a failed read on its own");

  await page.click("#refresh");
  await page.waitFor(() => page.queryAll("[data-connect-row]").length === 1, "Refresh connected courses never read the list again");
  assert.equal(reads, 2);
  assert.equal(page.hidden("#error"), true);
});

// WI-1.2 (D1a): the checkbox reads the stored setting service-worker.js's openPlatform reads
// (openPlatformWhenNeeded; a missing key means on), and writes a change back with no save step.
test("the open-platform checkbox reads the stored setting, and writes a change back at once", async () => {
  const page = await openSettings({ status: () => statusFixture([]) });
  assert.equal(page.query("#open-platform-when-needed").checked, true, "a missing key must default to on");

  await page.click("#open-platform-when-needed");
  assert.equal(page.query("#open-platform-when-needed").checked, false);
  assert.equal(page.storage.openPlatformWhenNeeded, false);

  const reopened = await openSettings({ status: () => statusFixture([]), storage: { openPlatformWhenNeeded: false } });
  assert.equal(reopened.query("#open-platform-when-needed").checked, false);
});

test("course file access is off until Chrome grants it, and off again the moment Chrome takes it back", async () => {
  // The manifest is the contract Chrome enforces: HTTPS access is optional, so Chrome asks the
  // person for it only when they turn course file access on.
  assert.deepEqual(manifest.optional_host_permissions, ["https://*/*"]);

  const page = await openSettings({ status: () => statusFixture([]) });
  assert.equal(page.text("#file-storage-status"), "Off. Morrow cannot access course file content.");
  assert.deepEqual(page.permissionCalls, []);
  assert.equal(page.hidden("#revoke-file-storage"), true);

  await page.click("#enable-file-storage");
  await page.waitFor(() => page.text("#file-storage-status").startsWith("On."), "Chrome granted the permission and the page never turned access on");
  assert.equal(page.text("#file-storage-status"), "On. Morrow can read confirmed Canvas course files and transfer reviewed material.");
  assert.deepEqual(page.permissionCalls, [{ method: "request", origins: manifest.optional_host_permissions }]);
  assert.deepEqual(page.storage, { [COURSE_FILE_ACCESS_KEY]: true });
  assert.equal(page.hidden("#enable-file-storage"), true);
  assert.equal(page.hidden("#revoke-file-storage"), false);
  assert.equal(page.text("#notice"), "Course file access is on. Morrow will still use only files it confirms belong to selected Canvas courses.");

  await page.click("#revoke-file-storage");
  await page.waitFor(() => page.text("#file-storage-status").startsWith("Off."), "the page never turned course file access off");
  assert.equal(page.text("#file-storage-status"), "Off. Morrow cannot access course file content.");
  assert.deepEqual(page.permissionCalls.at(-1), { method: "remove", origins: manifest.optional_host_permissions });
  assert.deepEqual(page.storage, { [COURSE_FILE_ACCESS_KEY]: false });
  assert.equal(page.text("#notice"), "Course file access and its optional HTTPS permission are off. Existing Canvas connections remain available.");
});

test("the stored choice alone never turns course file access on: Chrome decides", async () => {
  // optedIn && browserPermission is the whole rule. Each half without the other reads as off.
  const revokedInChrome = await openSettings({
    status: () => statusFixture([]),
    storage: { [COURSE_FILE_ACCESS_KEY]: true },
    permission: { granted: false },
  });
  assert.equal(revokedInChrome.text("#file-storage-status"), "Off. Chrome permission was removed, so Morrow keeps course file access off.");
  assert.deepEqual(revokedInChrome.storage, { [COURSE_FILE_ACCESS_KEY]: false });

  const permissionWithoutOptIn = await openSettings({ status: () => statusFixture([]), permission: { granted: true } });
  assert.equal(permissionWithoutOptIn.text("#file-storage-status"), "Off. Chrome has HTTPS access, but Morrow course file access stays off.");
  assert.equal(permissionWithoutOptIn.text("#enable-file-storage"), "Turn on course file access");
  assert.equal(permissionWithoutOptIn.hidden("#revoke-file-storage"), false);

  const bothOn = await openSettings({
    status: () => statusFixture([]),
    storage: { [COURSE_FILE_ACCESS_KEY]: true },
    permission: { granted: true },
  });
  assert.equal(bothOn.text("#file-storage-status"), "On. Morrow can read confirmed Canvas course files and transfer reviewed material.");

  const refused = await openSettings({ status: () => statusFixture([]), permission: { granted: false, onRequest: () => false } });
  await refused.click("#enable-file-storage");
  await refused.waitFor(() => refused.text("#notice") !== "", "the page never answered the refused permission");
  assert.equal(refused.text("#notice"), "Course file access remains off. Chrome did not grant HTTPS file access.");
  assert.equal(refused.text("#file-storage-status"), "Off. Morrow cannot access course file content.");
  assert.deepEqual(refused.storage, { [COURSE_FILE_ACCESS_KEY]: false });
});

/** The worker's own message listener, kept because the module is loaded once. */
let serviceWorkerMessage = null;

/** One chrome.storage area over a plain object, in the shape the service worker calls. */
function workerStorageArea(values) {
  return {
    async get(keys) {
      const names = keys === undefined || keys === null ? Object.keys(values) : [keys].flat();
      return Object.fromEntries(names.filter((name) => name in values).map((name) => [name, values[name]]));
    },
    async set(update) { Object.assign(values, update); },
    async remove(keys) { for (const name of [keys].flat()) delete values[name]; },
  };
}

/**
 * Disconnect Morrow as the extension runs it: connector/extension/src/service-worker.js is loaded
 * against the Chrome APIs it uses, then sent the popup's own morrow_disconnect message. Chrome keeps
 * the optional HTTPS permission here, so what the settings page reads next depends only on the state
 * the disconnect left. The worker loads with nothing saved and opens no bridge socket; `connected`
 * is then written to the same storage area a real connection uses. Returns the worker's answer and
 * what it left in chrome.storage.local.
 */
async function disconnectMorrow(connected) {
  const extensionId = "a".repeat(32);
  const event = () => ({ addListener() {} });
  const local = {};
  const pageChrome = globalThis.chrome;
  globalThis.chrome = {
    runtime: {
      id: extensionId,
      getManifest: () => manifest,
      getURL: (path) => `chrome-extension://${extensionId}/${path}`,
      onMessage: { addListener: (listener) => { serviceWorkerMessage = listener; } },
      onStartup: event(), onInstalled: event(),
    },
    management: { getSelf: async () => ({ id: extensionId, version: manifest.version, installType: "development" }) },
    storage: { local: workerStorageArea(local), session: workerStorageArea({}), onChanged: event() },
    permissions: {
      contains: async () => true,
      getAll: async () => ({ origins: manifest.optional_host_permissions }),
      // Chrome keeps the optional permission, which is the case a left-behind opt-in would read as on.
      remove: async () => false,
      onAdded: event(), onRemoved: event(),
    },
    alarms: { clear: async () => true, onAlarm: event() },
    tabs: { query: async () => [], onRemoved: event(), onUpdated: event() },
  };
  try {
    await import(new URL("connector/extension/src/service-worker.js", root));
    for (let turn = 0; turn < 6; turn += 1) await new Promise((resolve) => { setTimeout(resolve, 0); });
    assert.ok(serviceWorkerMessage, "the service worker registered no message listener");
    Object.assign(local, connected);
    const answer = await new Promise((resolve, reject) => {
      if (serviceWorkerMessage({ type: "morrow_disconnect" }, {}, resolve) !== true) reject(new Error("the worker never answered morrow_disconnect"));
    });
    return { answer, local };
  } finally {
    if (pageChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = pageChrome;
  }
}

test("after Disconnect Morrow course file access reads off, even when Chrome keeps the HTTPS permission", async () => {
  const { answer, local } = await disconnectMorrow({
    [COURSE_FILE_ACCESS_KEY]: true, token: "bridge-token", bindings: [ANATOMY],
    siteAnchors: [], editPolicies: {}, editPolicyRevisions: {}, firstCourseRead: Date.now(),
  });
  assert.deepEqual(answer, { ok: true, result: { disconnected: true, permissionsRevoked: false } });

  const page = await openSettings({ status: () => statusFixture([]), storage: local, permission: { granted: true } });
  assert.equal(page.text("#file-storage-status"), "Off. Chrome has HTTPS access, but Morrow course file access stays off.");
  assert.equal(page.text("#enable-file-storage"), "Turn on course file access");
  assert.equal(page.hidden("#enable-file-storage"), false);
  // The page corrected nothing: the disconnect left the opt-in off on its own.
  for (const saved of [page.storage, local]) {
    assert.equal(saved[COURSE_FILE_ACCESS_KEY], undefined);
    assert.equal(saved.token, undefined);
    assert.equal(saved.pairing, undefined);
    assert.match(saved.pairingAuthority.generation, /^[0-9a-f-]{36}$/u);
    assert.equal(saved.pairingAuthority.schema, "morrow.bridge-pairing-authority.v1");
    assert.equal(saved.pairingAuthority.status, "disconnected");
    assert.equal(Number.isSafeInteger(saved.pairingAuthority.changedAt), true);
  }
});
