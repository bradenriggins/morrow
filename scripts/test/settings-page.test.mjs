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
const EDIT_DURATIONS = [{ value: 15 * 60 * 1_000, label: "15 minutes" }, { value: ONE_HOUR_MS, label: "1 hour" }, { value: 4 * ONE_HOUR_MS, label: "4 hours" }];

const CHECKED_ACTION = Object.freeze({ id: "canvas_page_content", group: "Focused Canvas repairs", label: "Page content", description: "Rewrite reviewed page content.", availability: "edit", destructive: false, verification: "checked" });
const UNCHECKED_ACTION = Object.freeze({ id: "action:canvas:canvas_add_course_to_favorites", group: "Canvas actions", label: "Add course to favorites", description: "Mark a course as a favorite.", availability: "edit", destructive: false, verification: "unchecked", verificationReason: "Morrow cannot check this change after it is saved: the route returns no saved record. Morrow reports the saved result as unconfirmed." });
const DESTRUCTIVE_ACTION = Object.freeze({ id: "action:canvas:canvas_delete_page", group: "Canvas actions", label: "Delete page", description: "Remove one page from a course.", availability: "edit", destructive: true, verification: "checked" });
const REVIEW_ONLY_ACTION = Object.freeze({ id: "action:canvas:canvas_update_quiz_item", group: "Canvas actions", label: "Update New Quiz item", description: "Change one New Quiz question.", availability: "review", destructive: false, reviewReason: "New Quizzes matches the parts of a question by id, so this change needs the delete-then-add contract." });
// F10, WI-3.4: a generated option with more than 8 changeable fields is published with
// allowedChangedFields: [], so a checkbox on it alone grants nothing. `canvas_edit_assignment` is a
// real key of settings.js's FIELD_SELECTION_BUNDLES table; `canvas_update_wide_thing` is not, so it
// proves the other branch of the message.
const FIELD_SELECTION_BUNDLE = Object.freeze({ id: "canvas_assignment_text", group: "Canvas task bundles", label: "Edit assignment titles and instructions", description: "Change an assignment's title or instructions.", availability: "edit", destructive: false, verification: "checked", routine: true, rememberable: true });
const FIELD_SELECTION_WITH_BUNDLE = Object.freeze({ id: "action:canvas:canvas_edit_assignment", group: "Canvas actions", label: "Edit an assignment", description: "Change an existing Canvas Assignment.", availability: "edit", destructive: false, verification: "checked", requiresFieldSelection: true });
const FIELD_SELECTION_NO_BUNDLE = Object.freeze({ id: "action:canvas:canvas_update_wide_thing", group: "Canvas actions", label: "Update a wide thing", description: "Change many settings at once.", availability: "edit", destructive: false, verification: "checked", requiresFieldSelection: true });

function canvasCourse(id, courseName, fields = {}) {
  return {
    sourceBindingId: `canvas:course-${id}`, provider: "canvas", origin: "https://canvas.example.edu",
    siteUrl: "https://canvas.example.edu", principalId: "teacher@example.edu", courseId: String(id),
    courseName, runtimeVerified: true, editPolicyRevision: 0, ...fields,
  };
}

const ANATOMY = canvasCourse(1, "Anatomy");
const PHYSIOLOGY = canvasCourse(2, "Physiology");

function statusFixture(bindings, fields = {}) {
  return { bindings, editDurations: EDIT_DURATIONS, catalogDigest: CATALOG_DIGEST, siteAnchors: [], bindingLimit: 500, ...fields };
}

function optionsFixture(sourceBindingId, options, fields = {}) {
  return { schema: "morrow.bridge.edit-options.v1", sourceBindingId, provider: "canvas", catalogDigest: CATALOG_DIGEST, policyRevision: 0, runtimeVerified: true, options, ...fields };
}

function editPermissionSummary(sourceBindingId, expiresAt, fields = {}) {
  return { schema: "morrow.bridge.edit-permission.v1", sourceBindingId, revision: 1, scopeDigest: SCOPE_DIGEST, catalogDigest: CATALOG_DIGEST, expiresAt, ...fields };
}

