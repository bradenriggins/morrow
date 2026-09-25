import { problemCode, problemText } from "../src/bridge-problem-copy.js";
import { CURATED_CATEGORY_SPECS } from "../src/edit-policy.js";

const modePanel = document.querySelector("#mode-panel");
const modePlan = document.querySelector("#mode-plan");
const modeEdit = document.querySelector("#mode-edit");
const categoryFieldset = document.querySelector("#category-fieldset");
const categoryList = document.querySelector("#category-list");
const actionFilter = document.querySelector("#action-filter");
const actionCheckedOnly = document.querySelector("#action-checked-only");
const routineSwitchContainer = document.querySelector("#routine-switch");
const routineSwitch = document.querySelector("#routine-edits");
const routineBundleList = document.querySelector("#routine-bundle-list");
const routineSwitchSummary = document.querySelector("#routine-switch .routine-toggle small");
const actionFilterField = document.querySelector("#action-filter-field");
const actionCheckedOnlyField = document.querySelector("#action-checked-only-field");
const selectionSummary = document.querySelector("#selection-summary");
const connectionStatus = document.querySelector("#connection-status");
const coursesTitle = document.querySelector("#courses-title");
coursesTitle.setAttribute("tabindex", "-1");
const courseFilter = document.querySelector("#course-filter");
const coursePlatformFilter = document.querySelector("#course-platform-filter");
const coursePlatformField = document.querySelector(".platform-field");
const courseTermFilter = document.querySelector("#course-term-filter");
const courseTermField = document.querySelector(".term-field");
const courseSelectModeButton = document.querySelector("#course-select-mode");
const courseScopeTabs = document.querySelector("#course-scope");
const courseList = document.querySelector("#course-list");
const courseShowMoreRow = document.querySelector("#course-show-more-row");
const courseShowMoreButton = document.querySelector("#course-show-more");
const discoveryMoreRow = document.querySelector("#discovery-more-row");
const discoveryMoreButton = document.querySelector("#discovery-more");
const courseBulkBar = document.querySelector("#course-bulk-bar");
const courseBulkCount = document.querySelector("#course-bulk-count");
const courseBulkPlanButton = document.querySelector("#course-bulk-plan");
const courseBulkRoutineButton = document.querySelector("#course-bulk-routine");
const refreshButton = document.querySelector("#refresh");
const returnPlanButton = document.querySelector("#return-plan");
const editAccessBanner = document.querySelector("#edit-access-banner");
const editAccessBannerText = document.querySelector("#edit-access-banner-text");
const askFirstAllCoursesButton = document.querySelector("#ask-first-all-courses");
const saveEditButton = document.querySelector("#save-edit");
const saveConfirmation = document.querySelector("#save-confirmation");
const saveConfirmationDetail = document.querySelector("#save-confirmation-detail");
const confirmSaveButton = document.querySelector("#confirm-save");
const cancelSaveButton = document.querySelector("#cancel-save");
const actionHelp = document.querySelector("#action-help");
const editStageHint = document.querySelector("#edit-stage-hint");
const permissionActions = document.querySelector("#permission-actions");
const notice = document.querySelector("#notice");
const error = document.querySelector("#error");
const announcement = document.querySelector("#announcement");
const openPlatformWhenNeededCheckbox = document.querySelector("#open-platform-when-needed");
const fileStorageStatus = document.querySelector("#file-storage-status");
const enableFileStorageButton = document.querySelector("#enable-file-storage");
const revokeFileStorageButton = document.querySelector("#revoke-file-storage");
const privateChatOpenButton = document.querySelector("#private-chat-open");
const privateChatCloseButton = document.querySelector("#private-chat-close");
const privateChatDrawer = document.querySelector("#private-chat-drawer");
const privateChatScrim = document.querySelector("#private-chat-scrim");
const privateChatClient = document.querySelector("#private-chat-client");
const privateChatCourse = document.querySelector("#private-chat-course");
const privateChatHistory = document.querySelector("#private-chat-history");
const privateChatIdentifiers = document.querySelector("#private-chat-identifiers");
const privateChatMessage = document.querySelector("#private-chat-message");
const privateChatStatus = document.querySelector("#private-chat-status");
const privateChatSendButton = document.querySelector("#private-chat-send");
const privateChatPage = document.querySelector("body");
const privateChatBackground = document.querySelector("main");

// WI-5.3: no pagination. The merged course list renders up to this many rows, then "Show more".
const ROW_LIMIT_STEP = 100;
const DISCOVERY_PAGE_LIMIT = 100;
/** WI-5.3: "8 courses or fewer" hides the scope tabs and the platform and term menus. */
const FEW_COURSES_THRESHOLD = 8;
const SCOPES = Object.freeze([
  ["all", "All"],
  ["connected", "Connected"],
  ["available", "Not connected"],
  ["attention", "Needs attention"],
]);
/** WI-5.3 row order: needs attention, then connected, then not connected. */
const SCOPE_RANK = Object.freeze({ attention: 0, connected: 1, available: 2 });
const COURSE_FILE_STORAGE_ACCESS_KEY = "courseFileStorageAccessEnabled";
// WI-1.2 (D1a): the same storage key src/service-worker.js reads (openPlatform, :6141). A missing
// key means on, so the checkbox starts checked before the first storage read settles.
const OPEN_PLATFORM_WHEN_NEEDED_KEY = "openPlatformWhenNeeded";
const COURSE_FILE_STORAGE_ORIGINS = ["https://*/*"];
// Course-reach notes belong only to Edit categories that can send a change.
// Item Bank writes are held and have no Edit category.
const CATEGORY_COURSE_REACH = Object.freeze({});

// F10: a generated option with more than 8 changeable fields is published with
// `allowedChangedFields: []` and `requiresFieldSelection: true`, so a checkbox on it alone would
// look like a grant and change nothing (WI-3.4). The public option carries no rule detail, so this
// table names, by tool, the curated bundle ids from `src/edit-policy.js` `CURATED_CATEGORY_SPECS`
// (WI-3.2, WI-3.3) that hold a rule for it. `scripts/test/settings-page.test.mjs` reads that source
// and fails when this table drifts from it.
const FIELD_SELECTION_BUNDLES = Object.freeze({
  canvas_bulk_update_assignment_dates: Object.freeze(["canvas_dates"]),
  canvas_create_assignment: Object.freeze(["canvas_assignment_create"]),
  canvas_create_assignment_group: Object.freeze(["canvas_gradebook_setup"]),
  canvas_create_calendar_event: Object.freeze(["canvas_calendar"]),
  canvas_create_folder_courses: Object.freeze(["canvas_files_organize"]),
  canvas_create_module: Object.freeze(["canvas_modules_create"]),
  canvas_create_module_item: Object.freeze(["canvas_modules_create"]),
  canvas_create_new_discussion_topic_courses: Object.freeze(["canvas_discussion_create"]),
  canvas_create_page_courses: Object.freeze(["canvas_pages_create"]),
  canvas_create_quiz_item: Object.freeze(["canvas_new_quiz_items"]),
  canvas_create_single_quiz_question: Object.freeze(["canvas_classic_quiz_questions"]),
  canvas_create_single_rubric: Object.freeze(["canvas_rubrics"]),
  canvas_duplicate_page: Object.freeze(["canvas_pages_create"]),
  canvas_edit_assignment: Object.freeze(["canvas_assignment_due_date", "canvas_assignment_text", "canvas_alt_text", "canvas_dates", "canvas_assignment_setup", "canvas_publish_state"]),
  canvas_edit_assignment_group: Object.freeze(["canvas_gradebook_setup"]),
  canvas_edit_quiz: Object.freeze(["canvas_classic_quiz_text", "canvas_alt_text", "canvas_dates", "canvas_publish_state", "canvas_classic_quiz_settings"]),
  canvas_send_private_conversation: Object.freeze(["canvas_inbox_messages"]),
  canvas_update_assignment_override: Object.freeze(["canvas_dates"]),
  canvas_update_calendar_event: Object.freeze(["canvas_calendar"]),
  canvas_update_create_front_page_courses: Object.freeze(["canvas_pages_text"]),
  canvas_update_create_page_courses: Object.freeze(["canvas_page_content", "canvas_pages_text", "canvas_alt_text", "canvas_publish_state"]),
  canvas_update_existing_quiz_question: Object.freeze(["canvas_alt_text", "canvas_classic_quiz_questions"]),
  canvas_update_file: Object.freeze(["canvas_files_organize"]),
  canvas_update_learning_object_s_date_information_assignments: Object.freeze(["canvas_dates"]),
  canvas_update_learning_object_s_date_information_discussion_topics: Object.freeze(["canvas_dates"]),
  canvas_update_learning_object_s_date_information_files: Object.freeze(["canvas_dates"]),
  canvas_update_learning_object_s_date_information_pages: Object.freeze(["canvas_dates"]),
  canvas_update_learning_object_s_date_information_quizzes: Object.freeze(["canvas_dates"]),
  canvas_update_module: Object.freeze(["canvas_modules_structure", "canvas_publish_state"]),
  canvas_update_module_item: Object.freeze(["canvas_modules_structure", "canvas_publish_state"]),
  canvas_update_quiz_item: Object.freeze(["canvas_alt_text", "canvas_new_quiz_items"]),
  canvas_update_single_rubric: Object.freeze(["canvas_rubrics"]),
  canvas_update_topic_courses: Object.freeze(["canvas_discussion_text", "canvas_alt_text", "canvas_publish_state"]),
  moodle_hide_activity: Object.freeze(["organize"]),
  moodle_hide_section: Object.freeze(["organize"]),
  moodle_move_activity: Object.freeze(["organize"]),
  moodle_show_activity: Object.freeze(["organize"]),
  moodle_show_section: Object.freeze(["organize"]),
  moodle_update_assignment: Object.freeze(["dates", "content"]),
  moodle_update_label: Object.freeze(["content"]),
  moodle_update_page: Object.freeze(["content"]),
  moodle_update_quiz: Object.freeze(["dates", "content"]),
});
const PRIVATE_CHAT_FOCUSABLE_SELECTOR = "button, select, textarea, input, [href], [tabindex]";

// WI-5.5: Level 1 of the Customize view, in the spec's fixed order. "beyond_course" behaves like
// every other area (closed until opened or matched by search); the spec calls it out only because
// no level and no preset ever includes it automatically.
// "other" is last: WI-3.1's own valid-area set (scripts/test/edit-option-facts.test.mjs) allows it,
// for the options a person still has to place by hand (F WI-3.1). It, not silent loss, is where an
// option with no area, or one WI-3.1 has not placed yet, lands.
const AREA_ORDER = Object.freeze(["pages", "assignments", "quizzes", "discussions", "files", "calendar", "people", "accessibility", "beyond_course", "other"]);
const AREA_LABELS = Object.freeze({
  pages: "Pages and course content",
  assignments: "Assignments and grading setup",
  quizzes: "Quizzes and question banks",
  discussions: "Discussions and announcements",
  files: "Files and media",
  calendar: "Calendar and scheduling",
  people: "Sections and groups",
  accessibility: "Accessibility repairs",
  beyond_course: "Beyond this course",
  other: "Other actions",
});
// WI-5.5: Level 2. Only a generated single action (WI-3.1's operationKind) carries a `kind`; a
// curated bundle (src/edit-policy.js) never does, and no curated bundle removes content (D2a), so a
// bundle's kind is its own `destructive` fact.
const KIND_ORDER = Object.freeze(["edit", "publish", "remove"]);
const KIND_LABELS = Object.freeze({ edit: "Create and edit", publish: "Publish and organize", remove: "Remove content" });

let privateChatReturnFocus = null;

const state = {
  busy: false,
  actionCheckedOnly: false,
  actionFilter: "",
  categories: [],
  // One list of available courses per signed-in site, keyed by siteAnchorId.
  discoveries: new Map(),
  // Sites whose list could not be read. A background refresh does not retry them; Refresh
  // connected courses does.
  discoveryFailed: new Set(),
  fileStorageAccess: { browserPermission: false, enabled: false, optedIn: false, checking: true },
  fileStorageBusy: false,
  // WI-5.3: the course-list toolbar. `q` matches name and code; `platform` and `term` are exact
  // values or "all"; `scope` is one of the SCOPES ids.
  filters: { q: "", platform: "all", term: "all", scope: "all" },
  // WI-5.3: the row cap. "Show more" raises it by ROW_LIMIT_STEP; a filter change resets it.
  rowLimit: ROW_LIMIT_STEP,
  // WI-5.3: "Select" shows a checkbox on each connected course and the bulk bar.
  selectMode: false,
  // WI-5.4: sourceBindingId values whose detail is open in place under their row.
  openCourses: new Set(),
  // The one course whose Disconnect is waiting for the person to confirm it, or null.
  confirmingDisconnect: null,
  // WI-5.5: area ids, and "${areaId}/${kind}" keys, currently open in the Customize view.
  openAreas: new Set(),
  openKinds: new Set(),
  // WI-5.1: code, term, role, favorite and published for a course, keyed by "${origin}|${courseId}",
  // read from chrome.storage.local's Bridge-only courseMeta map. Never sent anywhere.
  courseMeta: new Map(),
  mode: "plan",
  openPlatformBusy: false,
  // WI-1.2 (D1a): a missing storage key means on, so this starts true and is corrected once the
  // stored value is read.
  openPlatformWhenNeeded: true,
  openPlatformSettingBusy: false,
  // WI-4.5 (D2): true while the "Routine edits" switch set the current selection. It turns off by
  // itself when no routine bundle remains available for the selected courses.
  routineMode: false,
  openPlatformProgressVisible: false,
  optionsByBinding: new Map(),
  optionsLoading: false,
  optionsRequestToken: 0,
  pendingSaveConfirmation: false,
  saveProgressText: null,
  privateChatOpen: false,
  privateChatBusy: false,
  privateChatReview: null,
  readGeneration: 0,
  statusLoading: false,
  saveConfirmedFor: null,
  selected: new Set(),
  selectedCategories: new Set(),
  status: null,
  statusReadFailed: false
};

function privateChatClients() {
  const value = state.status?.privateChat?.clients;
  return Array.isArray(value) ? value.filter((client) => client && typeof client.id === "string" && typeof client.name === "string") : [];
}

function privateChatCourses() {
  const bindings = Array.isArray(state.status?.bindings) ? state.status.bindings : [];
  return bindings.filter((binding) => isEligible(binding) && binding.runtimeVerified === true);
}

function wipePrivateChat() {
  privateChatIdentifiers.value = "";
  privateChatMessage.value = "";
  state.privateChatReview = null;
  privateChatHistory.innerHTML = '<p class="state-message">No messages in this local conversation.</p>';
}

async function closePrivateChat() {
  if (!state.privateChatOpen) return;
  const returnFocus = privateChatReturnFocus;
  privateChatReturnFocus = null;
  wipePrivateChat();
  state.privateChatOpen = false;
  privateChatDrawer.hidden = true;
  privateChatScrim.hidden = true;
  privateChatPage.classList.remove("private-chat-visible");
  privateChatBackground.removeAttribute("inert");
  privateChatOpenButton.setAttribute("aria-expanded", "false");
  (returnFocus?.focus ? returnFocus : privateChatOpenButton).focus();
  await chrome.runtime.sendMessage({ type: "morrow_private_chat_close" }).catch(() => undefined);
}

function openPrivateChat() {
  if (state.privateChatOpen) return;
  privateChatReturnFocus = document.activeElement?.focus ? document.activeElement : privateChatOpenButton;
  state.privateChatOpen = true;
  privateChatDrawer.hidden = false;
  privateChatScrim.hidden = false;
  privateChatPage.classList.add("private-chat-visible");
  privateChatBackground.setAttribute("inert", "");
  privateChatOpenButton.setAttribute("aria-expanded", "true");
  renderPrivateChat();
  privateChatCloseButton.focus();
}

