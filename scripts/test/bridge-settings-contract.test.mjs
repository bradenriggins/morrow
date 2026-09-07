import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after } from "node:test";
import { canvasAdmissionReason, canvasOperationAdmission, canvasReadbackAssessment } from "../../connector/extension/generated/canvas-operation-admission.js";
import { categoriesForBinding, changedFields, createEditPermission, guardedItemBankUpdate, validEditPermission } from "../../connector/extension/src/edit-policy.js";
import { PROBLEM_CODES, problemText } from "../../connector/extension/src/bridge-problem-copy.js";
import { courseValue, detailText, primaryLabel, statusValue } from "../../connector/extension/popup/popup-view.js";

const root = new URL("../../", import.meta.url);
const settingsHtml = readFileSync(new URL("connector/extension/settings/settings.html", root), "utf8");
const manifest = JSON.parse(readFileSync(new URL("connector/extension/manifest.json", root), "utf8"));

const ONE_HOUR_MS = 60 * 60 * 1_000;
const CATALOG_DIGEST = "c".repeat(64);
const COURSE_FILE_ACCESS_KEY = "courseFileStorageAccessEnabled";
const EDIT_DURATIONS = [{ value: 15 * 60 * 1_000, label: "15 minutes" }, { value: ONE_HOUR_MS, label: "1 hour" }, { value: 4 * ONE_HOUR_MS, label: "4 hours" }];

const CANVAS_COURSE = Object.freeze({ sourceBindingId: "canvas:course-1", provider: "canvas", origin: "https://canvas.example.edu", courseId: "1", courseName: "Anatomy", runtimeVerified: true, editPolicyRevision: 0 });
const SECOND_CANVAS_COURSE = Object.freeze({ ...CANVAS_COURSE, sourceBindingId: "canvas:course-2", courseId: "2", courseName: "Physiology" });
const CHECKED_ACTION = Object.freeze({ id: "canvas_page_content", group: "Focused Canvas repairs", label: "Page content", description: "Rewrite reviewed page content.", availability: "edit", destructive: false, verification: "checked" });
const UNCHECKED_ACTION = Object.freeze({ id: "action:canvas:canvas_add_course_to_favorites", group: "Canvas actions", label: "Add course to favorites", description: "Mark a course as a favorite.", availability: "edit", destructive: false, verification: "unchecked", verificationReason: "Morrow cannot check this change after it is saved: the route returns no saved record. Morrow reports the saved result as unconfirmed." });
const REVIEW_ONLY_ACTION = Object.freeze({ id: "action:canvas:canvas_update_quiz_item", group: "Canvas actions", label: "Update New Quiz item", description: "Change one New Quiz question.", availability: "review", destructive: false, reviewReason: "New Quizzes matches the parts of a question by id, so this change needs the delete-then-add contract." });

function statusFixture(bindings) {
  return { bindings, editDurations: EDIT_DURATIONS, catalogDigest: CATALOG_DIGEST, siteAnchors: [] };
}

function optionsFixture(sourceBindingId, options) {
  return { schema: "morrow.bridge.edit-options.v1", sourceBindingId, provider: "canvas", catalogDigest: CATALOG_DIGEST, policyRevision: 0, runtimeVerified: true, options };
}

/** One settings-page element, carrying only the surface settings.js uses. */
function stubElement() {
  return {
    attributes: {}, listeners: {}, textContent: "", innerHTML: "", value: "",
    options: [], selectedIndex: 0, hidden: false, disabled: false, checked: false,
    setAttribute(name, value) { this.attributes[name] = String(value); },
    removeAttribute(name) { delete this.attributes[name]; },
    addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); },
    /** Runs the handlers the page registered, the way a real event does. */
    dispatch(type, event) { for (const handler of this.listeners[type] || []) handler(event); },
    focus() {}, querySelector: () => null,
  };
}

/** The class settings.js checks before it reads a checkbox out of an event. */
class StubInput {
  constructor(fields) { Object.assign(this, fields); }
}

let settingsLoads = 0;

/**
 * Runs connector/extension/settings/settings.js against a stub of the browser globals the page
 * uses, so every settings check below drives the shipped page instead of reading its source.
 * Each call loads a separate module instance, because the page reads its status once as it loads.
 */