/** The date form the page writes for a temporary Edit access that ends. */
function expiryLabel(expiresAt) {
  return new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(expiresAt);
}

/** Loads Plan and Edit settings with the answers the service worker would give. */
async function openSettings({ status, options = () => null, handlers = {}, ...rest } = {}) {
  return await loadExtensionPage("settings/settings.html", {
    handlers: {
      morrow_edit_policy_status: () => status(),
      morrow_edit_policy_options: ({ sourceBindingId }) => options(sourceBindingId),
      morrow_edit_policy_save: ({ sourceBindingId, enabledCategories, expiresInMs }) => ({
        editPermission: { ...editPermissionSummary(sourceBindingId, Date.now() + expiresInMs), enabledCategories },
      }),
      morrow_edit_policy_revoke: () => ({ revoked: true }),
      ...handlers,
    },
    ...rest,
  });
}

const listedCourses = (page) => page.queryAll(".course-card .course-select").map((input) => input.getAttribute("aria-label"));
const listedActions = (page) => page.queryAll("#category-list .category-option").map((option) => option.querySelector("strong").textContent);
const actionInput = (page, id) => page.query(`#category-list input[value="${id}"]`);

/** Selects one connected course and waits for the actions the page then reads. */
async function selectCourse(page, sourceBindingId) {
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
  assert.equal(page.text("#site-anchor-details"), "No signed-in Canvas or Moodle course is available. Open one course in Chrome, then refresh this page.");
  assert.equal(page.query("#site-anchor").disabled, true);
  assert.equal(page.query("#discover-courses").disabled, true);
  assert.equal(page.text("#selection-summary"), "No course selected. Select a course above, then choose Plan or Edit.");
  assert.equal(page.text("#visible-scope"), "No courses in this view.");
  assert.equal(page.query("#select-visible").disabled, true);
  assert.equal(page.hidden("#permission-actions"), true);
  assert.equal(page.hidden("#course-pages"), true);
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
  assert.equal(page.query(`[data-binding-id="${ANATOMY.sourceBindingId}"] .course-select`).disabled, false);
  await page.click(`[data-binding-id="${ANATOMY.sourceBindingId}"] .course-select`);
  assert.equal(page.query("#mode-edit").disabled, true);
  assert.equal(page.query("#return-plan").disabled, false);
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

test("a course search narrows the list, and the pages move through the courses that match", async () => {
  const courses = ["Anatomy", "Physiology", "Pharmacology", "Microbiology", "Nutrition", "Pathology", "Genetics", "Immunology"]
    .map((name, index) => canvasCourse(index + 1, name));
  const page = await openSettings({ status: () => statusFixture(courses) });
  assert.equal(page.queryAll(".course-card").length, 6);
  assert.equal(page.text("#page-status"), "Showing 1–6 of 8 matching connected courses. Page 1 of 2.");
  assert.equal(page.hidden("#course-pages"), false);
  assert.equal(page.query("#previous-page").disabled, true);
  assert.equal(page.text("#announcement"), "8 connected courses, page 1 of 2.");

  await page.click("#next-page");
  assert.deepEqual(listedCourses(page), [
    "Select Canvas course Genetics (course ID 7) at https://canvas.example.edu for teacher@example.edu",
    "Select Canvas course Immunology (course ID 8) at https://canvas.example.edu for teacher@example.edu",
  ]);
  assert.equal(page.text("#page-status"), "Showing 7–8 of 8 matching connected courses. Page 2 of 2.");
  assert.equal(page.query("#next-page").disabled, true);

  await page.type("#course-filter", "phys");
  assert.deepEqual(listedCourses(page), [
    "Select Canvas course Physiology (course ID 2) at https://canvas.example.edu for teacher@example.edu",
  ]);
  assert.equal(page.text("#page-status"), "Showing 1–1 of 1 matching connected course. Page 1 of 1.");
  assert.equal(page.hidden("#course-pages"), true);
  assert.equal(page.text("#announcement"), "Search matches 1 connected course.");

  await page.type("#course-filter", "astronomy");
  assert.equal(page.queryAll(".course-card").length, 0);
  assert.equal(page.text("#course-list"), "No connected course matches this search. Clear the search to view every course in this list.");

  await page.type("#course-filter", "");
  assert.equal(page.queryAll(".course-card").length, 6);
});

test("Select this page selects every course a person can see, and clears the same courses", async () => {
  const courses = Array.from({ length: 8 }, (unused, index) => canvasCourse(index + 1, `Course ${index + 1}`));
  const page = await openSettings({
    status: () => statusFixture(courses),
    options: (sourceBindingId) => optionsFixture(sourceBindingId, [CHECKED_ACTION]),
  });
  assert.equal(page.text("#visible-scope"), "0 courses selected on this page. 0 courses selected total.");
  assert.equal(page.text("#select-visible"), "Select this page");

  await page.click("#select-visible");
  assert.equal(page.text("#visible-scope"), "6 courses selected on this page. 6 courses selected total.");
  assert.equal(page.text("#select-visible"), "Clear this page");
  assert.equal(page.text("#selection-summary"), "6 courses selected. Plan keeps changes ready for your review.");
  assert.equal(page.text("#return-plan"), "Return 6 selected courses to Plan");

  await page.click("#next-page");
  assert.equal(page.text("#visible-scope"), "0 courses selected on this page. 6 courses selected total.");
  assert.equal(page.text("#select-visible"), "Select this page");

  await page.click("#previous-page");
  await page.click("#select-visible");
  assert.equal(page.text("#visible-scope"), "0 courses selected on this page. 0 courses selected total.");
  assert.equal(page.text("#selection-summary"), "No course selected. Select a course above, then choose Plan or Edit.");
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
  assert.deepEqual(listedActions(page), [CHECKED_ACTION.label]);
});

test("a selected course without a verified open site stays available for Plan recovery only", async () => {
  const stale = { ...ANATOMY, runtimeVerified: false, editPermission: editPermissionSummary(ANATOMY.sourceBindingId, Date.now() + ONE_HOUR_MS) };
  const page = await openSettings({
    status: () => statusFixture([stale]),
    options: (sourceBindingId) => optionsFixture(sourceBindingId, [CHECKED_ACTION], { runtimeVerified: false }),
  });
  await page.click(`[data-binding-id="${stale.sourceBindingId}"] .course-select`);
  assert.deepEqual(page.messages("morrow_edit_policy_options"), []);
  assert.equal(page.query("#mode-edit").disabled, true);
  assert.equal(page.query("#return-plan").disabled, false);
  assert.equal(page.text("#category-list"), "Open each selected course in Canvas or Moodle, then refresh this page before you choose Edit.");
  assert.equal(page.text("#edit-stage-hint"), "Open each selected course in Canvas or Moodle, then refresh this page before you choose Edit.");
  assert.equal(page.text("#action-help"), "Open each selected course in Canvas or Moodle, then refresh this page before you choose Edit.");
});

test("an options response that is not runtime verified moves the course to site recovery", async () => {
  const page = await openSettings({
    status: () => statusFixture([ANATOMY]),
    options: (sourceBindingId) => optionsFixture(sourceBindingId, [CHECKED_ACTION], { runtimeVerified: false }),
  });
  await page.click(`[data-binding-id="${ANATOMY.sourceBindingId}"] .course-select`);
  await page.waitFor(() => page.messages("morrow_edit_policy_options").length === 1 && !page.text("#category-list").includes("Reading the current individual actions"),
    "the unverified options response did not settle");
  assert.equal(page.query("#mode-edit").disabled, true);
  assert.deepEqual(listedActions(page), []);
  assert.equal(page.hidden("#error"), true);
  assert.equal(page.text("#category-list"), "Open each selected course in Canvas or Moodle, then refresh this page before you choose Edit.");
  // WI-1.1 pin: "Course tab needed" became "Canvas is closed".
  assert.equal(page.text(".permission-state"), "Canvas is closed");
});

test("a closed course card offers its own Open Canvas action, targeted at that exact course", async () => {
  const opened = [];
  const closed = { ...ANATOMY, runtimeVerified: false, siteAnchorId: "canvas:site-1" };
  const page = await openSettings({
    status: () => statusFixture([closed]),
    handlers: {
      morrow_open_platform: (fields) => { opened.push(fields); return { opened: true, verified: true }; },
    },
  });
  assert.equal(page.text(".permission-state"), "Canvas is closed");
  assert.equal(page.query(".card-note").textContent, "Morrow Bridge can open it for you.");
  assert.equal(page.text(`[data-open-platform="${closed.sourceBindingId}"]`), "Open Canvas");

  await page.click(`[data-open-platform="${closed.sourceBindingId}"]`);
  assert.deepEqual(opened, [{ type: "morrow_open_platform", siteAnchorId: "canvas:site-1", sourceBindingId: closed.sourceBindingId }]);
  assert.equal(page.hidden("#error"), true);
});

test("WI-1.5: a selected closed course keeps the remains-selected sentence, an unselected one does not", async () => {
  const closed = { ...ANATOMY, runtimeVerified: false, siteAnchorId: "canvas:site-1" };
  const page = await openSettings({ status: () => statusFixture([closed]) });
  assert.equal(page.query(".card-note").textContent, "Morrow Bridge can open it for you.");
  await page.click(`[data-binding-id="${closed.sourceBindingId}"] .course-select`);
  assert.equal(page.query(".card-note").textContent, "This course remains selected, but its site is closed. Morrow Bridge can open it for you.");
});

test("a closed course's Open Canvas shows a sign-in notice when the reopened site is still unverified", async () => {
  const closed = { ...ANATOMY, runtimeVerified: false, siteAnchorId: "canvas:site-1" };
  const page = await openSettings({
    status: () => statusFixture([closed]),
    handlers: { morrow_open_platform: () => ({ opened: true, verified: false }) },
  });
  await page.click(`[data-open-platform="${closed.sourceBindingId}"]`);
  assert.equal(page.hidden("#notice"), false);
  assert.equal(page.text("#notice"), "Sign in to Canvas in the tab that opened. Morrow continues after that.");
});

test("an action published for review only carries its reason and no Edit control", async () => {
  const page = await openEditStage([CHECKED_ACTION, REVIEW_ONLY_ACTION]);
  const reviewOnly = page.queryAll("#category-list .category-option").find((option) => option.classList.contains("review-only"));
  assert.equal(reviewOnly.querySelector("strong").textContent, `Review only: ${REVIEW_ONLY_ACTION.label}`);
  assert.equal(reviewOnly.querySelector("small").textContent, `${REVIEW_ONLY_ACTION.description} ${REVIEW_ONLY_ACTION.reviewReason}`);
  assert.equal(reviewOnly.querySelector("input"), null);
  assert.equal(page.queryAll(`#category-list input[value="${REVIEW_ONLY_ACTION.id}"]`).length, 0);
  assert.equal(actionInput(page, CHECKED_ACTION.id).disabled, false);
});

// F10, WI-3.4: an option that would grant nothing (allowedChangedFields: []) never gets an active
// checkbox. It names the bundle that covers its tool when one is offered, else it says Morrow
// always asks first.
test("an option that grants nothing alone gets no checkbox, and names the covering bundle, or says Morrow always asks first", async () => {
  const page = await openEditStage([CHECKED_ACTION, FIELD_SELECTION_BUNDLE, FIELD_SELECTION_WITH_BUNDLE, FIELD_SELECTION_NO_BUNDLE]);
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
  const bundleCategories = visible.map((spec) => ({
    id: spec.id, group: spec.group, label: spec.label, description: spec.description,
    availability: "edit", destructive: false, verification: "checked",
  }));
  const toolLabel = (toolName) => `Field-capped: ${toolName}`;
  const toolActions = [...bundleIdsByTool.keys()].map((toolName) => ({
    id: `action:${toolName.startsWith("moodle_") ? "moodle" : "canvas"}:${toolName}`,
    group: "Field-capped actions", label: toolLabel(toolName), description: `${toolName} description.`,
    availability: "edit", destructive: false, verification: "checked", requiresFieldSelection: true,
  }));

  const page = await openEditStage([...bundleCategories, ...toolActions], [ANATOMY]);
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

test("the action search and the checked-only filter change which actions a person can choose", async () => {
  const page = await openEditStage([CHECKED_ACTION, UNCHECKED_ACTION, REVIEW_ONLY_ACTION]);
  assert.deepEqual(listedActions(page).sort(),
    [`Review only: ${REVIEW_ONLY_ACTION.label}`, UNCHECKED_ACTION.label, CHECKED_ACTION.label].sort());

  await page.type("#action-filter", "favorite");
  assert.deepEqual(listedActions(page), [UNCHECKED_ACTION.label]);

  await page.type("#action-filter", "shibboleth");
  assert.equal(page.text("#category-list"), "No individual action matches this search.");

  await page.type("#action-filter", "");
  await page.click("#action-checked-only");
  assert.deepEqual(listedActions(page), [CHECKED_ACTION.label]);

  await page.click("#action-checked-only");
  assert.equal(listedActions(page).includes(UNCHECKED_ACTION.label), true);
});

test("Edit access defaults to one hour and saves one exact request for each selected course", async () => {
  const page = await openEditStage([CHECKED_ACTION]);
  assert.deepEqual(page.query("#edit-duration").options.map((option) => [option.value, option.text]),
    [["900000", "15 minutes"], ["3600000", "1 hour"], ["14400000", "4 hours"]]);
  assert.equal(page.query("#edit-duration").value, String(ONE_HOUR_MS));

  await selectCourse(page, PHYSIOLOGY.sourceBindingId);
  await page.click(`#category-list input[value="${CHECKED_ACTION.id}"]`);
  assert.equal(page.text("#selection-summary"), "2 courses selected. Morrow can make: Page content.");
  await page.choose("#edit-duration", String(4 * ONE_HOUR_MS));
  assert.equal(page.text("#action-help"), "Morrow can apply only the checked actions in these courses for 4 hours. Save again if available actions change.");

  await page.click("#save-edit");
  await page.waitFor(() => page.messages("morrow_edit_policy_save").length === 2, "the page never saved Edit access for both courses");
  assert.deepEqual(page.messages("morrow_edit_policy_save"), [
    { type: "morrow_edit_policy_save", sourceBindingId: ANATOMY.sourceBindingId, enabledCategories: [CHECKED_ACTION.id], expiresInMs: 4 * ONE_HOUR_MS },
    { type: "morrow_edit_policy_save", sourceBindingId: PHYSIOLOGY.sourceBindingId, enabledCategories: [CHECKED_ACTION.id], expiresInMs: 4 * ONE_HOUR_MS },
  ]);
  assert.match(page.text("#notice"), /^Edit access saved for 2 courses\. Allowed actions: Page content\. It ends /);
});

test("the save notice caps the list of allowed actions at six, then counts the rest", async () => {
  const manyActions = Array.from({ length: 8 }, (_, index) => ({
    id: `canvas_action_${index + 1}`, group: "Focused Canvas repairs", label: `Action ${index + 1}`,
    description: `Action ${index + 1} description.`, availability: "edit", destructive: false, verification: "checked",
  }));
  const page = await openEditStage(manyActions, [ANATOMY]);
  for (const action of manyActions) {
    await page.click(`#category-list input[value="${action.id}"]`);
  }
  await page.click("#save-edit");
  await page.waitFor(() => page.messages("morrow_edit_policy_save").length === 1, "the page never saved Edit access");
  assert.match(page.text("#notice"),
    /^Edit access saved for 1 course\. Allowed actions: Action 1, Action 2, Action 3, Action 4, Action 5, Action 6, and 2 more actions\. It ends /);
});

test("saving Edit access for several courses shows progress only once the wait runs long enough to need it", async () => {
  const releases = [];
  const page = await openSettings({
    status: () => statusFixture([ANATOMY, PHYSIOLOGY]),
    options: (sourceBindingId) => optionsFixture(sourceBindingId, [CHECKED_ACTION]),
    handlers: {
      morrow_edit_policy_save: ({ sourceBindingId, enabledCategories, expiresInMs }) => new Promise((resolve) => {
        releases.push(() => resolve({ editPermission: { ...editPermissionSummary(sourceBindingId, Date.now() + expiresInMs), enabledCategories } }));
      }),
    },
  });
  await page.click("#select-visible");
  await page.click("#mode-edit");
  await page.click(`#category-list input[value="${CHECKED_ACTION.id}"]`);
  assert.equal(page.text("#save-edit"), "Save Edit access for 2 courses");

  await page.click("#save-edit");
  await page.waitFor(() => releases.length === 1, "the first course save never started");
  assert.equal(page.text("#save-edit"), "Save Edit access for 2 courses", "no progress yet: the wait has not run long enough to need it");
  await page.waitFor(() => page.text("#save-edit") === "Saving 1 of 2 courses", "no progress appeared once the save ran long enough to need it");

  releases[0]();
  await page.waitFor(() => releases.length === 2, "the second course save never started");
  await page.waitFor(() => page.text("#save-edit") === "Saving 2 of 2 courses", "progress never advanced to the second course");

  releases[1]();
  await page.waitFor(() => !page.hidden("#notice"), "the save never finished");
  assert.match(page.text("#notice"), /^Edit access saved for 2 courses\./);
  // The progress text is gone: the button reads its ordinary label again, not the last progress line.
  assert.equal(page.text("#save-edit"), "Save Edit access for 2 courses");
});

test("an action Morrow cannot check, or one that removes content, is confirmed by name before it is saved", async () => {
  const page = await openEditStage([CHECKED_ACTION, UNCHECKED_ACTION, DESTRUCTIVE_ACTION]);
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

test("a saved Edit access names its actions and the moment it ends; an ended one is stated as ended", async () => {
  const expiresAt = Date.now() + ONE_HOUR_MS;
  const permitted = canvasCourse(1, "Anatomy", { editPermission: editPermissionSummary("canvas:course-1", expiresAt) });
  const ended = canvasCourse(2, "Physiology", { editPermission: editPermissionSummary("canvas:course-2", Date.now() - 1_000) });
  const page = await openSettings({
    status: () => statusFixture([permitted, ended]),
    options: (sourceBindingId) => optionsFixture(sourceBindingId, [CHECKED_ACTION], {
      editPermission: { ...editPermissionSummary(sourceBindingId, expiresAt), enabledCategories: [CHECKED_ACTION.id] },
    }),
  });
  const card = (sourceBindingId) => page.query(`[data-binding-id="${sourceBindingId}"]`);
  // Until a course is selected the page has not read its actions, and it says only that Edit is on.
  assert.equal(card("canvas:course-1").querySelector(".permission-state").textContent, "Edit active");
  assert.equal(card("canvas:course-1").querySelector(".card-note").textContent,
    "Edit access is active. Select this course to read its exact allowed actions.");
  assert.equal(card("canvas:course-2").querySelector(".permission-state").textContent, "Edit expired");
  assert.equal(card("canvas:course-2").querySelector(".card-note").textContent,
    "This temporary Edit access has ended. The course is back in Plan. Ask Morrow for Edit access again if you still need it.");

  await selectCourse(page, "canvas:course-1");
  assert.equal(card("canvas:course-1").querySelector(".permission-state").textContent, "Edit: 1 type");
  assert.equal(card("canvas:course-1").querySelector(".card-note").textContent,
    `Allowed actions: Page content. This temporary access ends ${expiryLabel(expiresAt)}. Other changes stay in review.`);
});

test("a course whose available actions changed is paused until it is saved again", async () => {
  const stale = canvasCourse(1, "Anatomy", {
    staleEditPermission: editPermissionSummary("canvas:course-1", Date.now() + ONE_HOUR_MS, { catalogDigest: "a".repeat(64) }),
  });
  const page = await openSettings({ status: () => statusFixture([stale]) });
  const card = page.query('[data-binding-id="canvas:course-1"]');
  assert.equal(card.querySelector(".permission-state").textContent, "Save again");
  assert.equal(card.querySelector(".card-note").textContent,
    "Available actions changed. Edit is paused until you review and save the selected actions again.");
  assert.equal(card.querySelector(".permission-state").classList.contains("stale"), true);
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
  const expiresAt = Date.now() + ONE_HOUR_MS;
  let editingPermission = { ...editPermissionSummary("canvas:course-1", expiresAt), enabledCategories: [CHECKED_ACTION.id] };
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

test("the banner counts every connection that can act with no review, and ignores an ended one", async () => {
  const expiresAt = Date.now() + ONE_HOUR_MS;
  const first = canvasCourse(1, "Anatomy", { editPermission: { ...editPermissionSummary("canvas:course-1", expiresAt), enabledCategories: [CHECKED_ACTION.id] } });
  const second = canvasCourse(2, "Physiology", { editPermission: { ...editPermissionSummary("canvas:course-2", expiresAt), enabledCategories: [CHECKED_ACTION.id] } });
  const ended = canvasCourse(3, "Genetics", { editPermission: { ...editPermissionSummary("canvas:course-3", Date.now() - 1_000), enabledCategories: [CHECKED_ACTION.id] } });
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
  assert.equal(page.text("#site-anchor-details"), "Connected courses were not checked. Select Refresh connected courses.");
  assert.equal(page.text("#course-list"), "Connected courses were not checked. Select Refresh connected courses.");
  assert.equal(page.text("#selection-summary"), "Course access was not checked. Select Refresh connected courses.");
  assert.equal(page.query("#refresh").disabled, false);

  const unreadable = await openSettings({ status: () => ({ bindings: [], editDurations: "hourly" }) });
  assert.equal(unreadable.text("#error"), problemText("edit_policy_status_unreadable"));
  assert.equal(unreadable.text("#connection-status"), "Connected courses were not checked.");
});

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
  let savedCourseIds = null;
  const page = await openSettings({
    status: () => statusFixture([], { siteAnchors: [site] }),
    handlers: {
      morrow_course_discovery_start: () => discovery,
      morrow_course_selection_save: ({ siteAnchorId, courseIds }) => {
        savedCourseIds = courseIds;
        return {
          siteAnchorId,
          bindings: courseIds.map((courseId) => ({ provider: "canvas", courseId })),
        };
      },
    },
  });
  await page.click("#discover-courses");
  await page.waitFor(() => page.queryAll(".available-course-select").length === 2, "the available Canvas courses did not render");
  assert.deepEqual(
    page.queryAll(".available-course-select").map((input) => input.getAttribute("aria-label")),
    [
      "Select Canvas course Small ID (course ID 42) at https://canvas.example.edu for teacher@example.edu to connect",
      "Select Canvas course 64-bit ID (course ID 9007199254740993) at https://canvas.example.edu for teacher@example.edu to connect",
    ],
  );
  await page.click('[data-course-id="42"] .available-course-select');
  await page.click('[data-course-id="9007199254740993"] .available-course-select');
  await page.click("#connect-selected");
  await page.waitFor(() => savedCourseIds !== null, "the selected Canvas courses were not sent");
  assert.deepEqual(savedCourseIds, ["42", "9007199254740993"]);
  assert.equal(savedCourseIds.every((courseId) => typeof courseId === "string"), true);
  assert.equal(page.hidden("#error"), true);

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
  await malformed.click("#discover-courses");
  await malformed.waitFor(() => !malformed.hidden("#error"), "the malformed Canvas course ID was not refused");
  assert.equal(malformed.text("#error"), problemText("course_discovery_failed"));
  assert.equal(malformed.queryAll(".available-course-select").length, 0);
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