function privateChatFocusableControls() {
  return [...privateChatDrawer.querySelectorAll(PRIVATE_CHAT_FOCUSABLE_SELECTOR)].filter((element) => {
    return !element.disabled && element.getAttribute("tabindex") !== "-1" && !element.closest("[hidden]");
  });
}

function trapPrivateChatFocus(event) {
  if (!state.privateChatOpen || event.key !== "Tab") return;
  const controls = privateChatFocusableControls();
  if (!controls.length) {
    event.preventDefault();
    privateChatDrawer.focus();
    return;
  }
  const active = document.activeElement;
  const inside = active === privateChatDrawer || active?.closest?.("#private-chat-drawer") === privateChatDrawer;
  const first = controls[0];
  const last = controls.at(-1);
  if (!inside || (event.shiftKey && active === first) || (!event.shiftKey && active === last)) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  }
}

function renderPrivateChat() {
  const clients = privateChatClients();
  const courses = privateChatCourses();
  const chat = state.status?.privateChat;
  const fixedScope = typeof chat?.sourceBindingId === "string" ? chat.sourceBindingId : "";
  const selectedClient = clients.find((client) => client.id === privateChatClient.value) || clients[0] || null;
  const selectedCourse = fixedScope
    ? courses.find((binding) => binding.sourceBindingId === fixedScope) || null
    : courses.find((binding) => binding.sourceBindingId === privateChatCourse.value) || courses[0] || null;
  privateChatClient.innerHTML = clients.length
    ? clients.map((client) => `<option value="${escapeHtml(client.id)}">${escapeHtml(client.name)}</option>`).join("")
    : '<option value="">No eligible assistant</option>';
  privateChatCourse.innerHTML = courses.length
    ? courses.map((binding) => `<option value="${escapeHtml(binding.sourceBindingId)}">${escapeHtml(providerName(binding))}: ${escapeHtml(courseName(binding))}</option>`).join("")
    : '<option value="">No ready connected course</option>';
  if (selectedClient) privateChatClient.value = selectedClient.id;
  if (selectedCourse) privateChatCourse.value = selectedCourse.sourceBindingId;
  const transportAvailable = chat?.transportAvailable === true;
  if (fixedScope && courses.some((binding) => binding.sourceBindingId === fixedScope)) privateChatCourse.value = fixedScope;
  privateChatClient.disabled = true;
  privateChatCourse.disabled = !transportAvailable || !courses.length || Boolean(fixedScope);
  privateChatMessage.disabled = !transportAvailable || !selectedClient || !selectedCourse;
  privateChatIdentifiers.disabled = privateChatMessage.disabled;
  privateChatSendButton.disabled = privateChatMessage.disabled || state.privateChatBusy;
  const messages = Array.isArray(chat?.messages) ? chat.messages : [];
  privateChatHistory.innerHTML = messages.length
    ? messages.map((message) => `<div class="private-chat-message private-chat-message-${message.role === "assistant" ? "assistant" : "user"}"><strong>${message.role === "assistant" ? escapeHtml(selectedClient?.name || "Assistant") : "You"}</strong><p>${privateChatMessageHtml(message)}</p></div>`).join("")
    : '<p class="state-message">No messages in this local conversation.</p>';
  privateChatHistory.scrollTop = privateChatHistory.scrollHeight;
  // A chat that exists but waits for no message is answering the one just sent, unless it ended at
  // its message limit.
  privateChatStatus.textContent = !transportAvailable
    ? chat?.ended === true
      ? "This Private Chat reached its message limit. Close this drawer, then ask your assistant to start a new Private Chat."
      : clients.length
        ? messages.length ? "Sent. Waiting for the assistant's reply. Keep this drawer open." : "Waiting for the assistant. Keep this drawer open."
        : "Ask the connected assistant to start Morrow Private Chat. Keep this drawer open while you chat."
    : !clients.length
      ? "The assistant relay is not ready."
      : !courses.length
        ? "Open one connected course in Canvas or Moodle before using Private Chat."
        : !selectedCourse
          ? "The course used by this Private Chat is no longer connected. Close the drawer and start again."
        : "Ready. Morrow replaces the listed student identities before the message reaches the assistant.";
}

// The educator sees each student's name where the assistant sees a label. The
// names come from this Bridge's own course roster and never leave this page.
function privateChatMessageHtml(message) {
  if (!Array.isArray(message.parts) || !message.parts.length) return escapeHtml(message.text);
  return message.parts.map((part) => (typeof part?.name === "string" && typeof part.label === "string"
    ? `<span class="private-chat-name" title="The assistant sees ${escapeHtml(part.label)}">${escapeHtml(part.name)}</span>`
    : escapeHtml(part?.text))).join("");
}

// Name-like words that matched no student are sent as written only after the
// educator sends the same message again.
function privateChatConfirmedNames(key) {
  return state.privateChatReview?.key === key ? { confirmedNames: state.privateChatReview.names } : {};
}

async function sendPrivateChatMessage() {
  const binding = privateChatCourses().find((candidate) => candidate.sourceBindingId === privateChatCourse.value);
  const identifiers = privateChatIdentifiers.value.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean);
  const text = privateChatMessage.value;
  if (!binding || !text.trim()) {
    privateChatStatus.textContent = "Choose a course and enter a message.";
    announce(privateChatStatus.textContent);
    return;
  }
  state.privateChatBusy = true;
  renderPrivateChat();
  const response = await chrome.runtime.sendMessage({
    type: "morrow_private_chat_send",
    sourceBindingId: binding.sourceBindingId,
    text,
    assertedIdentifiers: identifiers,
    ...privateChatConfirmedNames(JSON.stringify([binding.sourceBindingId, text, identifiers])),
  }).catch((cause) => ({ ok: false, code: problemCode(cause) }));
  state.privateChatBusy = false;
  state.privateChatReview = null;
  if (response?.ok && response.result?.status === "review" && Array.isArray(response.result.names)) {
    state.privateChatReview = { key: JSON.stringify([binding.sourceBindingId, text, identifiers]), names: response.result.names.map(String) };
    renderPrivateChat();
    privateChatStatus.textContent = `Not sent. These words look like names but match no student in this course: ${state.privateChatReview.names.join(", ")}. If one is a student, add that name to the list. To send the message as written, select Send again.`;
    announce(privateChatStatus.textContent);
    return;
  }
  if (!response?.ok) {
    renderPrivateChat();
    privateChatStatus.textContent = problemText(problemCode(response?.code || "private_chat_send_failed"));
    announce(privateChatStatus.textContent);
    return;
  }
  privateChatIdentifiers.value = "";
  privateChatMessage.value = "";
  await refresh();
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
  })[character]);
}

function plural(count, singular, pluralForm = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function courseName(binding) {
  return binding.courseName || (binding.courseId ? `Course ${binding.courseId}` : "Connected course");
}

function providerName(binding) {
  const provider = String(binding.provider || "Learning platform");
  return provider === "moodle" ? "Moodle" : provider === "canvas" ? "Canvas" : provider;
}

function nativeCourseId(value) {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value !== "string" || !/^[1-9][0-9]{0,18}$/.test(value)) return "";
  return value;
}

function anchors() {
  const value = state.status?.siteAnchors;
  return Array.isArray(value) ? value.filter((anchor) => anchor && typeof anchor.siteAnchorId === "string" && anchor.siteAnchorId && anchor.runtimeVerified === true) : [];
}

/** The saved site the empty course list can offer to open, open or closed. */
function savedAnchor() {
  const value = state.status?.siteAnchors;
  const list = Array.isArray(value) ? value : [];
  return list.find((anchor) => anchor && typeof anchor.siteAnchorId === "string" && anchor.siteAnchorId && typeof anchor.provider === "string") || null;
}

function platformDisplayName(provider) {
  return provider === "moodle" ? "Moodle" : provider === "canvas" ? "Canvas" : "the learning platform";
}

/** "Open Canvas" or "Open Moodle" (WI-1.1); "Opening Canvas" or "Opening Moodle" once the wait has been visible long enough (WI-F.10). */
function openPlatformLabel(entity, busy = false) {
  if (entity?.provider === "canvas") return busy ? "Opening Canvas" : "Open Canvas";
  if (entity?.provider === "moodle") return busy ? "Opening Moodle" : "Open Moodle";
  return busy ? "Opening the learning platform" : "Open the learning platform";
}

/**
 * Opens a saved site's tab (WI-1.1's handler): from the empty course list, with no binding, or from
 * a closed course card, with a binding, so the tab opens to that exact course. The button disables
 * at once, so a second click cannot start a second tab, but its text only changes to "Opening…" once
 * the wait has run long enough to need it (WI-F.10): no flash of progress for a fast open. A sign-in
 * is necessary when the open finishes unverified: the site loaded, but no saved session matched it.
 */
async function openSavedPlatform(siteAnchorId, sourceBindingId, provider) {
  if (!siteAnchorId || state.openPlatformBusy) return;
  state.openPlatformBusy = true;
  state.openPlatformProgressVisible = false;
  clearError();
  renderCourseList();
  const revealTimer = setTimeout(() => {
    state.openPlatformProgressVisible = true;
    renderCourseList();
  }, 400);
  try {
    const result = await request("morrow_open_platform", sourceBindingId ? { siteAnchorId, sourceBindingId } : { siteAnchorId });
    if (result?.verified === false) showNotice(`Sign in to ${platformDisplayName(provider)} in the tab that opened. Morrow continues after that.`);
    else clearNotice();
  } catch (cause) {
    showError(cause);
  } finally {
    clearTimeout(revealTimer);
    state.openPlatformBusy = false;
    state.openPlatformProgressVisible = false;
    await refresh();
  }
}

let pendingCourseFocus = null;

function focusedCourseControl() {
  const active = document.activeElement;
  if (!active?.closest?.("#course-list")) return null;
  const bindingId = active.closest("[data-binding-id]")?.dataset.bindingId;
  if (active.classList.contains("course-select")) {
    return bindingId ? { selector: `[data-binding-id=${JSON.stringify(bindingId)}] .course-select`, bindingId } : null;
  }
  for (const attribute of ["data-toggle-course", "data-open-platform", "data-connect-row", "data-set-level", "data-remove-category", "data-open-customize", "data-disconnect", "data-disconnect-cancel", "data-disconnect-confirm"]) {
    if (!active.hasAttribute(attribute)) continue;
    const scope = attribute === "data-open-customize" ? (active.closest(".course-detail-links") ? ".course-detail-links " : ".course-level-control ") : "";
    const selector = `${scope}[${attribute}=${JSON.stringify(active.getAttribute(attribute))}]`;
    return { selector: bindingId ? `[data-binding-id=${JSON.stringify(bindingId)}] ${selector}` : selector, bindingId };
  }
  if (active.id === "open-platform-empty") return { selector: "#open-platform-empty" };
  return null;
}

function courseFocusToRestore() {
  const focused = focusedCourseControl();
  if (focused) return focused;
  if (pendingCourseFocus && document.activeElement === coursesTitle) return pendingCourseFocus;
  pendingCourseFocus = null;
  return null;
}

function restoreCourseFocus(focus) {
  if (!focus) return;
  if (state.busy) {
    pendingCourseFocus = focus;
    coursesTitle.focus();
    return;
  }
  const target = courseList.querySelector(focus.selector);
  if (target && !target.disabled) {
    target.focus();
    pendingCourseFocus = null;
    return;
  }
  const row = focus.bindingId && courseList.querySelector(`[data-toggle-course=${JSON.stringify(focus.bindingId)}]`);
  (row || coursesTitle).focus();
  pendingCourseFocus = null;
}

/** A list's receipt is good for a few minutes. Its rows stay shown after that; Connect and "Load
 * more" read the list again first. */
function discoveryExpired(discovery) {
  return !discovery || discovery.requiresRefresh === true || !Number.isFinite(discovery.expiresAt) || Date.now() >= discovery.expiresAt;
}

function discoveryItems() {
  return [...state.discoveries.values()].flatMap((discovery) => (Array.isArray(discovery.courses) ? discovery.courses : []).map((course) => ({
    available: true,
    siteAnchorId: discovery.siteAnchorId,
    courseId: nativeCourseId(course?.id),
    courseName: typeof course?.name === "string" && course.name ? course.name : `Course ${nativeCourseId(course?.id)}`,
    provider: discovery.provider,
    origin: discovery.origin,
    siteUrl: discovery.siteUrl,
    principalId: discovery.principalId,
    // WI-5.1: passed through so a not-yet-connected row can show the same code, term, and role
    // line a connected row shows from courseMeta.
    code: typeof course?.code === "string" ? course.code : "",
    term: typeof course?.term === "string" ? course.term : "",
    role: typeof course?.role === "string" ? course.role : "",
    favorite: course?.favorite === true
  }))).filter((course) => course.courseId);
}

function courseMetaKey(origin, courseId) {
  return origin && courseId ? `${origin}|${courseId}` : "";
}

/**
 * WI-5.1: code, term, role and favorite for a connected course. `BridgeBinding` carries none of
 * these; they live only in chrome.storage.local's Bridge-only `courseMeta` map, keyed by
 * "${origin}|${courseId}" and read into state.courseMeta by refreshCourseMeta().
 */
function bindingMeta(binding) {
  const key = courseMetaKey(binding?.origin, nativeCourseId(binding?.courseId));
  const entry = key ? state.courseMeta.get(key) : undefined;
  return entry && typeof entry === "object" ? entry : null;
}

/** WI-1.1, WI-5.3: a connected course whose site is closed, or one Morrow cannot identify, needs
 * attention: its row shows an action button, not the D7 state text (siteClosed is declared below;
 * function declarations are hoisted). */
function bindingScope(binding) {
  if (!isEligible(binding) || siteClosed(binding)) return "attention";
  return "connected";
}

/** WI-5.3: one merged list, each row a connected course or a discovered course not yet connected. */
function courseRows() {
  const bindings = Array.isArray(state.status?.bindings) ? state.status.bindings : [];
  const boundKeys = new Set(bindings.map((binding) => courseMetaKey(binding.origin, nativeCourseId(binding.courseId))).filter(Boolean));
  const bindingRows = bindings.map((binding) => {
    const meta = bindingMeta(binding);
    return {
      kind: "binding",
      binding,
      rowId: `b:${binding.sourceBindingId}`,
      name: courseName(binding),
      code: meta?.code || "",
      term: meta?.term || "",
      platform: providerName(binding),
      site: siteAddress(binding),
      role: meta?.role || "",
      favorite: meta?.favorite === true,
      scope: bindingScope(binding)
    };
  });
  const availableRows = discoveryItems()
    .filter((course) => !boundKeys.has(courseMetaKey(course.origin, course.courseId)))
    .map((course) => ({
      kind: "available",
      course,
      rowId: `a:${courseMetaKey(course.origin, course.courseId)}`,
      name: course.courseName,
      code: course.code,
      term: course.term,
      platform: providerName(course),
      site: siteAddress(course),
      role: course.role,
      favorite: course.favorite === true,
      scope: "available"
    }));
  return [...bindingRows, ...availableRows];
}

/** The site a course belongs to, as the address a person types, so the search finds it. */
function siteAddress(entity) {
  return [entity?.siteUrl, entity?.origin].filter((value) => typeof value === "string" && value).join(" ");
}

function rowMatchesFilters(row, { skipScope = false } = {}) {
  const query = state.filters.q.trim().toLocaleLowerCase();
  if (query && ![row.name, row.code, row.term, row.platform, row.site].join(" ").toLocaleLowerCase().includes(query)) return false;
  if (state.filters.platform !== "all" && row.platform !== state.filters.platform) return false;
  if (state.filters.term !== "all" && row.term !== state.filters.term) return false;
  if (!skipScope && state.filters.scope !== "all" && row.scope !== state.filters.scope) return false;
  return true;
}