async function loadSettings({ status, options = () => null, filePermission = false, stored = {} }) {
  const nodes = new Map();
  const node = (selector) => {
    if (!nodes.has(selector)) nodes.set(selector, stubElement());
    return nodes.get(selector);
  };
  const requests = [];
  const permissionCalls = [];
  const storage = { ...stored };
  let granted = filePermission;
  globalThis.document = { activeElement: null, querySelector: node, addEventListener() {} };
  globalThis.HTMLInputElement = StubInput;
  globalThis.Element = class Element {};
  globalThis.chrome = {
    runtime: {
      sendMessage: async (message) => {
        requests.push(message);
        if (message.type === "morrow_edit_policy_status") return { ok: true, result: status() };
        if (message.type === "morrow_edit_policy_options") return { ok: true, result: options(message.sourceBindingId) };
        if (message.type === "morrow_edit_policy_save") {
          return { ok: true, result: { editPermission: { enabledCategories: message.enabledCategories, expiresAt: Date.now() + message.expiresInMs, revision: 1, scopeDigest: "d".repeat(64) } } };
        }
        return { ok: false, error: `The test harness received no ${message.type} request.` };
      },
    },
    storage: {
      local: {
        get: async (key) => (key in storage ? { [key]: storage[key] } : {}),
        set: async (values) => { Object.assign(storage, values); },
      },
      onChanged: { addListener() {} },
    },
    permissions: {
      contains: async () => granted,
      request: async ({ origins }) => { permissionCalls.push({ method: "request", origins }); granted = true; return true; },
      remove: async ({ origins }) => { permissionCalls.push({ method: "remove", origins }); granted = false; return true; },
      onAdded: { addListener() {} },
      onRemoved: { addListener() {} },
    },
  };
  settingsLoads += 1;
  await import(new URL(`connector/extension/settings/settings.js?load=${settingsLoads}`, root));
  return { node, permissionCalls, storage, sent: (type) => requests.filter((request) => request.type === type) };
}

// The settings page reads these globals while a test drives it, so they are removed once every
// test in this file has run, not between loads.
after(() => {
  delete globalThis.document;
  delete globalThis.HTMLInputElement;
  delete globalThis.Element;
  delete globalThis.chrome;
});

/** Waits for the asynchronous page work a load, a click, or a change event starts. */
async function settle(check, description) {
  for (let attempt = 0; attempt < 500 && !check(); attempt += 1) {
    await new Promise((resolve) => { setTimeout(resolve, 1); });
  }
  assert.ok(check(), description);
}

async function settleText(node, expected) {
  for (let attempt = 0; attempt < 500 && node.textContent !== expected; attempt += 1) {
    await new Promise((resolve) => { setTimeout(resolve, 1); });
  }
  assert.equal(node.textContent, expected);
}

/** Selects one connected course, the way a click on its course checkbox does. */
function selectCourse(page, sourceBindingId) {
  page.node("#course-list").dispatch("change", {
    target: new StubInput({
      checked: true,
      classList: { contains: (name) => name === "course-select" },
      closest: () => ({ dataset: { bindingId: sourceBindingId } }),
    }),
  });
}

/** Selects one individual action, the way a click on its action checkbox does. */
function selectAction(page, id) {
  page.node("#category-list").dispatch("change", { target: new StubInput({ type: "checkbox", checked: true, value: id }) });
}

/** Loads the page with one connected course selected, its actions read, and Edit chosen. */
async function openEditStage(actions) {
  const page = await loadSettings({
    status: () => statusFixture([CANVAS_COURSE, SECOND_CANVAS_COURSE]),
    options: (sourceBindingId) => optionsFixture(sourceBindingId, actions),
  });
  selectCourse(page, CANVAS_COURSE.sourceBindingId);
  await settle(() => page.node("#category-list").innerHTML.includes(actions[0].label),
    "the page never listed the individual actions for the selected course");
  page.node("#mode-edit").checked = true;
  page.node("#mode-edit").dispatch("change");
  return page;
}

test("the connected-course summary counts only runtime-verified eligible courses as ready", async () => {
  const unverified = { ...SECOND_CANVAS_COURSE, runtimeVerified: false };
  // A course Morrow can no longer identify: it holds no course id, name, site, or origin.
  const unidentified = { sourceBindingId: "canvas:course-3", provider: "canvas", runtimeVerified: true, editPolicyRevision: 0 };
  let bindings = [CANVAS_COURSE];
  const page = await loadSettings({ status: () => statusFixture(bindings) });
  const summary = page.node("#connection-status");
  await settleText(summary, "1 connected course is ready to use.");

  const reread = async (next, expected) => {
    bindings = next;
    page.node("#refresh").dispatch("click");
    await settleText(summary, expected);
  };
  await reread([CANVAS_COURSE, unverified],
    "1 connected course is ready to use. 1 saved course needs an open course tab or a reconnected site.");
  await reread([unidentified],
    "0 connected courses are ready to use. 1 saved course needs an open course tab or a reconnected site.");
  await reread([], "No course is connected yet.");
});

test("Plan and Edit reads the individual actions for a course only when that course is selected", async () => {
  const page = await loadSettings({
    status: () => statusFixture([CANVAS_COURSE, SECOND_CANVAS_COURSE]),
    options: (sourceBindingId) => optionsFixture(sourceBindingId, [CHECKED_ACTION]),
  });
  assert.deepEqual(page.sent("morrow_edit_policy_options"), []);
  assert.equal(page.node("#category-list").innerHTML, '<p class="state-message">Select a course to read its available Edit and Review-only actions.</p>');

  selectCourse(page, CANVAS_COURSE.sourceBindingId);
  await settle(() => page.sent("morrow_edit_policy_options").length > 0, "the page never read the actions for the selected course");
  assert.deepEqual(page.sent("morrow_edit_policy_options"),
    [{ type: "morrow_edit_policy_options", sourceBindingId: CANVAS_COURSE.sourceBindingId }]);
  await settle(() => page.node("#category-list").innerHTML.includes(CHECKED_ACTION.label), "the read actions were never listed");
});

