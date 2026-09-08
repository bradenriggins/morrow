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
  assert.equal(page.text("#course-list"), "No connected courses are available. Choose a signed-in site above to find courses you can connect.");
  assert.equal(page.query("#course-list").getAttribute("aria-busy"), "false");
  assert.equal(page.text("#site-anchor-details"), "No signed-in course site is available. Open one course from a site in Chrome, then refresh this page.");
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
  assert.equal(page.text("#course-list"), "No connected courses are available. Choose a signed-in site above to find courses you can connect.");
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
  assert.deepEqual(listedCourses(page), ["Select Genetics", "Select Immunology"]);
  assert.equal(page.text("#page-status"), "Showing 7–8 of 8 matching connected courses. Page 2 of 2.");
  assert.equal(page.query("#next-page").disabled, true);

  await page.type("#course-filter", "phys");
  assert.deepEqual(listedCourses(page), ["Select Physiology"]);
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
  assert.equal(page.text("#category-list"), "Open every selected course site in Chrome, then refresh this page before you choose Edit.");
  assert.equal(page.text("#edit-stage-hint"), "Open every selected course site in Chrome, then refresh this page before you choose Edit.");
  assert.equal(page.text("#action-help"), "Open every selected course site in Chrome, then refresh this page before you choose Edit.");
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
  assert.equal(page.text("#category-list"), "Open every selected course site in Chrome, then refresh this page before you choose Edit.");
  assert.equal(page.text(".permission-state"), "Course tab needed");
});

test("an action published for review only carries its reason and no Edit control", async () => {
  const page = await openEditStage([CHECKED_ACTION, REVIEW_ONLY_ACTION]);
  const reviewOnly = page.queryAll("#category-list .category-option").find((option) => option.classList.contains("review-only"));
  assert.equal(reviewOnly.querySelector("strong").textContent, `Review only — ${REVIEW_ONLY_ACTION.label}`);
  assert.equal(reviewOnly.querySelector("small").textContent, `${REVIEW_ONLY_ACTION.description} ${REVIEW_ONLY_ACTION.reviewReason}`);
  assert.equal(reviewOnly.querySelector("input"), null);
  assert.equal(page.queryAll(`#category-list input[value="${REVIEW_ONLY_ACTION.id}"]`).length, 0);
  assert.equal(actionInput(page, CHECKED_ACTION.id).disabled, false);
});

test("the action search and the checked-only filter change which actions a person can choose", async () => {
  const page = await openEditStage([CHECKED_ACTION, UNCHECKED_ACTION, REVIEW_ONLY_ACTION]);
  assert.deepEqual(listedActions(page).sort(),
    [`Review only — ${REVIEW_ONLY_ACTION.label}`, UNCHECKED_ACTION.label, CHECKED_ACTION.label].sort());

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
  assert.equal(page.text("#save-confirmation-detail"),
    "1 selected action removes course content: Delete page."
    + " Morrow cannot check the saved result for 1 selected action: Add course to favorites. Morrow reports those results as unconfirmed."
    + " Save Edit access anyway, or keep reviewing to change the selection.");
  assert.deepEqual(page.messages("morrow_edit_policy_save"), []);

  await page.click("#cancel-save");
  assert.equal(page.hidden("#save-confirmation"), true);
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

test("a state the page cannot read is named as itself, with the next action", async () => {
  const page = await openSettings({
    status: () => ({ ok: false, code: "bridge_extension_unreachable", error: "bridge_extension_unreachable" }),
  });
  assert.equal(page.hidden("#error"), false);
  assert.equal(page.text("#error"), problemText("bridge_extension_unreachable"));

  const unreadable = await openSettings({ status: () => ({ bindings: [], editDurations: "hourly" }) });
  assert.equal(unreadable.text("#error"), problemText("edit_policy_status_unreadable"));
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
  assert.deepEqual(page.storage, {});
  assert.deepEqual(local, {});
});