/** WI-5.3: the scope tab counts, each computed with every other filter applied but its own. */
function scopeCounts(rows) {
  const base = rows.filter((row) => rowMatchesFilters(row, { skipScope: true }));
  return {
    all: base.length,
    connected: base.filter((row) => row.scope === "connected").length,
    available: base.filter((row) => row.scope === "available").length,
    attention: base.filter((row) => row.scope === "attention").length
  };
}

/** WI-5.3 order: needs attention, then connected, then not connected; favorites first, then name. */
function orderedMatches(rows) {
  return rows.filter((row) => rowMatchesFilters(row))
    .sort((left, right) => (SCOPE_RANK[left.scope] - SCOPE_RANK[right.scope]) || (Number(right.favorite) - Number(left.favorite)) || left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" }));
}

function distinctValues(rows, key) {
  return [...new Set(rows.map((row) => row[key]).filter((value) => typeof value === "string" && value))].sort((left, right) => left.localeCompare(right));
}

function isEligible(binding) {
  return Boolean(binding?.sourceBindingId && (binding.courseId || binding.courseName || binding.siteUrl || binding.origin));
}

function storedEditPermission(binding) {
  return optionsFor(binding)?.editPermission || binding?.editPermission || binding?.staleEditPermission || null;
}

function permissionExpiresAt(binding) {
  const value = storedEditPermission(binding)?.expiresAt;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

// Edit is not timed. Only a grant saved while it was carries an end time, and that grant lapses to
// Plan at that time.
function permissionHasExpired(binding) {
  const expiresAt = permissionExpiresAt(binding);
  return expiresAt !== null && Date.now() >= expiresAt;
}

function isStale(binding) {
  const permission = storedEditPermission(binding);
  return permissionHasExpired(binding) || binding?.policyStale === true || Boolean(permission && state.status?.catalogDigest && permission.catalogDigest !== state.status.catalogDigest);
}

/** WI-1.4: a connection with a live Edit permission. Morrow can act in it now, with no review. */
function hasActiveEdit(binding) {
  return isEligible(binding) && !permissionHasExpired(binding) && !isStale(binding)
    && Array.isArray(binding?.editPermission?.enabledCategories) && binding.editPermission.enabledCategories.length > 0;
}

function activeEditBindings() {
  return (Array.isArray(state.status?.bindings) ? state.status.bindings : []).filter(hasActiveEdit);
}

function selectedBindings() {
  const all = Array.isArray(state.status?.bindings) ? state.status.bindings : [];
  return all.filter((binding) => state.selected.has(binding.sourceBindingId) && isEligible(binding));
}

function selectedBindingsNeedSite(bindings = selectedBindings()) {
  return bindings.some((binding) => binding.runtimeVerified !== true);
}

function categoryById(id) {
  return state.categories.find((category) => category.id === id);
}

function optionsFor(binding) {
  const detail = state.optionsByBinding.get(binding?.sourceBindingId);
  const summary = binding?.editPermission;
  const permission = detail?.editPermission;
  return binding?.runtimeVerified === true && detail?.runtimeVerified === true && detail.provider === binding?.provider
    && detail.policyRevision === Number(binding?.editPolicyRevision || 0)
    && detail.catalogDigest === state.status?.catalogDigest
    && Boolean(summary) === Boolean(permission)
    && (!summary || (summary.scopeDigest === permission.scopeDigest && summary.revision === permission.revision && summary.expiresAt === permission.expiresAt))
    ? detail
    : null;
}

function supportsCategory(binding, id) {
  if (typeof id === "string" && id.startsWith("family:")) return bindingFamilyCategoryIds(binding, id.slice("family:".length)).length > 0;
  return optionsFor(binding)?.options.some((category) => category?.id === id && category.availability === "edit") === true;
}

function rebuildCategories() {
  const selected = selectedBindings();
  if (!selected.length || selected.some((binding) => !optionsFor(binding))) {
    state.categories = [];
    return;
  }
  const details = selected.map(optionsFor);
  // WI-5.6: Canvas ids and Moodle ids never match, so a mixed selection uses the platform-neutral
  // families instead of the same-id intersection below, and shows bundles only (single actions need
  // one platform, because a generated action's own id never carries a family).
  if (new Set(selected.map((binding) => binding.provider)).size > 1) {
    state.categories = mixedPlatformCategories(details);
    return;
  }
  const shared = new Map(details[0].options.map((option) => [option.id, option]));
  for (const detail of details.slice(1)) {
    const current = new Map(detail.options.map((option) => [option.id, option]));
    for (const [id, option] of shared) {
      const other = current.get(id);
      if (!other) {
        shared.delete(id);
        continue;
      }
      if (option.availability !== "edit" || other.availability !== "edit") {
        const reasons = [option.reviewReason, other.reviewReason].filter(Boolean);
        shared.set(id, { ...option, availability: "review", ...(reasons.length ? { reviewReason: [...new Set(reasons)].join(" ") } : {}) });
      }
    }
  }
  state.categories = [...shared.values()].sort((left, right) => left.group.localeCompare(right.group) || left.label.localeCompare(right.label) || left.id.localeCompare(right.id));
}

/** WI-5.6: the platform-neutral key a curated bundle's own id carries, read from properties every
 * option already has (never a per-id table, so this cannot drift from src/edit-policy.js's
 * CURATED_CATEGORY_SPECS). Every routine bundle (D2a) is interchangeable across providers as
 * "Routine edits". The only other cross-provider-equivalent shape today is a bundle that is
 * rememberable but not routine: moodle's own "dates" and Canvas's own "canvas_dates" are both that
 * shape, and no other curated bundle is. A generated single action (categoryIsGenerated) never
 * carries a family: WI-5.6 says it needs one platform. */
function categoryFamily(category) {
  if (categoryIsGenerated(category)) return null;
  if (category.routine === true) return "routine";
  if (category.rememberable === true) return "dates";
  return null;
}

// What each platform's routine set changes with no review. Canvas's and Moodle's routine sets
// differ, so a selection is told only about the platforms it holds.
// scripts/test/settings-page.test.mjs checks each sentence names every field its routine set changes.
const ROUTINE_CHANGES = Object.freeze({
  canvas: "edits text and titles, changes module item links and how they open, reorders, indents and moves modules, items and files, creates folders, and adds alternative text",
  moodle: "edits text and titles in Moodle Pages, Text and media areas, Assignments, and Quizzes",
});

/** The Routine edits promise for the platforms a selection holds. */
function routineSummary(providers) {
  const platforms = ["canvas", "moodle"].filter((provider) => providers.includes(provider));
  const changes = platforms.length === 1
    ? `Morrow ${ROUTINE_CHANGES[platforms[0]]} without another approval.`
    : `In Canvas courses, Morrow ${ROUTINE_CHANGES.canvas}. In Moodle courses, Morrow ${ROUTINE_CHANGES.moodle}. Morrow makes these changes without another approval.`;
  return `${changes} ${routineAsks(platforms)}`;
}

/** What the routine set never does with no review. Only Canvas's creates anything: a folder. */
function routineAsks(providers) {
  return providers.includes("canvas")
    ? "It always asks before it creates anything other than a folder, publishes, removes, posts, or changes a date, points or a course setting."
    : "It always asks before it creates anything, publishes, removes, posts, or changes a date, points or a course setting.";
}

const CATEGORY_FAMILY_LABELS = Object.freeze({
  routine: "Routine edits",
  dates: "Change due dates and availability dates",
});

/** A family row states what it grants on each selected platform: the routine promise for those
 * platforms, or the words of each platform's own date bundle, which name its own objects. */
function familyDescription(family, members) {
  if (family === "routine") return routineSummary(members.map((option) => option.provider));
  return [...new Set(members.map((option) => option.description))].join(" ");
}

/** WI-5.6: a Canvas id and a Moodle id never match, so the same-id intersection rebuildCategories
 * otherwise uses would show nothing for a mixed selection. One row stands in for each family below,
 * available only when every selected connection has its own edit-available option in that family
 * (so the choice can never grant one connection nothing); resolveEnabledCategoriesFor expands a
 * family row back to each connection's own ids at save. */
function mixedPlatformCategories(details) {
  const members = (detail, family) => detail.options.filter((option) =>
    option.availability === "edit" && !option.requiresFieldSelection && categoryFamily(option) === family);
  const byPlatform = [...details].sort((left, right) => String(left.provider).localeCompare(String(right.provider)));
  return Object.entries(CATEGORY_FAMILY_LABELS)
    .filter(([family]) => details.every((detail) => members(detail, family).length > 0))
    .map(([family, label]) => ({
      id: `family:${family}`, group: "Actions for every selected course", label,
      description: familyDescription(family, byPlatform.flatMap((detail) => members(detail, family).map((option) => ({ ...option, provider: detail.provider })))),
      availability: "edit", destructive: false, routine: family === "routine", rememberable: true, requiresFieldSelection: false, family,
    }))
    .sort((left, right) => left.label.localeCompare(right.label));
}

/** WI-5.6: one connection's own ids for a platform-neutral family, from its live options. */
function bindingFamilyCategoryIds(binding, family) {
  const detail = optionsFor(binding);
  if (!detail) return [];
  return detail.options.filter((option) => option.availability === "edit" && !option.requiresFieldSelection && categoryFamily(option) === family).map((option) => option.id);
}

/** WI-5.6: at save, a platform-neutral family id (a mixed selection's own choice) expands to each
 * connection's own ids; a literal id (the single-platform path, unchanged) passes through as is. */
function resolveEnabledCategoriesFor(binding, enabledCategories) {
  const resolved = new Set();
  for (const id of enabledCategories) {
    if (typeof id === "string" && id.startsWith("family:")) {
      for (const real of bindingFamilyCategoryIds(binding, id.slice("family:".length))) resolved.add(real);
    } else {
      resolved.add(id);
    }
  }
  return [...resolved];
}

function availableCategoriesForSelection() {
  const selected = selectedBindings();
  if (!selected.length) return new Set();
  // F10, WI-3.4: a requiresFieldSelection option grants nothing, so it is never selectable, and a
  // stale selection of one (saved before this rule existed) is dropped by reconcileSelectedCategories.
  return new Set(state.categories.filter((category) => category.availability === "edit" && !category.requiresFieldSelection && selected.every((binding) => supportsCategory(binding, category.id))).map((category) => category.id));
}

function reconcileSelectedCategories() {
  const available = availableCategoriesForSelection();
  state.selectedCategories = new Set([...state.selectedCategories].filter((id) => available.has(id)));
}

/** WI-4.5 (D2a): the routine bundles available for every selected course right now. */
function routineCategoryIds() {
  const available = availableCategoriesForSelection();
  return state.categories.filter((category) => category.routine === true && available.has(category.id)).map((category) => category.id);
}

function labelList(categories) {
  const labels = categories.map((category) => category.label);
  return labels.length > 6 ? `${labels.slice(0, 6).join(", ")}, and ${plural(labels.length - 6, "more action")}` : labels.join(", ");
}

function categoriesNeedingConfirmation() {
  return [...state.selectedCategories].map(categoryById)
    .filter((category) => category && (category.destructive === true || category.verification === "unchecked"));
}

function selectionSignature() {
  return JSON.stringify([selectedBindings().map((binding) => binding.sourceBindingId).sort(), [...state.selectedCategories].sort()]);
}

function confirmationDetailText(flagged) {
  const destructive = flagged.filter((category) => category.destructive === true);
  const uncheckable = flagged.filter((category) => category.verification === "unchecked");
  return [
    destructive.length ? `${plural(destructive.length, "selected action")} ${destructive.length === 1 ? "removes" : "remove"} course content: ${labelList(destructive)}.` : "",
    uncheckable.length ? `Morrow cannot check the saved result for ${plural(uncheckable.length, "selected action")}: ${labelList(uncheckable)}. Morrow reports those results as unconfirmed.` : "",
    "Save Edit access anyway, or keep reviewing to change the selection.",
  ].filter(Boolean).join(" ");
}

// Every failure the service worker answers carries its own code, and this page keeps that code as
// the error it raises, so showError can name the state and the next action.
async function request(type, fields = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...fields });
  if (!response?.ok) throw new Error(response?.code || response?.error || "edit_policy_failed");
  return response.result;
}

// The page has one polite status region. Every announcement goes through it, so a screen reader
// hears one short line instead of a re-read of the whole course list.
function announce(message) {
  const text = String(message || "");
  if (announcement.textContent === text) return;
  announcement.textContent = text;
}

function showNotice(message) {
  notice.hidden = false;
  notice.textContent = message;
  announce(message);
}

function clearNotice() {
  notice.hidden = true;
  notice.textContent = "";
}

// One code becomes what happened, why, and the one next action, from
// connector/extension/src/bridge-problem-copy.js. A code that file does not explain still reaches
// this page with its own state name in it. Work that finished before the failure is stated first,
// so a person reads what was saved as well as what stopped.
//
// Every action reads the course state again when it ends, and Morrow Bridge writes storage while an
// action runs, which reads it again too. A read of the course state or of a course's actions that
// succeeds says nothing about an action, or about a list of available courses (read again only when
// the person selects Refresh connected courses), so it clears only an error such a read raised. The
// popup's nextError keeps the same rule. A new action clears any error.
let errorSource = null;

function showError(cause, { prefix = "", source = "action" } = {}) {
  errorSource = source;
  error.hidden = false;
  error.textContent = `${prefix}${problemText(problemCode(cause))}`;
}

function clearError() {
  errorSource = null;
  error.hidden = true;
  error.textContent = "";
}

function clearReadError() {
  if (errorSource === "read") clearError();
}

function categoryFlags(category) {
  const flags = [
    ...(category.destructive === true ? ["Removes content"] : []),
    ...(CATEGORY_COURSE_REACH[category.id] ? ["Can change other courses"] : []),
    ...(category.verification === "unchecked" ? ["Saved result not checked"] : []),
  ];
  return flags.length ? `<span class="action-flags">${flags.map((flag) => `<span class="action-flag">${escapeHtml(flag)}</span>`).join("")}</span>` : "";
}

function verificationNote(category) {
  return category.verification === "unchecked"
    ? ` ${category.verificationReason || "Morrow cannot check this change after it is saved. Morrow reports the saved result as unconfirmed."}`
    : "";
}

/** F10, WI-3.4: the tool name a generated single-action id carries, or "" for a curated bundle id. */
function fieldSelectionTool(category) {
  const match = /^action:(?:canvas|moodle):(.+)$/.exec(category.id);
  return match ? match[1] : "";
}

/** WI-3.4: an option that grants nothing alone (F10) names the bundle that can change it instead. */
function fieldSelectionText(category) {
  const bundles = (FIELD_SELECTION_BUNDLES[fieldSelectionTool(category)] || [])
    .map((id) => categoryById(id))
    .filter(Boolean);
  return bundles.length
    ? `Morrow can change this only through a bundle: ${labelList(bundles)}.`
    : "Morrow always asks before this change.";
}

/** WI-5.5: a generated single action's id always starts with "action:<provider>:" (operationSpec in
 * src/edit-policy.js); a curated bundle id never does. Only a generated action nests under "All
 * other actions" (WI-5.5's Level 3 order: bundles first). */
function categoryIsGenerated(category) {
  return typeof category?.id === "string" && category.id.startsWith("action:");
}

/** WI-5.5's Level 2. A generated action's own `kind` (edit, publish or remove) wins when present;
 * a curated bundle carries none, so its kind is `destructive` alone, since no curated bundle
 * publishes or removes by itself (D2a: a routine bundle only changes what exists). */
function categoryKind(category) {
  if (category.kind === "edit" || category.kind === "publish" || category.kind === "remove") return category.kind;
  return category.destructive === true ? "remove" : "edit";
}

/** WI-5.5: the ids a "select all" checkbox can actually add or remove. A requiresFieldSelection
 * option (F10) never gets a checkbox at any level, so it is never part of a count's denominator. */