test("an action published for review only carries its reason and no Edit control", async () => {
  const page = await openEditStage([CHECKED_ACTION, REVIEW_ONLY_ACTION]);
  const listed = page.node("#category-list").innerHTML;
  assert.match(listed, /<strong>Review only — Update New Quiz item<\/strong>/);
  assert.ok(listed.includes(REVIEW_ONLY_ACTION.reviewReason));
  assert.equal(listed.includes(`value="${REVIEW_ONLY_ACTION.id}"`), false);
  assert.ok(listed.includes(`value="${CHECKED_ACTION.id}"`));
});

test("Edit access defaults to one hour and saves the duration it shows", async () => {
  const page = await openEditStage([CHECKED_ACTION]);
  assert.equal(page.node("#edit-duration").innerHTML,
    '<option value="900000">15 minutes</option><option value="3600000">1 hour</option><option value="14400000">4 hours</option>');
  assert.equal(page.node("#edit-duration").value, String(ONE_HOUR_MS));

  selectAction(page, CHECKED_ACTION.id);
  page.node("#save-edit").dispatch("click");
  await settle(() => page.sent("morrow_edit_policy_save").length > 0, "the page never saved Edit access");
  assert.deepEqual(page.sent("morrow_edit_policy_save"), [{
    type: "morrow_edit_policy_save",
    sourceBindingId: CANVAS_COURSE.sourceBindingId,
    enabledCategories: [CHECKED_ACTION.id],
    expiresInMs: ONE_HOUR_MS,
  }]);
});

test("an action Morrow cannot check is confirmed by name before it is saved", async () => {
  const page = await openEditStage([CHECKED_ACTION, UNCHECKED_ACTION]);
  const listed = page.node("#category-list").innerHTML;
  assert.match(listed, /<span class="action-flag">Saved result not checked<\/span>/);
  assert.ok(listed.includes(UNCHECKED_ACTION.verificationReason));

  selectAction(page, UNCHECKED_ACTION.id);
  page.node("#save-edit").dispatch("click");
  await settle(() => page.node("#save-confirmation").hidden === false, "the page never asked to confirm the unchecked action");
  assert.equal(page.node("#save-confirmation-detail").textContent,
    "Morrow cannot check the saved result for 1 selected action: Add course to favorites. Morrow reports those results as unconfirmed. Save Edit access anyway, or keep reviewing to change the selection.");
  assert.deepEqual(page.sent("morrow_edit_policy_save"), []);

  page.node("#confirm-save").dispatch("click");
  await settle(() => page.sent("morrow_edit_policy_save").length > 0, "confirming never saved the Edit access");
  assert.deepEqual(page.sent("morrow_edit_policy_save")[0].enabledCategories, [UNCHECKED_ACTION.id]);
  await settle(() => page.node("#notice").textContent.startsWith("Edit access saved for 1 course."), "the saved access was never confirmed on the page");
  assert.match(page.node("#notice").textContent, /Allowed actions: Add course to favorites\./);
});

test("course file access remains an explicit optional HTTPS permission", async () => {
  // The manifest is the contract Chrome enforces: HTTPS access is optional, so Chrome asks the
  // person for it only when they turn course file access on.
  assert.deepEqual(manifest.optional_host_permissions, ["https://*/*"]);
  assert.equal(manifest.host_permissions.some((pattern) => pattern.startsWith("https:")), false);
  assert.equal(manifest.permissions.some((name) => name.includes("://")), false);
  // The page states that Morrow does not block or change requests. Chrome grants that power only
  // through the permissions below, and Morrow declares none of them. This checks the granted
  // power, not the behaviour of each listener.
  assert.deepEqual(manifest.permissions.filter((name) => ["declarativeNetRequest", "declarativeNetRequestWithHostAccess", "webRequestBlocking"].includes(name)), []);

  const page = await loadSettings({ status: () => statusFixture([]) });
  const status = page.node("#file-storage-status");
  await settleText(status, "Off. Morrow cannot access course file content.");
  assert.deepEqual(page.permissionCalls, []);

  page.node("#enable-file-storage").dispatch("click");
  await settleText(status, "On. Morrow can read confirmed Canvas course files and transfer reviewed material.");
  assert.deepEqual(page.permissionCalls, [{ method: "request", origins: manifest.optional_host_permissions }]);
  assert.deepEqual(page.storage, { [COURSE_FILE_ACCESS_KEY]: true });

  page.node("#revoke-file-storage").dispatch("click");
  await settleText(status, "Off. Morrow cannot access course file content.");
  assert.deepEqual(page.permissionCalls.at(-1), { method: "remove", origins: manifest.optional_host_permissions });
  assert.deepEqual(page.storage, { [COURSE_FILE_ACCESS_KEY]: false });

  // Chrome, not the stored choice, decides whether the access exists: an opt-in without the
  // browser permission stays off, and the page clears the stored choice.
  const revokedInChrome = await loadSettings({ status: () => statusFixture([]), stored: { [COURSE_FILE_ACCESS_KEY]: true }, filePermission: false });
  await settleText(revokedInChrome.node("#file-storage-status"), "Off. Chrome permission was removed, so Morrow keeps course file access off.");
  assert.deepEqual(revokedInChrome.storage, { [COURSE_FILE_ACCESS_KEY]: false });
});