function customizeSelectableIds(categories) {
  return categories.filter((category) => !category.requiresFieldSelection).map((category) => category.id);
}

/** WI-5.5: state.categories, filtered by the search field and "Only actions Morrow can check", to
 * edit-available options only. Shared by the picker and by every count in it, so a filtered-out
 * action cannot be selected by a "select all" it is hidden from. */
function customizeCategories() {
  const query = state.actionFilter.trim().toLocaleLowerCase();
  return state.categories.filter((category) => category.availability === "edit"
    && (!state.actionCheckedOnly || category.verification === "checked")
    && (!query || category.label.toLocaleLowerCase().includes(query)));
}

/** WI-5.5: the area a category renders under. A category with no area, or one AREA_ORDER does not
 * name (WI-3.1's own valid-area set still allows "other"), lands in "other" rather than vanishing. */
function categoryAreaId(category) {
  return typeof category.area === "string" && AREA_ORDER.includes(category.area) ? category.area : "other";
}

function customizeAreaItems(areaId) {
  return customizeCategories().filter((category) => categoryAreaId(category) === areaId);
}

function customizeKindsForArea(areaId) {
  const items = customizeAreaItems(areaId);
  return KIND_ORDER.filter((kind) => items.some((category) => categoryKind(category) === kind));
}

function renderCustomizeAction(category, available) {
  const inputId = `customize-action-${category.id}`;
  const descriptionId = `${inputId}-description`;
  // F10, WI-3.4: this option's grant would be empty, so it never gets an active checkbox.
  if (category.requiresFieldSelection) {
    return `<article class="category-option field-selection" aria-describedby="${escapeHtml(descriptionId)}">
      <span><strong>${escapeHtml(category.label)}</strong>${categoryFlags(category)}<small id="${escapeHtml(descriptionId)}">${escapeHtml(category.description)} ${escapeHtml(fieldSelectionText(category))}</small></span>
    </article>`;
  }
  const isAvailable = available.has(category.id);
  const unavailable = isAvailable ? "" : " Not available for every selected course.";
  return `<label class="category-option" for="${escapeHtml(inputId)}">
    <input id="${escapeHtml(inputId)}" class="customize-action-input" type="checkbox" value="${escapeHtml(category.id)}" aria-describedby="${escapeHtml(descriptionId)}" ${state.selectedCategories.has(category.id) ? "checked" : ""} ${isAvailable ? "" : "disabled"}>
    <span><strong>${escapeHtml(category.label)}</strong>${categoryFlags(category)}<small id="${escapeHtml(descriptionId)}">${escapeHtml(category.description)}${escapeHtml(verificationNote(category))}${unavailable}</small></span>
  </label>`;
}

/** WI-5.5 Level 3: bundles first (curated ids, always shown), then "All other actions" (the
 * generated options, closed by default; open when search or "checked only" is filtering). */
function renderKind(areaId, kind, filtering, available) {
  const items = customizeAreaItems(areaId).filter((category) => categoryKind(category) === kind);
  const bundles = items.filter((category) => !categoryIsGenerated(category));
  const generated = items.filter((category) => categoryIsGenerated(category));
  const selectableIds = customizeSelectableIds(items);
  const on = selectableIds.filter((id) => state.selectedCategories.has(id)).length;
  const key = `${areaId}/${kind}`;
  const domKey = key.replace("/", "-");
  const kindOpen = filtering || state.openKinds.has(key);
  const bundlesHtml = bundles.map((category) => renderCustomizeAction(category, available)).join("");
  const generatedHtml = generated.length ? `
      <details class="category-directory customize-more" ${filtering ? "open" : ""}>
        <summary>All other actions<span>${plural(generated.length, "action")}</span></summary>
        <div class="category-options">${generated.map((category) => renderCustomizeAction(category, available)).join("")}</div>
      </details>` : "";
  return `
    <div class="customize-kind ${kind === "remove" ? "is-remove" : ""}" data-kind="${escapeHtml(key)}">
      <div class="customize-kind-head">
        <input type="checkbox" id="kind-select-${escapeHtml(domKey)}" data-kind-select="${escapeHtml(key)}" aria-label="Select all: ${escapeHtml(KIND_LABELS[kind])} in ${escapeHtml(AREA_LABELS[areaId])}">
        <button type="button" class="customize-kind-toggle" data-kind-toggle="${escapeHtml(key)}" aria-expanded="${kindOpen}" aria-controls="kind-body-${escapeHtml(domKey)}">
          <span class="customize-kind-title">${escapeHtml(KIND_LABELS[kind])}</span>
          <span class="customize-kind-count" data-kind-count="${escapeHtml(key)}">${on} of ${selectableIds.length}</span>
        </button>
      </div>
      <div class="customize-kind-body" id="kind-body-${escapeHtml(domKey)}">${kindOpen ? `<div class="category-options">${bundlesHtml}</div>${generatedHtml}` : ""}</div>
    </div>
  `;
}

/** WI-5.5 Level 1, D6: the area's own "select all" (data-area-select) never includes the "remove"
 * kind. Removal gets its own count and its own checkbox, one level down, in the "remove" kind. */
function renderArea(areaId, filtering, available) {
  const items = customizeAreaItems(areaId);
  const kinds = customizeKindsForArea(areaId);
  const nonRemoveIds = customizeSelectableIds(items.filter((category) => categoryKind(category) !== "remove"));
  const on = nonRemoveIds.filter((id) => state.selectedCategories.has(id)).length;
  const removeIds = customizeSelectableIds(items.filter((category) => categoryKind(category) === "remove"));
  const removeOn = removeIds.filter((id) => state.selectedCategories.has(id)).length;
  const areaOpen = filtering || state.openAreas.has(areaId);
  return `
    <div class="customize-area" data-area="${escapeHtml(areaId)}">
      <div class="customize-area-head">
        <input type="checkbox" id="area-select-${escapeHtml(areaId)}" data-area-select="${escapeHtml(areaId)}" aria-label="Select all in ${escapeHtml(AREA_LABELS[areaId])}, except removal">
        <button type="button" class="customize-area-toggle" data-area-toggle="${escapeHtml(areaId)}" aria-expanded="${areaOpen}" aria-controls="area-body-${escapeHtml(areaId)}">
          <span class="customize-area-title">${escapeHtml(AREA_LABELS[areaId])}</span>
        </button>
        <span class="customize-area-counts">
          <span class="customize-count" data-area-count="${escapeHtml(areaId)}">${on} of ${nonRemoveIds.length}</span>
          ${removeIds.length ? `<span class="customize-removal-pill ${removeOn ? "on" : ""}" data-area-removal="${escapeHtml(areaId)}">${removeOn ? `Removal ${removeOn} of ${removeIds.length}` : "Removal off"}</span>` : ""}
        </span>
      </div>
      <div class="customize-area-body" id="area-body-${escapeHtml(areaId)}">${areaOpen ? kinds.map((kind) => renderKind(areaId, kind, filtering, available)).join("") : ""}</div>
    </div>
  `;
}

/** WI-5.5: "Review-only options. Not in the picker." A read-only, always-available disclosure
 * lists them by name instead. */
function renderReviewOnlyLine() {
  const items = state.categories.filter((category) => category.availability === "review");
  if (!items.length) return "";
  const sorted = [...items].sort((left, right) => left.label.localeCompare(right.label));
  return `
    <details class="review-only-line">
      <summary>${plural(items.length, "action")} always ${items.length === 1 ? "waits" : "wait"} for your review</summary>
      <ul>${sorted.map((category) => `<li><strong>${escapeHtml(category.label)}</strong><span>${escapeHtml(category.reviewReason || "")}</span></li>`).join("")}</ul>
    </details>
  `;
}

/** WI-5.5: sets every area/kind "select all" checkbox's checked, indeterminate and aria-checked,
 * and its count text, from state.selectedCategories alone. Called after a full render, and after an
 * in-place checkbox update, so both paths compute the same tri-state the same way. Touches no
 * innerHTML: the "no second render on a checkbox change" rule (WI-5.5) depends on that. */
function syncCustomizeTriStates() {
  for (const box of categoryList.querySelectorAll("[data-area-select]")) {
    const areaId = box.dataset.areaSelect;
    const items = customizeAreaItems(areaId);
    const nonRemoveIds = customizeSelectableIds(items.filter((category) => categoryKind(category) !== "remove"));
    const on = nonRemoveIds.filter((id) => state.selectedCategories.has(id)).length;
    box.checked = nonRemoveIds.length > 0 && on === nonRemoveIds.length;
    box.indeterminate = on > 0 && on < nonRemoveIds.length;
    box.setAttribute("aria-checked", box.indeterminate ? "mixed" : String(box.checked));
    box.disabled = nonRemoveIds.length === 0;
    const countEl = categoryList.querySelector(`[data-area-count="${areaId}"]`);
    if (countEl) countEl.textContent = `${on} of ${nonRemoveIds.length}`;
    const removeIds = customizeSelectableIds(items.filter((category) => categoryKind(category) === "remove"));
    const removeOn = removeIds.filter((id) => state.selectedCategories.has(id)).length;
    const pill = categoryList.querySelector(`[data-area-removal="${areaId}"]`);
    if (pill) {
      pill.classList.toggle("on", removeOn > 0);
      pill.textContent = removeOn > 0 ? `Removal ${removeOn} of ${removeIds.length}` : "Removal off";
    }
  }
  for (const box of categoryList.querySelectorAll("[data-kind-select]")) {
    const key = box.dataset.kindSelect;
    const [areaId, kind] = key.split("/");
    const ids = customizeSelectableIds(customizeAreaItems(areaId).filter((category) => categoryKind(category) === kind));
    const on = ids.filter((id) => state.selectedCategories.has(id)).length;
    box.checked = ids.length > 0 && on === ids.length;
    box.indeterminate = on > 0 && on < ids.length;
    box.setAttribute("aria-checked", box.indeterminate ? "mixed" : String(box.checked));
    box.disabled = ids.length === 0;
    const countEl = categoryList.querySelector(`[data-kind-count="${key}"]`);
    if (countEl) countEl.textContent = `${on} of ${ids.length}`;
  }
}

function renderCustomize() {
  const available = availableCategoriesForSelection();
  const hasSelectedCourses = selectedBindings().length > 0;
  if (!hasSelectedCourses) {
    categoryList.innerHTML = '<p class="state-message">Select a course to read its available Edit and Review-only actions.</p>';
    return;
  }
  if (selectedBindingsNeedSite()) {
    categoryList.innerHTML = '<p class="state-message">Open each selected course in Canvas or Moodle, then refresh this page before you choose Edit.</p>';
    return;
  }
  if (state.optionsLoading) {
    categoryList.innerHTML = '<p class="state-message">Reading the current individual actions for the selected courses…</p>';
    return;
  }
  // WI-5.5: search matches labels, hides areas with no match, and opens areas (and their kinds) with
  // a match; "Only actions Morrow can check" filters the same way.
  const filtering = Boolean(state.actionFilter.trim()) || state.actionCheckedOnly;
  const areas = AREA_ORDER.filter((areaId) => customizeAreaItems(areaId).length > 0);
  if (!areas.length) {
    categoryList.innerHTML = `<p class="state-message">${state.actionFilter.trim()
      ? "No individual action matches this search."
      : state.actionCheckedOnly
        ? "The selected courses have no action Morrow can check after it is saved."
        : "These courses share no Edit action. Select fewer courses, then choose Edit."}</p>`;
    return;
  }
  categoryList.innerHTML = renderReviewOnlyLine() + areas.map((areaId) => renderArea(areaId, filtering, available)).join("");
  syncCustomizeTriStates();
}

/** WI-1.1: the course is otherwise usable, but its saved Canvas or Moodle tab is not open. A saved
 * grant that lapsed or no longer matches the action list says nothing about the tab. */
function siteClosed(binding) {
  return isEligible(binding) && binding.runtimeVerified !== true;
}

/** WI-5.1, WI-3.3: every curated category id that is routine, grouped by provider (a static list,
 * independent of any one course's live options, so the row's D7 text needs no extra fetch). */
const ROUTINE_CATEGORY_IDS_BY_PROVIDER = CURATED_CATEGORY_SPECS.filter((spec) => spec.routine === true)
  .reduce((byProvider, spec) => {
    (byProvider[spec.provider] ||= []).push(spec.id);
    return byProvider;
  }, {});

/** D7: the row's own state text. It reads only the saved summary (binding.editPermission), so a
 * row needs no per-course options fetch to show it. */
function courseStateText(binding) {
  const ids = Array.isArray(binding?.editPermission?.enabledCategories) ? binding.editPermission.enabledCategories.filter((id) => typeof id === "string") : [];
  if (!ids.length || permissionHasExpired(binding) || isStale(binding)) return "Plan. Asks first.";
  const routineIds = ROUTINE_CATEGORY_IDS_BY_PROVIDER[binding.provider] || [];
  const isRoutine = routineIds.length > 0 && ids.length === routineIds.length && routineIds.every((id) => ids.includes(id));
  if (isRoutine) return "Edit. Routine edits.";
  if (ids.length === 1) return "Edit. 1 kind of edit.";
  return "Edit. Custom.";
}

/** WI-5.4: "plan" | "routine" | "custom", for the detail's Plan/Edit control and its third "Custom"
 * chip (shown only for "custom": the saved list is not a level). Reads only the saved summary
 * (binding.editPermission), the same source courseStateText (D7) reads, so opening a course's
 * detail needs no options fetch to show its current level. */
function courseLevel(binding) {
  const ids = Array.isArray(binding?.editPermission?.enabledCategories) ? binding.editPermission.enabledCategories.filter((id) => typeof id === "string") : [];
  if (!ids.length || permissionHasExpired(binding) || isStale(binding)) return "plan";
  const routineIds = ROUTINE_CATEGORY_IDS_BY_PROVIDER[binding.provider] || [];
  const isRoutine = routineIds.length > 0 && ids.length === routineIds.length && routineIds.every((id) => ids.includes(id));
  return isRoutine ? "routine" : "custom";
}

const CURATED_LABEL_BY_ID = new Map(CURATED_CATEGORY_SPECS.map((spec) => [spec.id, spec.label]));

/** WI-5.4: a category's label for the detail's allowed list. `categoryById` needs this course's
 * live options (only fetched for a selected course); the curated table gives a real label with no
 * fetch for a routine or "do not ask again" id, which is what the detail shows without one. */
function categoryLabelFor(id) {
  return categoryById(id)?.label || CURATED_LABEL_BY_ID.get(id) || id;
}

function courseDetailDomId(sourceBindingId) {
  return `course-detail-${String(sourceBindingId).replace(/[^A-Za-z0-9_-]/g, "-")}`;
}

/** WI-1.1, WI-5.3: the reason a "Needs attention" row needs a button instead of the D7 text. */
function attentionRowNote(binding) {
  if (!isEligible(binding)) return "Morrow cannot identify this course. Open it in Canvas or Moodle and select Connect this course in the Morrow Bridge popup.";
  if (siteClosed(binding)) return `${providerName(binding)} is closed. Morrow Bridge can open it for you.`;
  return "";
}

function courseSelectionAccessibleName(binding, action = "Select") {
  const provider = providerName(binding);
  const name = courseName(binding);
  const courseId = nativeCourseId(binding.courseId) || "unavailable";
  return `${action} ${provider} course ${name} (course ID ${courseId})`;
}

function rowMetaLine(row) {
  return [row.code, row.term, row.platform, row.role].filter(Boolean).join(" · ");
}

/** WI-5.3: a connected row's name, meta line, and either its D7 state text or (for "Needs
 * attention") an action button; a "Not connected" row's name, meta line, and a "Connect" button. */
function renderCourseRow(row) {
  const favorite = row.favorite ? `<span class="course-fav" aria-hidden="true" title="Favorite in ${escapeHtml(row.platform)}">★</span>` : "";
  const nameHtml = `<div class="course-row-name">${favorite}${escapeHtml(row.name)}</div><div class="course-row-meta">${escapeHtml(rowMetaLine(row))}</div>`;
  if (row.kind === "available") {
    return `
      <div class="course-row is-static" data-row-kind="available">
        <div class="course-row-body">${nameHtml}</div>
        <span class="course-row-action"><button class="secondary" type="button" data-connect-row="${escapeHtml(courseMetaKey(row.course.origin, row.course.courseId))}" aria-label="Connect ${escapeHtml(row.platform)} course ${escapeHtml(row.name)}" ${state.busy ? "disabled" : ""}>Connect</button></span>
      </div>
    `;
  }
  const binding = row.binding;
  if (row.scope === "attention") {
    const note = attentionRowNote(binding);
    const closed = siteClosed(binding);
    return `
      <div class="course-row is-static" data-row-kind="attention">
        <div class="course-row-body">${nameHtml}${note ? `<div class="course-row-meta course-row-note">${escapeHtml(note)}</div>` : ""}</div>
        <span class="course-row-action">${closed
          ? `<button class="secondary" type="button" data-open-platform="${escapeHtml(binding.sourceBindingId || "")}" ${state.openPlatformBusy ? 'disabled aria-busy="true"' : ""}>${escapeHtml(openPlatformLabel(binding, state.openPlatformProgressVisible))}</button>`
          : ""}</span>
      </div>
    `;
  }
  const selected = state.selected.has(binding.sourceBindingId);
  const onEdit = courseStateText(binding) !== "Plan. Asks first.";
  const box = state.selectMode
    ? `<input class="course-select" type="checkbox" aria-label="${escapeHtml(courseSelectionAccessibleName(binding))}" ${selected ? "checked" : ""}>`
    : "";
  const isOpen = state.openCourses.has(binding.sourceBindingId);
  const detailId = courseDetailDomId(binding.sourceBindingId);
  return `
    <div class="course-row ${state.selectMode ? "in-select-mode" : ""} ${selected ? "is-selected" : ""}" data-binding-id="${escapeHtml(binding.sourceBindingId || "")}" data-row-kind="connected">
      ${box}
      <div class="course-row-body"><button type="button" class="course-row-name-button" data-toggle-course="${escapeHtml(binding.sourceBindingId)}" aria-expanded="${isOpen}" aria-controls="${escapeHtml(detailId)}">${nameHtml}</button></div>
      <span class="course-row-state ${onEdit ? "on" : ""}">${escapeHtml(courseStateText(binding))}</span>
    </div>
    ${renderCourseDetail(binding, isOpen)}
  `;
}

/**
 * WI-5.4: the course detail, opened in place under a connected row (WI-5.4: "Opens in place under
 * the row"). Always present in the DOM as a `.morrow-panel` (WI-F.7: a course detail opening is one
 * of the five named motion places), so the row's aria-controls always names a real element; its
 * content is built only while open.
 */
function renderCourseDetail(binding, isOpen) {
  const detailId = courseDetailDomId(binding.sourceBindingId);
  if (!isOpen) return `<div class="course-detail morrow-panel" id="${escapeHtml(detailId)}"></div>`;
  const level = courseLevel(binding);
  const ids = level === "plan" ? [] : (Array.isArray(binding?.editPermission?.enabledCategories) ? binding.editPermission.enabledCategories.filter((value) => typeof value === "string") : []);
  const lead = level === "routine"
    ? `Morrow makes the routine edits below without another approval until you choose Plan. ${routineAsks([binding.provider])}`
    : level === "custom"
      ? "Morrow makes the changes you selected in Customize until you choose Plan. It asks before every other change."
      : "Morrow asks before each change. To skip the review for all routine edits, choose “Edit. Routine edits.” above. To choose single kinds of edit, select Customize, or use “do not ask again” on a review.";
  const listHtml = ids.length ? `<div class="routine-bundle-list">${ids.map((id) => `
    <div class="routine-bundle-item">
      <span>${escapeHtml(categoryLabelFor(id))}</span>
      <button type="button" class="secondary" data-remove-category="${escapeHtml(id)}" aria-label="${escapeHtml(courseSelectionAccessibleName(binding, `Remove ${categoryLabelFor(id)} from`))}" ${state.busy ? "disabled" : ""}>Remove</button>
    </div>`).join("")}</div>` : "";
  return `
    <div class="course-detail morrow-panel is-open" id="${escapeHtml(detailId)}" data-binding-id="${escapeHtml(binding.sourceBindingId)}">
      <div class="course-detail-top">
        <div class="course-level-control" role="group" aria-label="Level for ${escapeHtml(courseName(binding))}">
          <button type="button" class="secondary" data-set-level="plan" aria-pressed="${level === "plan"}" ${state.busy ? "disabled" : ""}>Plan. Morrow asks first.</button>
          <button type="button" class="secondary" data-set-level="routine" aria-pressed="${level === "routine"}" ${state.busy ? "disabled" : ""}>Edit. Routine edits.</button>
          ${level === "custom" ? `<button type="button" class="secondary" aria-pressed="true" data-open-customize="1">Custom</button>` : ""}
        </div>
      </div>
      <p class="field-help">${lead}</p>
      ${listHtml}
      <div class="course-detail-links">
        <button type="button" class="secondary" data-open-customize="1">Customize</button>
        <button type="button" class="secondary danger-action" data-disconnect="1" aria-label="${escapeHtml(courseSelectionAccessibleName(binding, "Disconnect"))}" ${state.busy ? "disabled" : ""}>Disconnect</button>
      </div>
      ${state.confirmingDisconnect === binding.sourceBindingId ? `
      <div class="course-disconnect-confirm" role="group" aria-label="Confirm disconnecting ${escapeHtml(courseName(binding))}">
        <p>Disconnect ${escapeHtml(courseName(binding))}? Morrow stops reading and changing this course, and its Edit access is removed. Your course in ${escapeHtml(providerName(binding))} is not changed. You can connect it again from this list.</p>
        <div class="action-buttons">
          <button type="button" class="secondary" data-disconnect-cancel="1" aria-label="${escapeHtml(courseSelectionAccessibleName(binding, "Keep"))} connected" ${state.busy ? "disabled" : ""}>Keep course</button>
          <button type="button" class="secondary danger-action" data-disconnect-confirm="1" aria-label="${escapeHtml(courseSelectionAccessibleName(binding, "Confirm disconnect"))}" ${state.busy ? "disabled" : ""}>Disconnect this course</button>
        </div>
      </div>` : ""}
    </div>
  `;
}

function renderCourseToolbar(rows) {
  const total = rows.length;
  const showExtras = total > FEW_COURSES_THRESHOLD;
  const platforms = distinctValues(rows, "platform");
  const terms = distinctValues(rows, "term");
  coursePlatformField.hidden = !showExtras || platforms.length <= 1;
  courseTermField.hidden = !showExtras || terms.length <= 1;
  courseScopeTabs.hidden = !showExtras;
  if (!coursePlatformField.hidden) {
    const current = coursePlatformFilter.value || "all";
    coursePlatformFilter.innerHTML = `<option value="all">All platforms</option>${platforms.map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join("")}`;
    coursePlatformFilter.value = platforms.includes(current) ? current : "all";
    state.filters.platform = coursePlatformFilter.value;
  }
  if (!courseTermField.hidden) {
    const current = courseTermFilter.value || "all";
    courseTermFilter.innerHTML = `<option value="all">All terms</option>${terms.map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join("")}`;
    courseTermFilter.value = terms.includes(current) ? current : "all";
    state.filters.term = courseTermFilter.value;
  }
  if (courseScopeTabs.hidden) return;
  const counts = scopeCounts(rows);
  courseScopeTabs.innerHTML = SCOPES.map(([id, label]) => `<button type="button" class="secondary" id="course-scope-${id}" data-scope="${id}" aria-pressed="${state.filters.scope === id}">${escapeHtml(label)}<small>${counts[id]}</small></button>`).join("");
}

function renderCourseBulkBar(rows) {
  const connectedSelected = rows.filter((row) => row.scope === "connected" && state.selected.has(row.binding.sourceBindingId));
  const show = state.selectMode && connectedSelected.length > 0;
  courseBulkBar.hidden = !show;
  if (!show) return;
  courseBulkCount.textContent = `${plural(connectedSelected.length, "course")} selected. Canvas and Moodle courses can be selected together.`;
  courseBulkPlanButton.disabled = state.busy;
  const routineAvailable = routineCategoryIds().length > 0;
  courseBulkRoutineButton.disabled = state.busy || !routineAvailable;
}

function renderCourseList(focus = courseFocusToRestore()) {
  const rows = courseRows();
  const connectedBindings = Array.isArray(state.status?.bindings) ? state.status.bindings : [];
  courseList.setAttribute("aria-busy", String(state.statusLoading || state.busy));
  renderCourseToolbar(rows);
  courseSelectModeButton.setAttribute("aria-pressed", String(state.selectMode));
  courseSelectModeButton.textContent = state.selectMode ? "Done" : "Select";
  courseSelectModeButton.disabled = state.busy || !rows.some((row) => row.scope === "connected");

  const matches = orderedMatches(rows);
  const limited = matches.slice(0, state.rowLimit);

  if (state.statusReadFailed) {
    courseList.innerHTML = '<p class="state-message">Connected courses were not checked. Select Refresh connected courses.</p>';
  } else if (!state.status) {
    // WI-F.10: three skeleton rows while the first read is outstanding, not a sentence.
    courseList.innerHTML = Array.from({ length: 3 }, () => '<div class="course-card-skeleton" aria-hidden="true"></div>').join("");
  } else if (!connectedBindings.length && !rows.length) {
    // WI-F.10: one composed empty message, plus the WI-1.1 open-platform action once a site is saved.
    // With no saved site, Morrow Bridge has no Chrome access to any course tab, so the message names
    // the popup step that grants it.
    const anchor = savedAnchor();
    courseList.innerHTML = anchor
      ? `<div class="course-list-empty state-message">
          <p>Open a course in Canvas or Moodle. Morrow Bridge finds it.</p>
          <button id="open-platform-empty" type="button" ${state.openPlatformBusy ? 'disabled aria-busy="true"' : ""}>${escapeHtml(openPlatformLabel(anchor, state.openPlatformProgressVisible))}</button>
        </div>`
      : '<p class="state-message">Open a signed-in Canvas or Moodle course in Chrome. Then open the Morrow Bridge popup, select Connect this course, and allow access when Chrome asks.</p>';
  } else if (!limited.length) {
    courseList.innerHTML = state.filters.q.trim() || state.filters.platform !== "all" || state.filters.term !== "all" || state.filters.scope !== "all"
      ? `<p class="state-message">No course matches this search or filter. Clear it to view every course in this list.</p>`
      : '<p class="state-message">No course is connected yet.</p>';
  } else {
    let html = "";
    let lastScope = null;
    const headings = { attention: "Needs attention", connected: "Connected", available: "Not connected" };
    for (const row of limited) {
      if (row.scope !== lastScope) {
        lastScope = row.scope;
        const sectionCount = matches.filter((candidate) => candidate.scope === row.scope).length;
        html += `<div class="listhead">${escapeHtml(headings[row.scope])} · ${sectionCount}</div>`;
      }
      html += renderCourseRow(row);
    }
    courseList.innerHTML = html;
  }

  courseShowMoreRow.hidden = matches.length <= limited.length;
  courseShowMoreButton.textContent = `Show more (${plural(matches.length - limited.length, "more course")})`;

  const showDiscoveryMore = [...state.discoveries.values()].some((discovery) => discovery.complete === false);
  discoveryMoreRow.hidden = !showDiscoveryMore;
  discoveryMoreButton.disabled = state.busy;

  const ready = connectedBindings.filter((binding) => isEligible(binding) && binding.runtimeVerified === true);
  const max = Number.isInteger(state.status?.bindingLimit) ? state.status.bindingLimit : 500;
  if (state.statusReadFailed) {
    connectionStatus.textContent = "Connected courses were not checked.";
  } else if (!state.status) {
    connectionStatus.textContent = "Checking your connected learning platforms…";
  } else if (!connectedBindings.length) {
    connectionStatus.textContent = "No course is connected yet.";
  } else if (connectedBindings.length >= max) {
    connectionStatus.textContent = `The connector returned ${plural(connectedBindings.length, "connected course")}, which is the ${max}-course settings limit. Disconnect a course before adding another.`;
  } else {
    const needsSite = connectedBindings.length - ready.length;
    connectionStatus.textContent = needsSite
      ? `${plural(ready.length, "connected course")} ${ready.length === 1 ? "is" : "are"} ready to use. ${plural(needsSite, "saved course")} ${needsSite === 1 ? "needs" : "need"} an open course tab or a reconnected site.`
      : `${plural(ready.length, "connected course")} ${ready.length === 1 ? "is" : "are"} ready to use.`;
  }

  // The visible notice owns the status region while it shows, so an action result is not replaced
  // by the list summary that follows it.
  if (notice.hidden) {
    const filtered = state.filters.q.trim() || state.filters.platform !== "all" || state.filters.term !== "all" || state.filters.scope !== "all";
    announce(!state.status ? "" : matches.length
      ? `${filtered ? "Search matches " : ""}${plural(matches.length, "course")}.`
      : filtered ? "No course matches this search or filter." : "No course is connected yet.");
  }

  renderCourseBulkBar(rows);
  restoreCourseFocus(focus);
}

/** WI-4.5 (D2, P2): the switch and its always-visible, never-disclosed list of included bundles. */
function renderRoutineSwitch(showEditStage) {
  const ids = routineCategoryIds();
  const canOffer = showEditStage && ids.length > 0;
  if (!canOffer && state.routineMode) state.routineMode = false;
  routineSwitchContainer.hidden = !canOffer;
  routineSwitch.disabled = state.busy || !canOffer;
  routineSwitch.checked = state.routineMode;
  if (canOffer) routineSwitchSummary.textContent = routineSummary(selectedBindings().map((binding) => binding.provider));
  const bundles = state.routineMode
    ? [...state.selectedCategories].map(categoryById).filter((category) => category && category.routine === true)
      .sort((left, right) => left.label.localeCompare(right.label))
    : [];
  routineBundleList.innerHTML = bundles.map((category) => `
    <div class="routine-bundle-item">
      <span>${escapeHtml(category.label)}</span>
      <button type="button" class="secondary" data-remove-routine="${escapeHtml(category.id)}" aria-label="${escapeHtml(`Remove ${category.label} from routine edits`)}" ${state.busy ? "disabled" : ""}>Remove</button>
    </div>
  `).join("");
  // WI-4.5: the switch replaces manual Customize browsing while it is engaged, so the two ways to
  // choose the same underlying selection are never shown at once.
  categoryList.hidden = state.routineMode;
  actionFilterField.hidden = state.routineMode;
  actionCheckedOnlyField.hidden = state.routineMode;
}

/** WI-5.5: the Customize view's summary bar sentence, "N actions in N areas, no removal (or "K
 * remove content"), N courses". Always visible above "Review and save", so it states the grant in
 * one sentence before a person saves it. */
function renderSummaryBar(selected, ids) {
  const categories = ids.map(categoryById).filter(Boolean);
  const areas = new Set(categories.map((category) => categoryAreaId(category)));
  const removals = categories.filter((category) => categoryKind(category) === "remove").length;
  return `${plural(categories.length, "action")} in ${plural(areas.size, "area")}, ${removals ? `${plural(removals, "action")} remove content` : "no removal"}, ${plural(selected.length, "course")}`;
}