test("the Morrow Bridge popup names Plan and Edit as its destination and never a Course Connector", () => {
  const connectedWithSite = { paired: true, connected: true, bindings: [], siteAnchors: [{ siteAnchorId: "canvas:site", runtimeVerified: true }] };
  assert.equal(primaryLabel(connectedWithSite), "Choose courses");
  assert.equal(detailText(connectedWithSite), "Choose courses in Plan and Edit settings. Plan keeps changes ready for your review.");

  const states = [null, {}, { paired: true }, { paired: true, pairing: true }, { paired: true, connecting: true },
    { paired: true, connected: true }, connectedWithSite,
    { paired: true, connected: true, bindings: [{ sourceBindingId: "canvas:course-1", runtimeVerified: true }] },
    { paired: true, connected: true, bindings: [{ sourceBindingId: "canvas:course-1" }] }];
  const spoken = states.flatMap((status) => [statusValue(status), courseValue(status), primaryLabel(status), detailText(status)])
    .concat(PROBLEM_CODES.map((code) => problemText(code)));
  assert.deepEqual(spoken.filter((line) => /course connector/i.test(line)), []);
});

test("legacy Moodle Question Bank creates and updates cannot receive Edit access", () => {
  for (const action of ["create", "update"]) {
    const toolName = `moodle_${action}_quiz_multichoice_question`;
    const option = categoriesForBinding({ provider: "moodle" }, [{
      provider: "moodle",
      key: `moodle.form.question.bank.editquestion.multichoice.${action}.write.v1`,
      toolName,
      readOnly: false,
      summary: "Write a Moodle Multiple choice question",
      description: "Write a question.",
      inputSchema: { properties: { course_id: { type: "string" }, module_id: { type: "string" }, slot_id: { type: "string" } } },
    }]).find((entry) => entry.id === `action:moodle:${toolName}`);
    assert.ok(option);
    assert.equal(option.availability, "review");
    assert.equal(option.rules, undefined);
    assert.match(option.reviewReason, /cannot inspect every live use/i);
  }
});

const canvasOperations = JSON.parse(readFileSync(new URL("connector/extension/generated/canvas-api-catalog.json", root), "utf8"))
  .operations.map((operation) => ({ ...operation, provider: "canvas" }));
const canvasBinding = { sourceBindingId: "canvas:test-account", provider: "canvas", origin: "https://canvas.example.edu", principalFingerprint: "a".repeat(64), sessionGeneration: 1 };

function canvasOption(options, toolName) {
  return options.find((entry) => entry.id === `action:canvas:${toolName}`);
}

// One admitted Canvas write is still published for review only. New Quizzes
// matches the parts of a question by the ids the question already holds, so an
// in-place change to its answers needs the delete-then-add contract, and the
// two curated New Quiz repairs stay the only Edit path.
// scripts/test/canvas-new-quiz-item-guard.test.mjs holds the rest of that rule.
const REVIEW_ONLY_ADMITTED_CANVAS_WRITES = new Set(["canvas_update_quiz_item"]);

function admittedEditableCanvasWrites() {
  return canvasOperations.filter((operation) => operation.readOnly === false
    && canvasOperationAdmission(operation).write.state === "admitted"
    && !REVIEW_ONLY_ADMITTED_CANVAS_WRITES.has(operation.toolName));
}

test("Canvas Edit categories are exactly the admitted Canvas writes", () => {
  const options = categoriesForBinding({ provider: "canvas" }, canvasOperations);
  const editable = options.filter((option) => option.availability === "edit" && option.id.startsWith("action:canvas:")).map((option) => option.id).sort();
  const admitted = admittedEditableCanvasWrites()
    .map((operation) => `action:canvas:${operation.toolName}`)
    .sort();
  assert.ok(admitted.length > 0);
  assert.deepEqual(editable, admitted);
  for (const toolName of REVIEW_ONLY_ADMITTED_CANVAS_WRITES) {
    const option = canvasOption(options, toolName);
    assert.equal(option.availability, "review", toolName);
    assert.match(option.reviewReason, /delete-then-add contract/, toolName);
    assert.equal(option.rules, undefined, toolName);
  }
  for (const operation of canvasOperations.filter((entry) => entry.readOnly === false && canvasOperationAdmission(entry).write.state === "held")) {
    const option = canvasOption(options, operation.toolName);
    assert.equal(option.availability, "review", operation.toolName);
    assert.equal(option.reviewReason, canvasAdmissionReason(canvasOperationAdmission(operation).write), operation.toolName);
    assert.equal(option.rules, undefined, operation.toolName);
  }
});

test("Canvas actions that remove content carry their own tier and group", () => {
  const options = categoriesForBinding({ provider: "canvas" }, canvasOperations);
  const destructive = canvasOperations.filter((operation) => operation.readOnly === false && operation.risk === "destructive");
  assert.ok(destructive.length > 0);
  for (const operation of destructive) {
    const option = canvasOption(options, operation.toolName);
    assert.equal(option.tier, "destructive", operation.toolName);
    assert.equal(option.group, "Canvas actions that remove content", operation.toolName);
  }
  for (const option of options) {
    assert.equal(option.group === "Canvas actions that remove content", option.tier === "destructive", option.id);
  }
  assert.equal(options.find((option) => option.id === "canvas_page_content").tier, "standard");
  assert.equal(options.find((option) => option.id === "canvas_assignment_due_date").tier, "standard");
});