/** WI-5.2: the Course access panel sits between "Your courses" and "Browser permissions and
 * rules" only while a Customize flow is actually active (a bulk selection made, or a row's
 * "Customize"/"Custom" chip clicked, both of which populate state.selected). At rest, with no
 * course selected, the page's order is exactly banner, Your courses, Browser permissions and
 * rules, Private Chat. */
function renderSelection() {
  const selected = selectedBindings();
  modePanel.hidden = !selected.length;
  const needsSite = selectedBindingsNeedSite(selected);
  if (needsSite && state.mode === "edit") {
    state.mode = "plan";
    state.pendingSaveConfirmation = false;
    state.selectedCategories.clear();
    modePlan.checked = true;
    modeEdit.checked = false;
  }
  const categoriesSelected = state.selectedCategories.size;
  const availableCategories = availableCategoriesForSelection();
  const showEditStage = state.mode === "edit" && selected.length > 0 && !needsSite;
  categoryFieldset.hidden = !showEditStage;
  categoryFieldset.disabled = state.busy || !showEditStage;
  renderRoutineSwitch(showEditStage);
  selectionSummary.textContent = state.statusReadFailed
    ? "Course access was not checked. Select Refresh connected courses."
    : !state.status
      ? "Loading connected courses…"
    : !selected.length
      ? "No course selected. Select a course above, then choose Plan or Edit."
      : needsSite
        ? `${plural(selected.length, "course")} selected. Open every selected learning platform in Chrome before you choose Edit.`
      : state.mode === "plan"
        ? `${plural(selected.length, "course")} selected. Plan keeps changes ready for your review.`
        : !availableCategories.size
          ? `${plural(selected.length, "course")} selected. These courses share no Edit action.`
          : !categoriesSelected
            ? `${plural(selected.length, "course")} selected. Choose at least one change before you save Edit.`
            : renderSummaryBar(selected, [...state.selectedCategories]);
  editStageHint.hidden = showEditStage;
  editStageHint.textContent = !selected.length
    ? "Select courses, then choose Edit to review the available actions."
    : needsSite
      ? "Open each selected course in Canvas or Moodle, then refresh this page before you choose Edit."
    : "Choose Edit to review and select the actions Morrow may apply.";
  permissionActions.hidden = !selected.length;
  modePlan.disabled = state.busy || !selected.length;
  modeEdit.disabled = state.busy || !selected.length || needsSite;
  returnPlanButton.hidden = false;
  saveEditButton.hidden = state.mode !== "edit";
  returnPlanButton.disabled = state.busy || !selected.length;
  const flagged = categoriesNeedingConfirmation();
  const confirming = showEditStage && state.pendingSaveConfirmation && flagged.length > 0;
  const wasConfirming = !saveConfirmation.hidden;
  saveConfirmation.hidden = !confirming;
  if (confirming) {
    saveConfirmationDetail.textContent = confirmationDetailText(flagged);
    if (!wasConfirming) cancelSaveButton.focus();
  }
  confirmSaveButton.disabled = state.busy;
  cancelSaveButton.disabled = state.busy;
  saveEditButton.disabled = state.busy || confirming || !showEditStage || !categoriesSelected || !availableCategories.size;
  returnPlanButton.textContent = `Return ${plural(selected.length, "selected course")} to Plan`;
  // WI-5.5: the summary bar's own button. The progress label from saveEditAccess (WI-F.10, "Saving N
  // of N courses") still takes over once a save runs long enough to need it.
  saveEditButton.textContent = state.saveProgressText || (showEditStage ? "Review and save" : "Save Edit access");
  actionHelp.textContent = needsSite
    ? "Open each selected course in Canvas or Moodle, then refresh this page before you choose Edit."
    : state.mode === "plan"
    ? "To remove any saved Edit access, return the selected courses to Plan."
    : !availableCategories.size
      ? "These courses share no Edit action. Select fewer courses, then choose Edit."
      : !categoriesSelected
        ? "Choose at least one action. Unchecked actions stay in Plan for your review."
        : "Morrow can apply only the checked actions in these courses until you return them to Plan. Save again if available actions change.";
}

function renderFileStorageAccess() {
  const access = state.fileStorageAccess;
  const effectiveAccess = access.enabled === true;
  const residualPermission = access.browserPermission === true && access.optedIn !== true;
  fileStorageStatus.textContent = access.checking
    ? "Checking Chrome permission…"
    : effectiveAccess
      ? "On. Morrow can read confirmed Canvas course files and transfer reviewed material."
      : access.externallyRevoked === true
        ? "Off. Chrome permission was removed, so Morrow keeps course file access off."
        : residualPermission
          ? "Off. Chrome has HTTPS access, but Morrow course file access stays off."
          : "Off. Morrow cannot access course file content.";
  enableFileStorageButton.hidden = effectiveAccess;
  enableFileStorageButton.textContent = residualPermission ? "Turn on course file access" : "Enable course file access";
  enableFileStorageButton.disabled = state.fileStorageBusy || access.checking === true;
  revokeFileStorageButton.hidden = access.browserPermission !== true;
  revokeFileStorageButton.disabled = state.fileStorageBusy || access.checking === true;
}

/** WI-5.1: reads the Bridge-only courseMeta map service-worker.js writes at discovery and connect. */
async function refreshCourseMeta() {
  try {
    const stored = await chrome.storage.local.get("courseMeta");
    const raw = stored.courseMeta;
    state.courseMeta = raw && typeof raw === "object" ? new Map(Object.entries(raw)) : new Map();
  } catch {
    state.courseMeta = new Map();
  }
}

/** WI-1.2 (D1a): the checkbox that reads and writes openPlatformWhenNeeded directly, with no save step. */
function renderOpenPlatformSetting() {
  openPlatformWhenNeededCheckbox.checked = state.openPlatformWhenNeeded;
  openPlatformWhenNeededCheckbox.disabled = state.openPlatformSettingBusy;
}

async function refreshOpenPlatformSetting() {
  try {
    const stored = await chrome.storage.local.get(OPEN_PLATFORM_WHEN_NEEDED_KEY);
    state.openPlatformWhenNeeded = stored[OPEN_PLATFORM_WHEN_NEEDED_KEY] !== false;
  } catch {
    state.openPlatformWhenNeeded = true;
  }
  renderOpenPlatformSetting();
}

async function setOpenPlatformWhenNeeded(value) {
  state.openPlatformSettingBusy = true;
  renderOpenPlatformSetting();
  try {
    await chrome.storage.local.set({ [OPEN_PLATFORM_WHEN_NEEDED_KEY]: value });
    state.openPlatformWhenNeeded = value;
  } catch {
    await refreshOpenPlatformSetting();
  } finally {
    state.openPlatformSettingBusy = false;
    renderOpenPlatformSetting();
  }
}

async function browserHasCourseFileStoragePermission() {
  return await chrome.permissions.contains({ origins: COURSE_FILE_STORAGE_ORIGINS });
}

async function refreshCourseFileStorageAccess() {
  try {
    const stored = await chrome.storage.local.get(COURSE_FILE_STORAGE_ACCESS_KEY);
    const optedIn = stored[COURSE_FILE_STORAGE_ACCESS_KEY] === true;
    const browserPermission = await browserHasCourseFileStoragePermission();
    const externallyRevoked = optedIn && !browserPermission;
    if (externallyRevoked) await chrome.storage.local.set({ [COURSE_FILE_STORAGE_ACCESS_KEY]: false });
    state.fileStorageAccess = { browserPermission, enabled: optedIn && browserPermission, optedIn: externallyRevoked ? false : optedIn, checking: false, ...(externallyRevoked ? { externallyRevoked: true } : {}) };
  } catch {
    state.fileStorageAccess = { browserPermission: false, enabled: false, optedIn: false, checking: false };
  }
  renderFileStorageAccess();
}

function setFileStorageBusy(value) {
  state.fileStorageBusy = value;
  renderFileStorageAccess();
}

async function enableCourseFileStorageAccess() {
  if (state.fileStorageBusy) return;
  clearError();
  clearNotice();
  setFileStorageBusy(true);
  try {
    const requested = await chrome.permissions.request({ origins: COURSE_FILE_STORAGE_ORIGINS });
    const browserPermission = requested === true && await browserHasCourseFileStoragePermission();
    await chrome.storage.local.set({ [COURSE_FILE_STORAGE_ACCESS_KEY]: browserPermission });
    showNotice(browserPermission
      ? "Course file access is on. Morrow will still use only files it confirms belong to selected Canvas courses."
      : "Course file access remains off. Chrome did not grant HTTPS file access.");
  } catch {
    await chrome.storage.local.set({ [COURSE_FILE_STORAGE_ACCESS_KEY]: false });
    showError("course_file_access_change_failed");
  } finally {
    setFileStorageBusy(false);
    await refreshCourseFileStorageAccess();
  }
}

async function revokeCourseFileStorageAccess() {
  if (state.fileStorageBusy) return;
  clearError();
  clearNotice();
  setFileStorageBusy(true);
  try {
    await chrome.permissions.remove({ origins: COURSE_FILE_STORAGE_ORIGINS });
    const browserPermission = await browserHasCourseFileStoragePermission();
    await chrome.storage.local.set({ [COURSE_FILE_STORAGE_ACCESS_KEY]: false });
    showNotice(browserPermission
      ? "Course file access is off. Chrome kept separate HTTPS access; existing Canvas connections remain available."
      : "Course file access and its optional HTTPS permission are off. Existing Canvas connections remain available.");
  } catch {
    await chrome.storage.local.set({ [COURSE_FILE_STORAGE_ACCESS_KEY]: false });
    showError("course_file_access_permission_remove_failed");
  } finally {
    setFileStorageBusy(false);
    await refreshCourseFileStorageAccess();
  }
}

/** WI-1.4: the "Ask first in all courses" banner, shown while any connection can act with no review. */
function renderEditBanner() {
  const bindings = activeEditBindings();
  editAccessBanner.hidden = bindings.length === 0;
  if (bindings.length) editAccessBannerText.textContent = `Morrow can make some changes with no review in ${plural(bindings.length, "course")}.`;
  askFirstAllCoursesButton.disabled = state.busy || bindings.length === 0;
}

function render(courseFocus = courseFocusToRestore()) {
  renderCustomize();
  renderCourseList(courseFocus);
  renderSelection();
  renderEditBanner();
  renderFileStorageAccess();
  renderOpenPlatformSetting();
  renderPrivateChat();
}

function normalizeStatus(result) {
  if (!result || typeof result !== "object" || !Array.isArray(result.bindings)) {
    throw new Error("edit_policy_status_unreadable");
  }
  return result;
}

function normalizeEditOptions(result, binding) {
  if (!result || typeof result !== "object" || result.schema !== "morrow.bridge.edit-options.v1"
    || result.sourceBindingId !== binding.sourceBindingId || result.provider !== binding.provider
    || result.catalogDigest !== state.status?.catalogDigest || !Number.isSafeInteger(result.policyRevision)
    || result.policyRevision !== Number(binding.editPolicyRevision || 0) || typeof result.runtimeVerified !== "boolean" || !Array.isArray(result.options)) {
    throw new Error("edit_policy_options_unreadable");
  }
  const seen = new Set();
  const options = result.options.filter((option) => {
    if (!option || typeof option.id !== "string" || !option.id || seen.has(option.id)
      || typeof option.group !== "string" || !option.group || typeof option.label !== "string" || !option.label
      || typeof option.description !== "string" || !option.description || !["edit", "review"].includes(option.availability)
      || (option.availability === "review" && (typeof option.reviewReason !== "string" || !option.reviewReason))
      || typeof option.destructive !== "boolean"
      || (option.verification !== undefined && !["checked", "unchecked"].includes(option.verification))
      || (option.verification === "unchecked" && (typeof option.verificationReason !== "string" || !option.verificationReason))) return false;
    seen.add(option.id);
    return true;
  });
  if (options.length !== result.options.length) throw new Error("edit_policy_options_unreadable");
  return { ...result, options };
}

async function refresh() {
  if (state.busy) return;
  const generation = ++state.readGeneration;
  state.statusLoading = true;
  refreshButton.disabled = true;
  // WI-F.10: renders the loading skeleton for the very first read. A later refresh re-renders the
  // course list it already has, which is a no-op until the new read replaces it. Only the course
  // list is rendered here: the rest of the page has nothing new to say until the read settles.
  renderCourseList();
  try {
    const result = normalizeStatus(await request("morrow_edit_policy_status"));
    if (generation !== state.readGeneration) return;
    state.status = result;
    state.statusReadFailed = false;
    const valid = new Set(result.bindings.filter(isEligible).map((binding) => binding.sourceBindingId));
    state.selected = new Set([...state.selected].filter((id) => valid.has(id)));
    state.optionsByBinding = new Map([...state.optionsByBinding].filter(([sourceBindingId, details]) => {
      const binding = result.bindings.find((candidate) => candidate.sourceBindingId === sourceBindingId);
      return binding?.runtimeVerified === true && details?.runtimeVerified === true && details.provider === binding.provider
        && details.policyRevision === Number(binding.editPolicyRevision || 0) && details.catalogDigest === result.catalogDigest;
    }));
    const expiredSelected = selectedBindings().filter(permissionHasExpired);
    if (expiredSelected.length) {
      state.mode = "plan";
      state.selectedCategories.clear();
      modePlan.checked = true;
      modeEdit.checked = false;
      showNotice(`${plural(expiredSelected.length, "selected course")} returned to Plan. ${expiredSelected.length === 1 ? "Its" : "Their"} earlier Edit access had an end time, and that time has passed.`);
    }
    const verifiedSites = new Set(anchors().map((anchor) => anchor.siteAnchorId));
    for (const siteAnchorId of state.discoveries.keys()) {
      if (!verifiedSites.has(siteAnchorId)) state.discoveries.delete(siteAnchorId);
    }
    rebuildCategories();
    reconcileSelectedCategories();
    clearReadError();
  } catch (cause) {
    if (generation !== state.readGeneration) return;
    state.status = null;
    state.statusReadFailed = true;
    state.categories = [];
    state.optionsByBinding.clear();
    state.selected.clear();
    showError(cause, { source: "read" });
  } finally {
    if (generation !== state.readGeneration) return;
    refreshButton.disabled = state.busy;
    await refreshCourseFileStorageAccess();
    if (generation !== state.readGeneration) return;
    await refreshCourseMeta();
    if (generation !== state.readGeneration) return;
    state.statusLoading = false;
    render();
    void refreshSelectedOptions();
    void autoStartDiscovery();
  }
}

async function refreshSelectedOptions() {
  const bindings = selectedBindings();
  const requestToken = ++state.optionsRequestToken;
  if (!bindings.length) {
    state.optionsLoading = false;
    rebuildCategories();
    return;
  }
  const pending = bindings.filter((binding) => binding.runtimeVerified === true && !optionsFor(binding));
  if (!pending.length) {
    state.optionsLoading = false;
    rebuildCategories();
    reconcileSelectedCategories();
    render();
    return;
  }
  state.optionsLoading = true;
  render();
  try {
    const options = await Promise.all(pending.map(async (binding) => [binding, normalizeEditOptions(await request("morrow_edit_policy_options", { sourceBindingId: binding.sourceBindingId }), binding)]));
    if (requestToken !== state.optionsRequestToken) return;
    for (const [binding, detail] of options) state.optionsByBinding.set(binding.sourceBindingId, detail);
    const needsSite = new Set(options.filter(([, detail]) => detail.runtimeVerified !== true).map(([binding]) => binding.sourceBindingId));
    if (needsSite.size) {
      state.status = { ...state.status, bindings: state.status.bindings.map((binding) => needsSite.has(binding.sourceBindingId) ? { ...binding, runtimeVerified: false } : binding) };
    }
    state.optionsLoading = false;
    rebuildCategories();
    reconcileSelectedCategories();
    clearReadError();
  } catch (cause) {
    if (requestToken !== state.optionsRequestToken) return;
    state.optionsLoading = false;
    rebuildCategories();
    reconcileSelectedCategories();
    showError(cause, { source: "read" });
  }
  render();
}