const PRIVATE_CANVAS_CONVERSATION_OPERATION = Object.freeze({
  provider: "canvas",
  key: "canvas.private.conversation.send.v1",
  toolName: "canvas_send_private_conversation",
  readOnly: false,
  service: "canvas_private_conversation",
  method: "POST",
  path: "/morrow/private/courses/{course_id}/conversations",
  resource: "Inbox",
  summary: "Send reviewed Canvas Inbox message",
  description: "Internal Morrow route for one reviewed Canvas Inbox conversation or reply.",
  morrowPrivate: true,
  inputSchema: { properties: { course_id: { type: "string" } } },
});

function checkableCanvasWrite(operation) {
  return canvasReadbackAssessment(canvasOperations, operation).state === "structurally_exact";
}

test("every offered Canvas Edit action says whether Morrow can check the saved result", () => {
  const options = categoriesForBinding({ provider: "canvas" }, canvasOperations);
  const admittedWrites = admittedEditableCanvasWrites();
  const uncheckable = admittedWrites.filter((operation) => !checkableCanvasWrite(operation));
  assert.ok(admittedWrites.length > 0);
  assert.ok(uncheckable.length > 0 && uncheckable.length < admittedWrites.length, "the Canvas catalog no longer separates checked from unchecked Edit actions");
  for (const operation of admittedWrites) {
    const option = canvasOption(options, operation.toolName);
    const checkable = checkableCanvasWrite(operation);
    assert.equal(option.availability, "edit", operation.toolName);
    assert.equal(option.verification, checkable ? "checked" : "unchecked", operation.toolName);
    assert.equal(typeof option.verificationReason === "string" && option.verificationReason.length > 0, !checkable, operation.toolName);
  }
  for (const toolName of ["canvas_delete_entry_courses", "canvas_delete_single_rubric_assessment", "canvas_bulk_select_provisional_grades",
    "canvas_clear_unread_status_for_all_submissions_courses", "canvas_add_course_to_favorites"]) {
    const option = canvasOption(options, toolName);
    assert.equal(option.verification, "unchecked", toolName);
    assert.match(option.verificationReason, /^Morrow cannot check this change after it is saved: .+\. Morrow reports the saved result as unconfirmed\.$/, toolName);
  }
  assert.equal(canvasOption(options, "canvas_delete_assignment").verification, "checked");
  assert.equal(canvasOption(options, "canvas_delete_assignment").verificationReason, undefined);
  assert.equal(options.some((option) => option.availability === "review" && option.verification !== undefined), false);
});

test("every Canvas DELETE route is marked as removing content", () => {
  const options = categoriesForBinding({ provider: "canvas" }, canvasOperations);
  const deletes = canvasOperations.filter((operation) => operation.readOnly === false && operation.method === "DELETE");
  assert.ok(deletes.length > 0);
  for (const operation of deletes) {
    const option = canvasOption(options, operation.toolName);
    assert.equal(option.destructive, true, operation.toolName);
    assert.equal(option.tier, "destructive", operation.toolName);
  }
  for (const option of options) assert.equal(option.destructive, option.tier === "destructive", option.id);
  assert.equal(options.find((option) => option.id === "canvas_page_content").destructive, false);
});

test("every curated Canvas repair reports a checked saved result", () => {
  const options = categoriesForBinding({ provider: "canvas" }, [...canvasOperations, PRIVATE_CANVAS_CONVERSATION_OPERATION]);
  for (const id of ["canvas_page_content", "canvas_page_image_alt", "canvas_assignment_image_alt", "canvas_discussion_image_alt",
    "canvas_classic_quiz_description_image_alt", "canvas_new_quiz_item_image_alt", "canvas_new_quiz_nested_image_alt",
    "canvas_inbox_messages", "canvas_assignment_due_date"]) {
    const option = options.find((entry) => entry.id === id);
    assert.equal(option.verification, "checked", id);
    assert.equal(option.verificationReason, undefined, id);
  }
});

test("a Moodle catalog action annotated destructive is marked as removing content", () => {
  const option = categoriesForBinding({ provider: "moodle" }, [{
    provider: "moodle",
    key: "moodle.form.mod.book.chapter.delete.write.v1",
    toolName: "moodle_delete_book_chapter",
    readOnly: false,
    destructive: true,
    irreversible: true,
    summary: "Delete a Moodle Book chapter",
    description: "Delete one Book chapter after review of the complete Book structure.",
    inputSchema: { properties: { course_id: { type: "integer" }, chapter_id: { type: "integer" } } },
  }]).find((entry) => entry.id === "action:moodle:moodle_delete_book_chapter");
  assert.equal(option.availability, "edit");
  assert.equal(option.destructive, true);
  assert.equal(option.tier, "destructive");
  assert.equal(option.verification, "checked");
});

test("the checked-only filter leaves only the actions Morrow can check after they are saved", async () => {
  const page = await openEditStage([CHECKED_ACTION, UNCHECKED_ACTION, REVIEW_ONLY_ACTION]);
  const listed = () => page.node("#category-list").innerHTML;
  assert.ok(listed().includes(CHECKED_ACTION.label) && listed().includes(UNCHECKED_ACTION.label) && listed().includes(REVIEW_ONLY_ACTION.label));

  page.node("#action-checked-only").checked = true;
  page.node("#action-checked-only").dispatch("change");
  assert.ok(listed().includes(CHECKED_ACTION.label));
  assert.equal(listed().includes(UNCHECKED_ACTION.label), false);
  assert.equal(listed().includes(REVIEW_ONLY_ACTION.label), false);

  page.node("#action-checked-only").checked = false;
  page.node("#action-checked-only").dispatch("change");
  assert.ok(listed().includes(UNCHECKED_ACTION.label));

  // The two assertions below are the only ones in this file that read shipped markup. Both lines
  // are static settings.html text that no page code writes: the label of the filter driven above,
  // and the page's statement about unchecked saved results.
  assert.match(settingsHtml, /<span>Only actions Morrow can check<\/span>/);
  assert.match(settingsHtml, /<li>Some actions cannot be checked after they are saved\. Morrow marks them here and reports the saved result as unconfirmed\.<\/li>/);
});

test("a broad Canvas action cannot be enabled as a blanket field grant", async () => {
  const options = categoriesForBinding({ provider: "canvas" }, canvasOperations);
  const broad = canvasOption(options, "canvas_edit_assignment");
  assert.equal(broad.availability, "edit");
  assert.equal(broad.requiresFieldSelection, true);
  assert.match(broad.description, /Morrow does not grant all of them at once/);
  const narrow = canvasOption(options, "canvas_delete_assignment");
  assert.equal(narrow.requiresFieldSelection, undefined);
  const permission = await createEditPermission({
    binding: canvasBinding,
    catalogDigest: "b".repeat(64),
    revision: 1,
    enabledCategories: options.filter((option) => option.availability === "edit" && option.id.startsWith("action:canvas:")).map((option) => option.id),
    operations: canvasOperations,
  });
  assert.deepEqual(
    permission.rules.filter((rule) => rule.toolName === "canvas_edit_assignment"),
    [{ operationKey: "PUT /v1/courses/{course_id}/assignments/{id}#edit_assignment", toolName: "canvas_edit_assignment", allowedChangedFields: [] }],
  );
  const widest = permission.rules.reduce((count, rule) => Math.max(count, rule.allowedChangedFields.length), 0);
  assert.ok(widest <= 8, `derived Canvas rules granted ${widest} fields`);
});

test("the derived field grant stops at eight fields", () => {
  const properties = (count) => Object.fromEntries([["course_id", { type: "string" }], ["id", { type: "string" }],
    ...Array.from({ length: count }, (unused, index) => [`field_${index}`, { type: "string" }])]);
  const operation = (count) => ({
    provider: "canvas", key: "PUT /v1/courses/{course_id}/widgets/{id}#update_widget", toolName: "canvas_update_widget",
    path: "/v1/courses/{course_id}/widgets/{id}", readOnly: false, summary: "Update a widget", description: "Update one widget.",
    inputSchema: { properties: properties(count) },
  });
  const optionFor = (count) => canvasOption(categoriesForBinding({ provider: "canvas" }, [operation(count)]), "canvas_update_widget");
  assert.equal(optionFor(8).requiresFieldSelection, undefined);
  assert.equal(optionFor(9).requiresFieldSelection, true);
});

test("the scope digest follows the derived rule set", async () => {
  const operation = {
    provider: "canvas", key: "PUT /v1/courses/{course_id}/widgets/{id}#update_widget", toolName: "canvas_update_widget",
    path: "/v1/courses/{course_id}/widgets/{id}", readOnly: false, summary: "Update a widget", description: "Update one widget.",
    inputSchema: { properties: { course_id: { type: "string" }, id: { type: "string" }, title: { type: "string" } } },
  };
  const widened = { ...operation, inputSchema: { properties: { ...operation.inputSchema.properties, points: { type: "number" } } } };
  const request = { binding: canvasBinding, catalogDigest: "b".repeat(64), revision: 1, enabledCategories: ["action:canvas:canvas_update_widget"] };
  const permission = await createEditPermission({ ...request, operations: [operation] });
  const widenedPermission = await createEditPermission({ ...request, operations: [widened] });
  assert.deepEqual(permission.rules[0].allowedChangedFields, ["title"]);
  assert.deepEqual(widenedPermission.rules[0].allowedChangedFields, ["points", "title"]);
  assert.notEqual(permission.scopeDigest, widenedPermission.scopeDigest);
  assert.equal(await validEditPermission({ permission, binding: canvasBinding, catalogDigest: "b".repeat(64), operations: [widened] }), null);
});