function setBusy(value) {
  state.busy = value;
  refreshButton.disabled = value;
  render();
}

async function returnToPlan(bindings, { doneMessage } = {}) {
  if (!bindings.length || state.busy) return;
  setBusy(true);
  clearError();
  clearNotice();
  let completed = 0;
  try {
    for (const binding of bindings) {
      const result = await request("morrow_edit_policy_revoke", { sourceBindingId: binding.sourceBindingId });
      if (result?.revoked !== true) throw new Error("edit_policy_revoke_unconfirmed");
      completed += 1;
    }
    state.mode = "plan";
    state.selectedCategories.clear();
    modePlan.checked = true;
    modeEdit.checked = false;
    showNotice(doneMessage || `${plural(completed, "course")} returned to Plan. Edit access was removed immediately.`);
  } catch (cause) {
    showError(cause, { prefix: completed ? `${plural(completed, "course")} returned to Plan. ` : "" });
  } finally {
    setBusy(false);
    await refresh();
  }
}

async function saveEditAccess() {
  const bindings = selectedBindings();
  const enabledCategories = [...state.selectedCategories];
  if (!bindings.length || !enabledCategories.length || !availableCategoriesForSelection().size || state.busy) return;
  // WI-5.6: a mixed selection's own choice is a platform-neutral family id; each connection saves
  // its own ids for it, never the literal list. A single-platform choice is a literal id, and every
  // selected connection must support every one of them, exactly as before WI-5.6.
  const isFamilySelection = enabledCategories.some((id) => typeof id === "string" && id.startsWith("family:"));
  const perBinding = bindings.map((binding) => ({ binding, ids: isFamilySelection ? resolveEnabledCategoriesFor(binding, enabledCategories) : enabledCategories }));
  if (isFamilySelection ? perBinding.some(({ ids }) => !ids.length) : enabledCategories.some((id) => !bindings.every((binding) => supportsCategory(binding, id)))) {
    showError("edit_policy_category_unavailable");
    return;
  }
  if (categoriesNeedingConfirmation().length && state.saveConfirmedFor !== selectionSignature()) {
    state.pendingSaveConfirmation = true;
    clearError();
    clearNotice();
    renderSelection();
    return;
  }
  setBusy(true);
  clearError();
  clearNotice();
  let completed = 0;
  const total = bindings.length;
  // WI-F.10: "Saving 2 of 5 courses" only once the save has run long enough to need it (400 ms),
  // shown within 100 ms of that wait, so a fast save never flashes a progress line.
  const saveProgressLabel = () => `Saving ${Math.min(completed + 1, total)} of ${plural(total, "course")}`;
  const revealTimer = setTimeout(() => {
    state.saveProgressText = saveProgressLabel();
    renderSelection();
  }, 400);
  try {
    for (const { binding, ids } of perBinding) {
      const result = await request("morrow_edit_policy_save", { sourceBindingId: binding.sourceBindingId, enabledCategories: ids });
      if (!result?.editPermission || !Array.isArray(result.editPermission.enabledCategories)) {
        throw new Error("edit_policy_save_unconfirmed");
      }
      completed += 1;
      if (state.saveProgressText) {
        state.saveProgressText = saveProgressLabel();
        renderSelection();
      }
    }
    showNotice(`Edit access saved for ${plural(completed, "course")}. Allowed actions: ${labelList(enabledCategories.map((id) => categoryById(id) || { label: id }))}. It stays on until you return ${completed === 1 ? "the course" : "these courses"} to Plan.`);
  } catch (cause) {
    showError(cause, { prefix: completed ? `Edit access saved for ${plural(completed, "course")}. ` : "" });
  } finally {
    clearTimeout(revealTimer);
    state.saveProgressText = null;
    state.pendingSaveConfirmation = false;
    state.saveConfirmedFor = null;
    setBusy(false);
    await refresh();
  }
}

function bindingById(sourceBindingId) {
  return (state.status?.bindings || []).find((entry) => entry.sourceBindingId === sourceBindingId) || null;
}

/** WI-5.4: the row's name button (aria-expanded/aria-controls) opens its detail in place. */
function toggleCourseDetail(sourceBindingId) {
  if (!sourceBindingId) return;
  if (state.openCourses.has(sourceBindingId)) state.openCourses.delete(sourceBindingId);
  else state.openCourses.add(sourceBindingId);
  renderCourseList();
  courseList.querySelector(`[data-toggle-course=${JSON.stringify(sourceBindingId)}]`)?.focus();
}

/**
 * WI-5.4: fetches this one binding's live options only when its detail's "Edit. Routine edits."
 * button needs them, independent of state.selected, so opening a row never disturbs what "Select"
 * mode has already picked for the bulk bar and the Course access panel below.
 */
async function ensureBindingOptions(binding) {
  if (optionsFor(binding)) return true;
  if (!binding) {
    showError("edit_policy_binding_missing");
    return false;
  }
  if (binding.runtimeVerified !== true) {
    showError("edit_policy_binding_stale");
    return false;
  }
  try {
    const detail = normalizeEditOptions(await request("morrow_edit_policy_options", { sourceBindingId: binding.sourceBindingId }), binding);
    state.optionsByBinding.set(binding.sourceBindingId, detail);
    // The course's tab closed after this page last read it, so the course now needs opening.
    if (detail.runtimeVerified !== true) {
      state.status = { ...state.status, bindings: state.status.bindings.map((entry) => entry.sourceBindingId === binding.sourceBindingId ? { ...entry, runtimeVerified: false } : entry) };
      showError("edit_policy_binding_stale");
      return false;
    }
    return true;
  } catch (cause) {
    showError(cause);
    return false;
  }
}

/** WI-5.4: this binding's own routine bundle ids, from its live options (ensureBindingOptions
 * fetches them first). WI-5.6's bindingFamilyCategoryIds applies the same filter, scoped to one
 * binding's own options directly, so opening a course's detail never touches
 * availableCategoriesForSelection/state.selected (what a bulk selection would grant). */
function routineCategoryIdsFor(binding) {
  return bindingFamilyCategoryIds(binding, "routine");
}

/**
 * WI-5.4: saves one course's own category list from its detail ("Edit. Routine edits." or
 * "Remove"). Unlike saveEditAccess, it never touches state.selected, state.mode or the
 * confirm step: the detail's own control already decided everything the request needs, and a
 * routine bundle is never destructive (D2a), so no confirmation step applies here.
 */
async function saveCourseCategories(binding, enabledCategories, successMessage) {
  if (state.busy) return;
  setBusy(true);
  clearError();
  clearNotice();
  try {
    const result = await request("morrow_edit_policy_save", { sourceBindingId: binding.sourceBindingId, enabledCategories });
    if (!result?.editPermission || !Array.isArray(result.editPermission.enabledCategories)) {
      throw new Error("edit_policy_save_unconfirmed");
    }
    showNotice(successMessage);
  } catch (cause) {
    showError(cause);
  } finally {
    setBusy(false);
    await refresh();
  }
}

/** WI-5.4: the detail's own "Plan. Morrow asks first." button. Reuses returnToPlan exactly as the
 * bulk bar and "Ask first in all courses" already do, so one course's Plan click and many share one
 * revoke path. */
async function setCoursePlan(binding) {
  if (state.busy || courseLevel(binding) === "plan") return;
  await returnToPlan([binding], { doneMessage: `${courseName(binding)} is in Plan. Morrow asks first.` });
}

/** WI-5.4: the detail's own "Edit. Routine edits." button (D2): always the routine set, for this
 * one course only. */
async function setCourseRoutine(binding) {
  if (state.busy || courseLevel(binding) === "routine") return;
  clearError();
  clearNotice();
  if (!(await ensureBindingOptions(binding))) {
    render();
    return;
  }
  const ids = routineCategoryIdsFor(binding);
  if (!ids.length) {
    showError("edit_policy_category_unavailable");
    render();
    return;
  }
  await saveCourseCategories(binding, ids, `Routine edits are on for ${courseName(binding)}. They stay on until you choose Plan.`);
}

/** WI-5.4: "Remove" saves the list without that category. The last category
 * removed leaves nothing to save (morrow_edit_policy_save refuses an empty list), so the course
 * returns to Plan instead, exactly what an empty allowed list means everywhere else (D7). */
async function removeCourseCategory(binding, categoryId) {
  if (state.busy || !categoryId) return;
  const ids = Array.isArray(binding?.editPermission?.enabledCategories)
    ? binding.editPermission.enabledCategories.filter((id) => typeof id === "string" && id !== categoryId)
    : [];
  if (!ids.length) {
    await returnToPlan([binding], { doneMessage: `${courseName(binding)} is in Plan. Morrow asks first.` });
    return;
  }
  const label = categoryLabelFor(categoryId);
  await saveCourseCategories(binding, ids, `Removed. Morrow asks again before it changes ${label.toLowerCase()} in ${courseName(binding)}.`);
}

/** WI-5.4: the detail's own confirmed Disconnect. Only this course, and its Edit access, go. */
async function disconnectCourse(binding) {
  if (state.busy) return;
  setBusy(true);
  clearError();
  clearNotice();
  try {
    const result = await request("morrow_course_disconnect", { sourceBindingId: binding.sourceBindingId });
    if (result?.disconnected !== true || result.sourceBindingId !== binding.sourceBindingId) throw new Error("edit_policy_failed");
    state.openCourses.delete(binding.sourceBindingId);
    state.selected.delete(binding.sourceBindingId);
    showNotice(`${courseName(binding)} is disconnected. Its Edit access was removed.`);
  } catch (cause) {
    showError(cause);
  } finally {
    state.confirmingDisconnect = null;
    setBusy(false);
    await refresh();
  }
}

/**
 * WI-5.4: "Customize" and the "Custom" chip both lead to the Course access panel below (hidden at
 * rest, WI-5.2), selecting only this course so a Customize visit cannot change any other course's
 * Edit access. WI-5.5's areas, kinds and bundles (renderCustomize/renderArea/renderKind) already
 * render into that same panel's #category-list.
 */
function openCustomizeFor(binding) {
  state.selected = new Set([binding.sourceBindingId]);
  state.mode = "edit";
  modeEdit.checked = true;
  modePlan.checked = false;
  state.pendingSaveConfirmation = false;
  state.saveConfirmedFor = null;
  showNotice(`Choose the changes for ${courseName(binding)} in Course access, below.`);
  render();
  void refreshSelectedOptions();
  document.querySelector("#mode-panel")?.scrollIntoView?.();
  modeEdit.focus?.();
}

// WI-5.1: code, term, role, favorite and published are optional on a discovered course. Each is
// read only when it carries the type its producer promises (courseSummary in canvas-content.js,
// discoveryCourses in service-worker.js); any other type is dropped, not rejected.
function discoveryOptionalString(value) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().slice(0, 120);
  return trimmed ? trimmed : undefined;
}

function discoveryOptionalBoolean(value) {
  return typeof value === "boolean" ? value : undefined;
}

function normalizeDiscoveryCourse(course) {
  const id = nativeCourseId(course?.id);
  if (!id || typeof course?.name !== "string" || !course.name) return null;
  const code = discoveryOptionalString(course.code);
  const term = discoveryOptionalString(course.term);
  const role = discoveryOptionalString(course.role);
  const favorite = discoveryOptionalBoolean(course.favorite);
  const published = discoveryOptionalBoolean(course.published);
  return {
    id,
    name: course.name,
    ...(code !== undefined ? { code } : {}),
    ...(term !== undefined ? { term } : {}),
    ...(role !== undefined ? { role } : {}),
    ...(favorite !== undefined ? { favorite } : {}),
    ...(published !== undefined ? { published } : {}),
  };
}

function normalizeDiscovery(result, siteAnchorId, prior = null) {
  if (!result || typeof result !== "object" || result.siteAnchorId !== siteAnchorId || typeof result.discoveryReceiptId !== "string" || !result.discoveryReceiptId
    || !Number.isFinite(result.expiresAt) || !Array.isArray(result.courses) || typeof result.complete !== "boolean"
    || !Number.isSafeInteger(result.pageNumber) || result.pageNumber < 1
    || !Number.isSafeInteger(result.courseCount) || result.courseCount < 0 || result.courseCount > DISCOVERY_PAGE_LIMIT) {
    throw new Error("course_discovery_failed");
  }
  const courseIds = new Set();
  const courses = result.courses.map(normalizeDiscoveryCourse).filter((course) => {
    if (!course || courseIds.has(course.id)) return false;
    courseIds.add(course.id);
    return true;
  });
  if (courses.length !== result.courses.length || courses.length !== result.courseCount) throw new Error("course_discovery_failed");
  if (prior) {
    const sameIdentity = result.discoveryReceiptId === prior.discoveryReceiptId
      && result.provider === prior.provider
      && result.origin === prior.origin
      && (result.siteUrl || "") === (prior.siteUrl || "")
      && result.principalId === prior.principalId
      && result.sessionGeneration === prior.sessionGeneration
      && result.expiresAt === prior.expiresAt;
    if (!sameIdentity || result.pageNumber !== prior.pageNumber + 1) throw new Error("course_discovery_failed");
  }
  return { ...result, courses };
}

/** Reads one site's first page of available courses. Resolves true when the list was read. */
async function readDiscovery(anchor) {
  try {
    const discovery = normalizeDiscovery(await request("morrow_course_discovery_start", { siteAnchorId: anchor.siteAnchorId }), anchor.siteAnchorId);
    if (discoveryExpired(discovery)) throw new Error("course_discovery_receipt_stale");
    state.discoveries.set(anchor.siteAnchorId, discovery);
    state.discoveryFailed.delete(anchor.siteAnchorId);
    return true;
  } catch (cause) {
    state.discoveries.delete(anchor.siteAnchorId);
    state.discoveryFailed.add(anchor.siteAnchorId);
    showError(cause);
    return false;
  }
}

function discoveryAnchor(siteAnchorId) {
  return anchors().find((anchor) => anchor.siteAnchorId === siteAnchorId) || null;
}

/**
 * WI-5.2: replaces the removed manual "Find courses" button. Reads the list of available courses
 * for every signed-in site that has none, one site after another, so it never interrupts a course
 * list the person is already looking at. refresh() calls this after every read (page open, Refresh,
 * and any status or storage change). A site whose list failed waits for Refresh connected courses.
 * WI-5.3 shows the result inline, under "Not connected", in the one merged course list.
 */
async function autoStartDiscovery() {
  if (state.busy) return;
  const pending = anchors().filter((anchor) => !state.discoveries.has(anchor.siteAnchorId) && !state.discoveryFailed.has(anchor.siteAnchorId));
  if (!pending.length) return;
  setBusy(true);
  try {
    for (const anchor of pending) await readDiscovery(anchor);
  } finally {
    setBusy(false);
  }
}

/** WI-5.3: the "Not connected" part of the list shows each site's first page (up to
 * DISCOVERY_PAGE_LIMIT). This reads the next page for every site that has one. A list whose
 * receipt expired is read again from its first page instead. */
async function loadMoreCourses() {
  const incomplete = [...state.discoveries.values()].filter((discovery) => discovery.complete === false);
  if (!incomplete.length || state.busy) return;
  setBusy(true);
  clearError();
  clearNotice();
  let restarted = false;
  try {
    for (const discovery of incomplete) {
      const anchor = discoveryAnchor(discovery.siteAnchorId);
      if (!anchor) continue;
      if (discoveryExpired(discovery)) {
        restarted = await readDiscovery(anchor) || restarted;
        continue;
      }
      try {
        state.discoveries.set(discovery.siteAnchorId, normalizeDiscovery(await request("morrow_course_discovery_more", {
          siteAnchorId: discovery.siteAnchorId,
          discoveryReceiptId: discovery.discoveryReceiptId
        }), discovery.siteAnchorId, discovery));
      } catch (cause) {
        const code = String(cause?.message || cause);
        if (code === "course_discovery_receipt_missing" || code === "course_discovery_receipt_stale") {
          restarted = await readDiscovery(anchor) || restarted;
          continue;
        }
        showError(code === "course_discovery_failed" ? "course_discovery_more_failed" : cause);
      }
    }
    if (restarted && error.hidden) showNotice("Morrow read the list of available courses again from its first page. Select Load more available courses to continue.");
  } finally {
    setBusy(false);
  }
}