test("Canvas New Quiz nested image repairs require one exact guarded action", async () => {
  const operations = [{
    provider: "canvas",
    key: "PATCH /quiz/v1/courses/{course_id}/quizzes/{assignment_id}/items/{item_id}#update_quiz_item",
    toolName: "canvas_update_quiz_item",
    path: "/quiz/v1/courses/{course_id}/quizzes/{assignment_id}/items/{item_id}",
    readOnly: false,
    summary: "Update New Quiz item",
    description: "Update one Canvas New Quiz item.",
    inputSchema: { properties: { course_id: { type: "string" }, assignment_id: { type: "string" }, item_id: { type: "string" }, item: { type: "object" } } },
  }];
  const options = categoriesForBinding({ provider: "canvas" }, operations);
  assert.equal(options.find((entry) => entry.id === "canvas_new_quiz_nested_image_alt")?.availability, "edit");
  const permission = await createEditPermission({
    binding: { sourceBindingId: "canvas:test-account", provider: "canvas", origin: "https://canvas.example.edu", principalFingerprint: "a".repeat(64), sessionGeneration: 1 },
    catalogDigest: "b".repeat(64),
    revision: 1,
    enabledCategories: ["canvas_new_quiz_nested_image_alt"],
    operations,
  });
  assert.deepEqual(permission.rules.map((rule) => rule.canvasContentGuardKind), [
    "new_quiz_answer_feedback_image_alt",
    "new_quiz_choice_image_alt",
    "new_quiz_feedback_image_alt",
  ]);
  assert.ok(permission.rules.every((rule) => rule.toolName === "canvas_update_quiz_item" && rule.allowedChangedFields.length === 0));
});

// One Edit path exists into an existing Item Bank: the guarded image alternative-text repair. Its
// guard carries a fresh reading of the exact question and the acknowledged list of every course
// the bank reaches, so the category is offered only when the catalog carries both the write and
// the exact read the guard compares against. Every other Item Bank write stays review-only.
const ITEM_BANK_CATEGORY = "canvas_item_bank_question_image_alt";
const ITEM_BANK_UPDATE_RULE = Object.freeze({
  operationKey: "ITEM_BANK PATCH /api/banks/{bank_id}/items/{item_id}",
  toolName: "canvas_item_bank_update_item",
  allowedChangedFields: [],
  requiresItemBankGuard: true,
  itemBankGuardKind: "item_bank_entry_image_alt",
});

/** One guard shaped exactly as connector/extension/src/item-bank-guard.js accepts it. */
function itemBankGuardFixture() {
  return {
    kind: "item_bank_entry_image_alt",
    course_id: "1",
    bank_id: "91",
    bank_entry_id: "701",
    item_id: "501",
    entry_type: "Item",
    item_sha256: "1".repeat(64),
    protected_state_sha256: "2".repeat(64),
    image_index: 1,
    image_src_sha256: "3".repeat(64),
    alt_text: "Diagram of the heart",
    fan_out: { schema: "morrow.canvas.item-bank.fan-out.v1" },
    acknowledged_course_ids: ["2"],
  };
}

function itemBankWrites() {
  return canvasOperations.filter((operation) => operation.service === "item_bank" && operation.readOnly === false);
}

test("the Item Bank question repair is the only Edit path into a bank", async () => {
  const options = categoriesForBinding({ provider: "canvas" }, canvasOperations);
  const repair = options.find((entry) => entry.id === ITEM_BANK_CATEGORY);
  assert.equal(repair.availability, "edit");
  assert.equal(repair.group, "Focused Canvas repairs");
  assert.equal(repair.tier, "standard");
  assert.equal(repair.destructive, false);
  assert.equal(repair.verification, "checked");
  assert.equal(repair.verificationReason, undefined);
  assert.match(repair.description, /every course the bank reaches/);

  const writes = itemBankWrites();
  assert.equal(writes.length, 7);
  for (const operation of writes) {
    const option = canvasOption(options, operation.toolName);
    assert.equal(option.availability, "review", operation.toolName);
    assert.equal(option.reviewReason, canvasAdmissionReason(canvasOperationAdmission(operation).write), operation.toolName);
    assert.equal(option.rules, undefined, operation.toolName);
  }

  const permission = await createEditPermission({
    binding: canvasBinding, catalogDigest: "b".repeat(64), revision: 1,
    enabledCategories: [ITEM_BANK_CATEGORY], operations: canvasOperations,
  });
  assert.deepEqual(permission.rules, [{ ...ITEM_BANK_UPDATE_RULE }]);
  assert.deepEqual(await validEditPermission({ permission, binding: canvasBinding, catalogDigest: "b".repeat(64), operations: canvasOperations }), permission);
});

test("the Item Bank repair is listed with the courses it can reach, not with its label alone", async () => {
  const repair = categoriesForBinding({ provider: "canvas" }, canvasOperations).find((entry) => entry.id === ITEM_BANK_CATEGORY);
  const reach = "One item bank question can be used by quizzes in other courses. Morrow lists every course the bank reaches and asks you to confirm them before it sends the change.";
  const page = await openEditStage([CHECKED_ACTION, repair]);
  const listed = page.node("#category-list").innerHTML;
  assert.match(listed, /<span class="action-flag">Can change other courses<\/span>/);
  assert.ok(listed.includes(repair.description));

  selectAction(page, ITEM_BANK_CATEGORY);
  await settle(() => page.node("#selection-summary").textContent.includes(repair.label),
    "the page never named the selected Item Bank repair");
  assert.equal(page.node("#selection-summary").textContent,
    `1 course selected. Morrow can make: ${repair.label}. ${reach}`);
});