/** The site's list, read again first when its receipt is no longer current. Null when the site is
 * not signed in or no longer offers the course. */
async function currentDiscoveryFor(course, { reread = false } = {}) {
  const anchor = discoveryAnchor(course.siteAnchorId);
  if (!anchor) throw new Error("course_discovery_anchor_stale");
  if (reread || discoveryExpired(state.discoveries.get(anchor.siteAnchorId))) {
    if (!await readDiscovery(anchor)) return null;
  }
  const discovery = state.discoveries.get(anchor.siteAnchorId);
  const offered = (discovery?.courses || []).some((candidate) => nativeCourseId(candidate?.id) === course.courseId);
  if (!offered) throw new Error("course_selection_unavailable");
  return discovery;
}

/** WI-5.3: a "Not connected" row's own "Connect" button, one course at a time. A list that is no
 * longer current is read again, and the connection tried once more from the new list. */
async function connectCourse(course) {
  if (state.busy) return;
  setBusy(true);
  clearError();
  clearNotice();
  try {
    let connectedResult = null;
    for (const reread of [false, true]) {
      const discovery = await currentDiscoveryFor(course, { reread });
      if (!discovery) return;
      const { siteAnchorId, discoveryReceiptId } = discovery;
      try {
        const result = await request("morrow_course_selection_save", { siteAnchorId, discoveryReceiptId, courseIds: [course.courseId] });
        const connected = new Set((result?.bindings || []).map((binding) => nativeCourseId(binding?.courseId)).filter(Boolean));
        if (result?.siteAnchorId !== siteAnchorId || !connected.has(course.courseId)) {
          throw new Error("course_selection_target_refused");
        }
        connectedResult = result;
        break;
      } catch (cause) {
        const code = String(cause?.message || cause);
        if (reread || (code !== "course_discovery_receipt_missing" && code !== "course_discovery_receipt_stale")) throw cause;
      }
    }
    if (connectedResult) showNotice(`${course.courseName} is connected in Plan. Morrow asks before each change.`);
  } catch (cause) {
    showError(cause);
  } finally {
    setBusy(false);
    await refresh();
  }
}

modePlan.addEventListener("change", () => {
  if (modePlan.checked) {
    state.mode = "plan";
    state.pendingSaveConfirmation = false;
    render();
  }
});

modeEdit.addEventListener("change", () => {
  if (modeEdit.checked) {
    state.mode = "edit";
    state.pendingSaveConfirmation = false;
    render();
  }
});

// WI-4.5 (D2): one switch sets enabledCategories to every routine bundle for the selection.
// Turning it off clears the selection; it never merges with a manual Customize pick.
routineSwitch.addEventListener("change", () => {
  state.routineMode = routineSwitch.checked;
  if (state.routineMode) {
    state.selectedCategories = new Set(routineCategoryIds());
  } else {
    state.selectedCategories.clear();
  }
  state.pendingSaveConfirmation = false;
  renderSelection();
});

// WI-4.5 (P2): "Remove" beside a listed bundle narrows the switch's grant without leaving the
// always-visible list, the same action a manual checkbox performs.
routineBundleList.addEventListener("click", (event) => {
  if (!(event.target instanceof Element)) return;
  const button = event.target.closest("[data-remove-routine]");
  if (!button) return;
  state.selectedCategories.delete(button.dataset.removeRoutine);
  state.pendingSaveConfirmation = false;
  renderSelection();
});

actionFilter.addEventListener("input", () => {
  state.actionFilter = actionFilter.value;
  renderCustomize();
});

actionCheckedOnly.addEventListener("change", () => {
  state.actionCheckedOnly = actionCheckedOnly.checked;
  renderCustomize();
});

// WI-5.5: an area's or a kind's own "select all" toggles every selectable id under it (the area's
// own checkbox skips the "remove" kind, D6), then both paths sync the same way a leaf action does:
// in place, with no second render (see syncCustomizeTriStates).
function setCategorySelected(id, selected) {
  if (selected) state.selectedCategories.add(id);
  else state.selectedCategories.delete(id);
  const input = categoryList.querySelector(`.customize-action-input[value="${id}"]`);
  if (input) input.checked = selected;
}

function toggleAreaSelection(areaId, checked) {
  const available = availableCategoriesForSelection();
  const ids = customizeSelectableIds(customizeAreaItems(areaId).filter((category) => categoryKind(category) !== "remove" && available.has(category.id)));
  for (const id of ids) setCategorySelected(id, checked);
}

function toggleKindSelection(key, checked) {
  const [areaId, kind] = key.split("/");
  const available = availableCategoriesForSelection();
  const ids = customizeSelectableIds(customizeAreaItems(areaId).filter((category) => categoryKind(category) === kind && available.has(category.id)));
  for (const id of ids) setCategorySelected(id, checked);
}

// WI-5.5: a checkbox change inside the Customize view updates counts and tri-states in place; it
// never rebuilds #category-list, because that would move focus and scroll.
categoryList.addEventListener("change", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement) || target.type !== "checkbox") return;
  if (target.dataset.areaSelect) toggleAreaSelection(target.dataset.areaSelect, target.checked);
  else if (target.dataset.kindSelect) toggleKindSelection(target.dataset.kindSelect, target.checked);
  else if (target.classList.contains("customize-action-input")) setCategorySelected(target.value, target.checked);
  else return;
  state.pendingSaveConfirmation = false;
  syncCustomizeTriStates();
  renderSelection();
});

// WI-5.5: an area's or a kind's own disclosure button. A button click, unlike a checkbox change, is
// free to render the list again: nothing here moves a checkbox's own state.
categoryList.addEventListener("click", (event) => {
  if (!(event.target instanceof Element)) return;
  const areaToggle = event.target.closest("[data-area-toggle]");
  if (areaToggle) {
    const id = areaToggle.dataset.areaToggle;
    if (state.openAreas.has(id)) state.openAreas.delete(id);
    else state.openAreas.add(id);
    renderCustomize();
    categoryList.querySelector(`[data-area-toggle="${id}"]`)?.focus();
    return;
  }
  const kindToggle = event.target.closest("[data-kind-toggle]");
  if (kindToggle) {
    const key = kindToggle.dataset.kindToggle;
    if (state.openKinds.has(key)) state.openKinds.delete(key);
    else state.openKinds.add(key);
    renderCustomize();
    categoryList.querySelector(`[data-kind-toggle="${key}"]`)?.focus();
  }
});

// WI-5.3: any filter change resets the "Show more" row cap, so a narrower list starts unpaginated.
function setCourseFilters(patch) {
  Object.assign(state.filters, patch);
  state.rowLimit = ROW_LIMIT_STEP;
  renderCourseList();
  renderSelection();
}

courseFilter.addEventListener("input", () => setCourseFilters({ q: courseFilter.value }));
coursePlatformFilter.addEventListener("change", () => setCourseFilters({ platform: coursePlatformFilter.value }));
courseTermFilter.addEventListener("change", () => setCourseFilters({ term: courseTermFilter.value }));

courseScopeTabs.addEventListener("click", (event) => {
  if (!(event.target instanceof Element)) return;
  const button = event.target.closest("[data-scope]");
  if (!button) return;
  setCourseFilters({ scope: button.dataset.scope });
  document.querySelector(`#course-scope-${state.filters.scope}`)?.focus();
});

courseShowMoreButton.addEventListener("click", () => {
  state.rowLimit += ROW_LIMIT_STEP;
  renderCourseList();
});

discoveryMoreButton.addEventListener("click", () => void loadMoreCourses());

// WI-5.3: "Select" shows a checkbox on each connected course and the bulk bar. Turning it on
// starts a fresh selection; turning it off keeps the selection, so the "Course access" panel
// below can still carry it into Customize (WI-5.5 replaces that panel with the inline detail).
courseSelectModeButton.addEventListener("click", () => {
  state.selectMode = !state.selectMode;
  if (state.selectMode) {
    state.selected.clear();
    rebuildCategories();
    reconcileSelectedCategories();
  }
  render();
});

courseBulkPlanButton.addEventListener("click", () => void returnToPlan(selectedBindings()));

// WI-5.3, D2a: the bulk bar's Edit shortcut is always the routine set, the same computation the
// "Routine edits" switch in the Course access panel below uses.
async function bulkRoutineEdit() {
  if (state.busy) return;
  const bindings = selectedBindings();
  if (!bindings.length) return;
  if (bindings.some((binding) => !optionsFor(binding))) await refreshSelectedOptions();
  const ids = routineCategoryIds();
  if (!ids.length) {
    showError("edit_policy_category_unavailable");
    return;
  }
  state.mode = "edit";
  modeEdit.checked = true;
  modePlan.checked = false;
  state.selectedCategories = new Set(ids);
  state.pendingSaveConfirmation = false;
  state.saveConfirmedFor = null;
  render();
  await saveEditAccess();
}

courseBulkRoutineButton.addEventListener("click", () => void bulkRoutineEdit());

courseList.addEventListener("click", (event) => {
  if (!(event.target instanceof Element)) return;
  if (event.target.closest("#open-platform-empty")) {
    const anchor = savedAnchor();
    void openSavedPlatform(anchor?.siteAnchorId, undefined, anchor?.provider);
    return;
  }
  const openPlatformButton = event.target.closest("[data-open-platform]");
  if (openPlatformButton) {
    const sourceBindingId = openPlatformButton.dataset.openPlatform;
    const binding = (state.status?.bindings || []).find((entry) => entry.sourceBindingId === sourceBindingId);
    if (binding?.siteAnchorId) void openSavedPlatform(binding.siteAnchorId, binding.sourceBindingId, binding.provider);
    else showError("platform_open_anchor_missing");
    return;
  }
  const connectButton = event.target.closest("[data-connect-row]");
  if (connectButton) {
    const [origin, courseId] = String(connectButton.dataset.connectRow || "").split("|");
    const course = discoveryItems().find((candidate) => candidate.origin === origin && candidate.courseId === courseId);
    // A stale click can race a re-render that already dropped this row (the discovery list
    // expired, or the course connected through another tab): name it rather than doing nothing.
    if (course) void connectCourse(course);
    else { showError("course_selection_invalid"); render(); }
    return;
  }
  // WI-5.4: the row's name button opens or closes its detail.
  const toggleButton = event.target.closest("[data-toggle-course]");
  if (toggleButton) {
    toggleCourseDetail(toggleButton.dataset.toggleCourse);
    return;
  }
  // WI-5.4: the detail's own Plan/Edit control, "Customize", "Remove" and "Disconnect".
  const levelButton = event.target.closest("[data-set-level]");
  if (levelButton) {
    const binding = bindingById(levelButton.closest("[data-binding-id]")?.dataset.bindingId);
    if (binding) void (levelButton.dataset.setLevel === "plan" ? setCoursePlan(binding) : setCourseRoutine(binding));
    return;
  }
  const customizeButton = event.target.closest("[data-open-customize]");
  if (customizeButton) {
    const binding = bindingById(customizeButton.closest("[data-binding-id]")?.dataset.bindingId);
    if (binding) openCustomizeFor(binding);
    return;
  }
  const removeButton = event.target.closest("[data-remove-category]");
  if (removeButton) {
    const binding = bindingById(removeButton.closest("[data-binding-id]")?.dataset.bindingId);
    if (binding) void removeCourseCategory(binding, removeButton.dataset.removeCategory);
    return;
  }
  const disconnectButton = event.target.closest("[data-disconnect], [data-disconnect-cancel], [data-disconnect-confirm]");
  if (disconnectButton) {
    const binding = bindingById(disconnectButton.closest("[data-binding-id]")?.dataset.bindingId);
    if (!binding) return;
    if (disconnectButton.hasAttribute("data-disconnect-confirm")) void disconnectCourse(binding);
    else {
      state.confirmingDisconnect = disconnectButton.hasAttribute("data-disconnect") ? binding.sourceBindingId : null;
      renderCourseList();
      const detail = courseList.querySelector(`#${courseDetailDomId(binding.sourceBindingId)}`);
      detail?.querySelector(state.confirmingDisconnect ? "[data-disconnect-cancel]" : "[data-disconnect]")?.focus();
    }
    return;
  }
  if (event.target.closest("input, button, a, summary, details")) return;
  if (!state.selectMode) return;
  const row = event.target.closest(".course-row[data-binding-id]");
  if (!row) return;
  const input = row.querySelector(".course-select");
  if (input instanceof HTMLInputElement && !input.disabled) input.click();
});

courseList.addEventListener("change", (event) => {
  const input = event.target;
  if (!(input instanceof HTMLInputElement) || !input.classList.contains("course-select")) return;
  const row = input.closest("[data-binding-id]");
  const id = row?.dataset.bindingId;
  if (!id) return;
  if (input.checked) state.selected.add(id);
  else state.selected.delete(id);
  state.pendingSaveConfirmation = false;
  rebuildCategories();
  reconcileSelectedCategories();
  render();
  void refreshSelectedOptions();
});

// Refresh connected courses also reads every site's list of available courses again, including a
// list that could not be read before.
refreshButton.addEventListener("click", () => {
  clearError();
  clearNotice();
  state.discoveries.clear();
  state.discoveryFailed.clear();
  void refresh();
});
returnPlanButton.addEventListener("click", () => void returnToPlan(selectedBindings()));
askFirstAllCoursesButton.addEventListener("click", () => void returnToPlan(activeEditBindings(), { doneMessage: "Done. Morrow asks first in all courses." }));
saveEditButton.addEventListener("click", () => void saveEditAccess());
confirmSaveButton.addEventListener("click", () => {
  state.saveConfirmedFor = selectionSignature();
  state.pendingSaveConfirmation = false;
  void saveEditAccess();
});
cancelSaveButton.addEventListener("click", () => {
  state.pendingSaveConfirmation = false;
  state.saveConfirmedFor = null;
  renderSelection();
  saveEditButton.focus();
});
enableFileStorageButton.addEventListener("click", () => void enableCourseFileStorageAccess());
revokeFileStorageButton.addEventListener("click", () => void revokeCourseFileStorageAccess());
openPlatformWhenNeededCheckbox.addEventListener("change", () => void setOpenPlatformWhenNeeded(openPlatformWhenNeededCheckbox.checked));
privateChatOpenButton.addEventListener("click", openPrivateChat);
privateChatCloseButton.addEventListener("click", () => void closePrivateChat());
privateChatScrim.addEventListener("click", () => void closePrivateChat());
privateChatSendButton.addEventListener("click", () => void sendPrivateChatMessage());
document.addEventListener("keydown", (event) => {
  if (!state.privateChatOpen) return;
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    void closePrivateChat();
    return;
  }
  trapPrivateChatFocus(event);
});

chrome.runtime?.onMessage?.addListener((message) => {
  if (["morrow_bridge_status_changed", "morrow_private_chat_changed"].includes(message?.type)) void refresh();
});

chrome.storage?.onChanged?.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  if (Object.prototype.hasOwnProperty.call(changes, OPEN_PLATFORM_WHEN_NEEDED_KEY)) void refreshOpenPlatformSetting();
  void refresh();
});
chrome.permissions?.onAdded?.addListener(() => void refreshCourseFileStorageAccess());
chrome.permissions?.onRemoved?.addListener(() => void refreshCourseFileStorageAccess());

await refreshOpenPlatformSetting();
await refresh();