test("exactly one Edit rule in the whole Canvas category set requires an Item Bank guard", async () => {
  const operations = [...canvasOperations, PRIVATE_CANVAS_CONVERSATION_OPERATION];
  const options = categoriesForBinding({ provider: "canvas" }, operations);
  const enabled = options.filter((option) => option.availability === "edit").map((option) => option.id);
  const permission = await createEditPermission({
    binding: canvasBinding, catalogDigest: "b".repeat(64), revision: 1,
    enabledCategories: enabled, operations,
  });
  assert.deepEqual(permission.rules.filter((rule) => rule.requiresItemBankGuard === true), [{ ...ITEM_BANK_UPDATE_RULE }]);
  assert.equal(permission.rules.filter((rule) => rule.itemBankGuardKind !== undefined).length, 1);
});

test("the Item Bank question repair is not offered without the exact read its guard compares against", () => {
  const withoutRead = canvasOperations.filter((operation) => operation.toolName !== "canvas_item_bank_get_item");
  const withoutWrite = canvasOperations.filter((operation) => operation.toolName !== "canvas_item_bank_update_item");
  for (const operations of [withoutRead, withoutWrite]) {
    const option = categoriesForBinding({ provider: "canvas" }, operations).find((entry) => entry.id === ITEM_BANK_CATEGORY);
    assert.equal(option.availability, "review");
    assert.match(option.reviewReason, /Canvas routes the connected catalog does not carry/);
    assert.equal(option.verification, undefined);
  }
});

// Section 3.6 of docs/research/CANVAS-NEW-QUIZZES-ITEM-BANKS-CONTRACT-2026-09-06.md: an archive
// needs an administrator environment flag, a complete dependency preflight, and fresh counts
// showing zero bank entries and zero uses. Morrow can establish none of those, so no configuration
// of the catalog or of the curated categories may offer it.
test("an Item Bank archive can never be granted Edit access", async () => {
  for (const operations of [canvasOperations, itemBankWrites()]) {
    const option = canvasOption(categoriesForBinding({ provider: "canvas" }, operations), "canvas_item_bank_archive_bank");
    assert.equal(option.availability, "review");
    assert.equal(option.tier, "destructive");
    assert.equal(option.rules, undefined);
  }
  await assert.rejects(
    createEditPermission({
      binding: canvasBinding, catalogDigest: "b".repeat(64), revision: 1,
      enabledCategories: ["action:canvas:canvas_item_bank_archive_bank"], operations: canvasOperations,
    }),
    /edit_policy_category_unavailable/,
  );
  const operations = [...canvasOperations, PRIVATE_CANVAS_CONVERSATION_OPERATION];
  const everyGrant = await createEditPermission({
    binding: canvasBinding, catalogDigest: "b".repeat(64), revision: 1,
    enabledCategories: categoriesForBinding({ provider: "canvas" }, operations)
      .filter((option) => option.availability === "edit").map((option) => option.id),
    operations,
  });
  assert.equal(everyGrant.rules.some((rule) => rule.toolName === "canvas_item_bank_archive_bank"), false);
});

// The predicate the service worker and the connector runtime use to let one Item Bank write past
// the hold. An update_item call without an accepted guard, and every other Item Bank write, stays
// held, so the curated repair is the only way a bank question can change.
test("only an accepted guard lets an Item Bank question update past the hold", () => {
  const update = canvasOperations.find((operation) => operation.toolName === "canvas_item_bank_update_item");
  const attach = canvasOperations.find((operation) => operation.toolName === "canvas_item_bank_attach_item");
  const guard = itemBankGuardFixture();
  assert.deepEqual(guardedItemBankUpdate(update, { bank_id: "91", item_id: "501", morrow_item_bank_guard: guard }), guard);
  assert.equal(guardedItemBankUpdate(update, { bank_id: "91", item_id: "501" }), null);
  assert.equal(guardedItemBankUpdate(update, { morrow_item_bank_guard: { ...guard, item_sha256: "not-a-digest" } }), null);
  assert.equal(guardedItemBankUpdate(update, { morrow_item_bank_guard: { ...guard, entry_type: "Stimulus" } }), null);
  assert.equal(guardedItemBankUpdate(update, { morrow_item_bank_guard: { ...guard, extra: 1 } }), null);
  assert.equal(guardedItemBankUpdate(attach, { morrow_item_bank_guard: guard }), null);
  for (const operation of itemBankWrites().filter((entry) => entry.toolName !== "canvas_item_bank_update_item")) {
    assert.equal(guardedItemBankUpdate(operation, { morrow_item_bank_guard: guard }), null, operation.toolName);
  }
});

// The guard and the bank identifiers name the target; they are never a field Edit access grants.
test("an Item Bank guard and its bank identifiers are never changed fields", () => {
  assert.deepEqual(changedFields({
    bank_id: "91", bank_entry_id: "701", item_id: "501", morrow_item_bank_guard: itemBankGuardFixture(),
  }), []);
  assert.deepEqual(changedFields({ bank_id: "91", item_id: "501", item: { title: "New" } }), ["item"]);
});
