import { problemCode, problemText } from "../src/bridge-problem-copy.js";

const modePlan = document.querySelector("#mode-plan");
const modeEdit = document.querySelector("#mode-edit");
const categoryFieldset = document.querySelector("#category-fieldset");
const categoryList = document.querySelector("#category-list");
const actionFilter = document.querySelector("#action-filter");
const actionCheckedOnly = document.querySelector("#action-checked-only");
const editDuration = document.querySelector("#edit-duration");
const selectionSummary = document.querySelector("#selection-summary");
const connectionStatus = document.querySelector("#connection-status");
const coursesTitle = document.querySelector("#courses-title");
const siteAnchor = document.querySelector("#site-anchor");
const siteAnchorDetails = document.querySelector("#site-anchor-details");
const discoverCoursesButton = document.querySelector("#discover-courses");
const courseFilter = document.querySelector("#course-filter");
const selectVisible = document.querySelector("#select-visible");
const visibleScope = document.querySelector("#visible-scope");
const courseList = document.querySelector("#course-list");
const coursePages = document.querySelector("#course-pages");
const previousPage = document.querySelector("#previous-page");
const nextPage = document.querySelector("#next-page");
const pageStatus = document.querySelector("#page-status");
const discoveryProgress = document.querySelector("#discovery-progress");
const discoveryProgressText = document.querySelector("#discovery-progress-text");
const loadMoreCoursesButton = document.querySelector("#load-more-courses");
const availableActions = document.querySelector("#available-actions");
const availableSelectionSummary = document.querySelector("#available-selection-summary");
const connectSelectedButton = document.querySelector("#connect-selected");
const showConnectedButton = document.querySelector("#show-connected");
const modePanel = document.querySelector("#mode-panel");
const refreshButton = document.querySelector("#refresh");
const returnPlanButton = document.querySelector("#return-plan");
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
const fileStorageStatus = document.querySelector("#file-storage-status");
const enableFileStorageButton = document.querySelector("#enable-file-storage");
const revokeFileStorageButton = document.querySelector("#revoke-file-storage");

const PAGE_SIZE = 6;
const DISCOVERY_PAGE_LIMIT = 100;
const DEFAULT_EDIT_DURATION_MS = 60 * 60 * 1_000;
const COURSE_FILE_STORAGE_ACCESS_KEY = "courseFileStorageAccessEnabled";
const COURSE_FILE_STORAGE_ORIGINS = ["https://*/*"];
// One Edit action changes machinery the selected course does not own: a Canvas
// Item Bank question can be drawn by quizzes in other courses. Its label reads
// like a change confined to this course, so every list of allowed actions
// carries the consequence beside the label.
const CATEGORY_COURSE_REACH = Object.freeze({
  canvas_item_bank_question_image_alt: "One item bank question can be used by quizzes in other courses. Morrow lists every course the bank reaches and asks you to confirm them before it sends the change.",
});

const state = {
  busy: false,
  actionCheckedOnly: false,
  actionFilter: "",
  categories: [],
  discovery: null,
  discoverySelected: new Set(),
  fileStorageAccess: { browserPermission: false, enabled: false, optedIn: false, checking: true },
  fileStorageBusy: false,
  filter: "",
  mode: "plan",
  page: 0,
  optionsByBinding: new Map(),
  optionsLoading: false,
  optionsRequestToken: 0,
  pendingSaveConfirmation: false,
  saveConfirmedFor: null,
  selected: new Set(),
  selectedCategories: new Set(),
  status: null,
  view: "connected"
};

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
  const provider = String(binding.provider || "Course site");
  return provider === "moodle" ? "Moodle" : provider === "canvas" ? "Canvas" : provider;
}

function nativeCourseId(value) {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) return "";
  return Number.isSafeInteger(Number(value)) ? value : "";
}

function anchors() {
  const value = state.status?.siteAnchors;
  return Array.isArray(value) ? value.filter((anchor) => anchor && typeof anchor.siteAnchorId === "string" && anchor.siteAnchorId && anchor.runtimeVerified === true) : [];
}

function selectedAnchor() {
  return anchors().find((anchor) => anchor.siteAnchorId === state.discovery?.siteAnchorId || anchor.siteAnchorId === siteAnchor.value) || null;
}

function focusedCourseControl() {
  const active = document.activeElement;
  if (!(active instanceof HTMLInputElement)) return null;
  if (active.classList.contains("course-select")) {
    const bindingId = active.closest("[data-binding-id]")?.dataset.bindingId;
    return bindingId ? { selector: `[data-binding-id=${JSON.stringify(bindingId)}] .course-select` } : null;
  }
  if (active.classList.contains("available-course-select")) {
    const courseId = nativeCourseId(active.closest("[data-course-id]")?.dataset.courseId);
    return courseId ? { selector: `[data-course-id=${JSON.stringify(courseId)}] .available-course-select` } : null;
  }
  return null;
}

function restoreCourseFocus(focus) {
  if (!focus) return;
  courseList.querySelector(focus.selector)?.focus();
}

function anchorLabel(anchor) {
  const provider = providerName(anchor);
  const matchingSites = anchors().filter((candidate) => providerName(candidate) === provider);
  const position = matchingSites.findIndex((candidate) => candidate.siteAnchorId === anchor.siteAnchorId);
  return matchingSites.length > 1 && position >= 0 ? `${provider} signed-in site ${position + 1}` : `${provider} signed-in site`;
}

function discoveryExpired() {
  return !state.discovery || state.discovery.requiresRefresh === true || !Number.isFinite(state.discovery.expiresAt) || Date.now() >= state.discovery.expiresAt;
}

function discoveryItems() {
  if (!state.discovery || discoveryExpired() || !Array.isArray(state.discovery.courses)) return [];
  return state.discovery.courses.map((course) => ({
    available: true,
    courseId: nativeCourseId(course?.id),
    courseName: typeof course?.name === "string" && course.name ? course.name : `Course ${nativeCourseId(course?.id)}`,
    provider: state.discovery.provider,
    origin: state.discovery.origin,
    siteUrl: state.discovery.siteUrl,
    principalId: state.discovery.principalId
  })).filter((course) => course.courseId);
}

function listItems() {
  return state.view === "available" ? discoveryItems() : (Array.isArray(state.status?.bindings) ? state.status.bindings : []);
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

function permissionHasExpired(binding) {
  const expiresAt = permissionExpiresAt(binding);
  return expiresAt !== null && Date.now() >= expiresAt;
}

function expiryLabel(expiresAt) {
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short"
  }).format(expiresAt);
}

function isStale(binding) {
  const permission = storedEditPermission(binding);
  return permissionHasExpired(binding) || binding?.policyStale === true || Boolean(permission && state.status?.catalogDigest && permission.catalogDigest !== state.status.catalogDigest);
}

function matchingItems() {
  const query = state.filter.trim().toLocaleLowerCase();
  const items = listItems();
  if (!query) return items;
  return items.filter((binding) => [
    binding.provider, binding.origin, binding.siteUrl, binding.courseId, binding.courseName, binding.principalId
  ].some((value) => String(value || "").toLocaleLowerCase().includes(query)));
}

function currentPage() {
  const matching = matchingItems();
  const totalPages = Math.max(1, Math.ceil(matching.length / PAGE_SIZE));
  state.page = Math.min(state.page, totalPages - 1);
  const start = state.page * PAGE_SIZE;
  return { matching, totalPages, start, bindings: matching.slice(start, start + PAGE_SIZE) };
}

function selectedBindings() {
  const all = Array.isArray(state.status?.bindings) ? state.status.bindings : [];
  return all.filter((binding) => state.selected.has(binding.sourceBindingId) && isEligible(binding));
}

function categoryById(id) {
  return state.categories.find((category) => category.id === id);
}

function optionsFor(binding) {
  const detail = state.optionsByBinding.get(binding?.sourceBindingId);
  const summary = binding?.editPermission;
  const permission = detail?.editPermission;
  return detail && detail.provider === binding?.provider
    && detail.policyRevision === Number(binding?.editPolicyRevision || 0)
    && detail.catalogDigest === state.status?.catalogDigest
    && Boolean(summary) === Boolean(permission)
    && (!summary || (summary.scopeDigest === permission.scopeDigest && summary.revision === permission.revision && summary.expiresAt === permission.expiresAt))
    ? detail
    : null;
}

function categoriesFor(binding) {
  const values = optionsFor(binding)?.editPermission?.enabledCategories;
  return Array.isArray(values) ? values.filter((value) => typeof value === "string") : [];
}

function supportsCategory(binding, id) {
  return optionsFor(binding)?.options.some((category) => category?.id === id && category.availability === "edit") === true;
}

function rebuildCategories() {
  const selected = selectedBindings();
  if (!selected.length || selected.some((binding) => !optionsFor(binding))) {
    state.categories = [];
    return;
  }
  const details = selected.map(optionsFor);
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

function availableCategoriesForSelection() {
  const selected = selectedBindings();
  if (!selected.length) return new Set();
  return new Set(state.categories.filter((category) => category.availability === "edit" && selected.every((binding) => supportsCategory(binding, category.id))).map((category) => category.id));
}

function reconcileSelectedCategories() {
  const available = availableCategoriesForSelection();
  state.selectedCategories = new Set([...state.selectedCategories].filter((id) => available.has(id)));
}

function categoryLabels(ids) {
  return ids.map((id) => categoryById(id)?.label || id).join(", ");
}

/** What the listed actions change outside the selected course, in one sentence each. */
function courseReachNote(ids) {
  const notes = [...new Set(ids.map((id) => CATEGORY_COURSE_REACH[id]).filter(Boolean))];
  return notes.length ? ` ${notes.join(" ")}` : "";
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
function showError(cause, { prefix = "" } = {}) {
  error.hidden = false;
  error.textContent = `${prefix}${problemText(problemCode(cause))}`;
}

function clearError() {
  error.hidden = true;
  error.textContent = "";
}

function categoryProvider(category) {
  return typeof category?.group === "string" && category.group ? category.group : "Course actions";
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

function renderCategoryGroup(group, categories, available, expanded) {
  return `
    <details class="category-group" aria-label="${escapeHtml(group)} actions" ${expanded || ["Focused Canvas repairs", "Common Moodle actions"].includes(group) ? "open" : ""}>
      <summary>${escapeHtml(group)}<span>${plural(categories.length, "action")}</span></summary>
      <div class="category-options">
        ${categories.map((category) => {
          const inputId = `category-${category.id}`;
          const descriptionId = `${inputId}-description`;
          const isAvailable = available.has(category.id);
          const reason = category.availability === "review" ? ` ${category.reviewReason || "This action remains in Plan for review."}` : "";
          if (category.availability === "review") {
            return `<article class="category-option review-only" aria-describedby="${escapeHtml(descriptionId)}">
              <span><strong>Review only — ${escapeHtml(category.label)}</strong>${categoryFlags(category)}<small id="${escapeHtml(descriptionId)}">${escapeHtml(category.description)}${escapeHtml(reason)}</small></span>
            </article>`;
          }
          const unavailable = isAvailable ? "" : " Not available for every selected course.";
          return `<label class="category-option" for="${escapeHtml(inputId)}">
            <input id="${escapeHtml(inputId)}" type="checkbox" value="${escapeHtml(category.id)}" aria-describedby="${escapeHtml(descriptionId)}" ${state.selectedCategories.has(category.id) ? "checked" : ""} ${isAvailable ? "" : "disabled"}>
            <span><strong>${escapeHtml(category.label)}</strong>${categoryFlags(category)}<small id="${escapeHtml(descriptionId)}">${escapeHtml(category.description)}${escapeHtml(verificationNote(category))}${unavailable}</small></span>
          </label>`;
        }).join("")}
      </div>
    </details>
  `;
}

function renderCategories() {
  const available = availableCategoriesForSelection();
  const hasSelectedCourses = selectedBindings().length > 0;
  if (!hasSelectedCourses) {
    categoryList.innerHTML = '<p class="state-message">Select a course to read its available Edit and Review-only actions.</p>';
    return;
  }
  if (state.optionsLoading) {
    categoryList.innerHTML = '<p class="state-message">Reading the current individual actions for the selected courses…</p>';
    return;
  }
  const query = state.actionFilter.trim().toLocaleLowerCase();
  const expanded = Boolean(query) || state.actionCheckedOnly;
  const visibleCategories = state.categories
    .filter((category) => !state.actionCheckedOnly || category.verification === "checked")
    .filter((category) => !query || [category.group, category.label, category.description, category.reviewReason]
      .some((value) => String(value || "").toLocaleLowerCase().includes(query)));
  if (!visibleCategories.length) {
    categoryList.innerHTML = `<p class="state-message">${query
      ? "No individual action matches this search."
      : state.actionCheckedOnly
        ? "The selected courses have no action Morrow can check after it is saved."
        : "The selected courses have no common actions. Select courses from one platform to continue."}</p>`;
    return;
  }
  const groups = new Map();
  for (const category of visibleCategories) {
    const provider = categoryProvider(category);
    if (!groups.has(provider)) groups.set(provider, []);
    groups.get(provider).push(category);
  }
  const entries = [...groups];
  const featured = entries.filter(([group]) => ["Focused Canvas repairs", "Common Moodle actions"].includes(group));
  const additional = entries.filter(([group]) => !["Focused Canvas repairs", "Common Moodle actions"].includes(group));
  categoryList.innerHTML = featured.map(([group, categories]) => renderCategoryGroup(group, categories, available, expanded)).join("")
    + (additional.length ? `<details class="category-directory" ${expanded ? "open" : ""}>
      <summary>Browse ${plural(additional.length, "additional action group")}</summary>
      <div>${additional.map(([group, categories]) => renderCategoryGroup(group, categories, available, expanded)).join("")}</div>
    </details>` : "");
}

function permissionState(binding) {
  if (!isEligible(binding)) return { label: "Reconnect needed", className: "" };
  if (permissionHasExpired(binding)) return { label: "Edit expired", className: "stale" };
  if (isStale(binding)) return { label: "Save again", className: "stale" };
  if (binding.runtimeVerified !== true) return { label: "Course tab needed", className: "" };
  const enabled = categoriesFor(binding);
  if (!enabled.length) return binding?.editPermission ? { label: "Edit active", className: "edit" } : { label: "Plan only", className: "" };
  return { label: `Edit: ${plural(enabled.length, "type")}`, className: "edit" };
}

function diagnosticDetails(binding) {
  const details = [];
  if (binding.siteUrl || binding.origin) details.push(["Course site", binding.siteUrl || binding.origin]);
  if (binding.principalId) details.push(["Signed-in account", binding.principalId]);
  if (binding.courseId) details.push(["Course ID", binding.courseId]);
  if (binding.sessionGeneration !== undefined && binding.sessionGeneration !== null) details.push(["Connection", `Session ${binding.sessionGeneration}`]);
  return details;
}

function renderDiagnosticDetails(binding) {
  const details = diagnosticDetails(binding);
  if (!details.length) return "";
  return `<details class="course-diagnostics"><summary>Course details</summary><dl>${details.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("")}</dl></details>`;
}

function bindingNote(binding) {
  if (!isEligible(binding)) return "Morrow cannot identify this course. Reconnect it from the Morrow popup before you choose Edit.";
  if (permissionHasExpired(binding)) return "This temporary Edit access has ended. The course is back in Plan. Ask Morrow for Edit access again if you still need it.";
  if (isStale(binding)) return "Available actions changed. Edit is paused until you review and save the selected actions again.";
  if (binding.runtimeVerified !== true) return "This course remains selected, but its site is closed. Open the course site before you save Edit.";
  const enabled = categoriesFor(binding);
  if (!enabled.length) return binding?.editPermission
    ? "Edit access is active. Select this course to read its exact allowed actions."
    : "Plan is active. Morrow prepares every change for your review.";
  const expiresAt = permissionExpiresAt(binding);
  return `Allowed actions: ${categoryLabels(enabled)}.${courseReachNote(enabled)} ${expiresAt !== null ? `This temporary access ends ${expiryLabel(expiresAt)}.` : "Read the course actions again to confirm the current expiry."} Other changes stay in review.`;
}

function renderCourseContext(binding) {
  const account = binding.principalId || "Signed-in account unavailable";
  const site = binding.siteUrl || binding.origin || "Course site unavailable";
  return `<dl class="course-context"><div><dt>Account</dt><dd>${escapeHtml(account)}</dd></div><div><dt>Course site</dt><dd>${escapeHtml(site)}</dd></div></dl>`;
}

function renderAvailableCourse(course) {
  const selected = state.discoverySelected.has(course.courseId);
  return `
    <article class="course-card ${selected ? "is-selected" : ""}" data-course-id="${escapeHtml(course.courseId)}">
      <input class="available-course-select" type="checkbox" aria-label="Select ${escapeHtml(course.courseName)} to connect" ${selected ? "checked" : ""}>
      <div class="course-content">
        <div class="course-card-header">
          <h3 class="course-title"><span class="provider">${escapeHtml(providerName(course))}</span>${escapeHtml(course.courseName)}</h3>
          <p class="permission-state">Plan on connect</p>
        </div>
        ${renderCourseContext(course)}
        ${renderDiagnosticDetails(course)}
      </div>
    </article>
  `;
}

function renderBinding(binding) {
  if (binding.available) return renderAvailableCourse(binding);
  const eligible = isEligible(binding);
  const selected = state.selected.has(binding.sourceBindingId);
  const permission = permissionState(binding);
  const note = bindingNote(binding);
  return `
    <article class="course-card ${selected ? "is-selected" : ""} ${eligible ? "" : "is-unavailable"}" data-binding-id="${escapeHtml(binding.sourceBindingId || "")}">
      <input class="course-select" type="checkbox" aria-label="Select ${escapeHtml(courseName(binding))}" ${selected ? "checked" : ""} ${eligible ? "" : "disabled"}>
      <div class="course-content">
        <div class="course-card-header">
          <h3 class="course-title"><span class="provider">${escapeHtml(providerName(binding))}</span>${escapeHtml(courseName(binding))}</h3>
          <p class="permission-state ${permission.className}">${escapeHtml(permission.label)}</p>
        </div>
        ${renderCourseContext(binding)}
        ${renderDiagnosticDetails(binding)}
        ${note ? `<p class="card-note">${escapeHtml(note)}</p>` : ""}
      </div>
    </article>
  `;
}

function renderAnchors() {
  const availableAnchors = anchors();
  const current = selectedAnchor() || availableAnchors[0] || null;
  siteAnchor.innerHTML = availableAnchors.map((anchor) => `<option value="${escapeHtml(anchor.siteAnchorId)}">${escapeHtml(anchorLabel(anchor))}</option>`).join("");
  if (current) siteAnchor.value = current.siteAnchorId;
  siteAnchor.disabled = state.busy || !availableAnchors.length;
  discoverCoursesButton.disabled = state.busy || !current;
  if (!availableAnchors.length) {
    siteAnchorDetails.textContent = "No signed-in course site is available. Open one course from a site in Chrome, then refresh this page.";
  } else if (current) {
    siteAnchorDetails.textContent = "Find courses from this signed-in site. You choose which courses to connect in Plan.";
  }
}

function renderCourses(focus = focusedCourseControl()) {
  const connected = Array.isArray(state.status?.bindings) ? state.status.bindings : [];
  const availableView = state.view === "available";
  const { matching, totalPages, start, bindings: pageBindings } = currentPage();
  const selectableOnPage = availableView ? pageBindings : pageBindings.filter(isEligible);
  const selectedOnPage = selectableOnPage.filter((binding) => availableView
    ? state.discoverySelected.has(binding.courseId)
    : state.selected.has(binding.sourceBindingId));
  const selectedTotal = availableView ? state.discoverySelected.size : selectedBindings().length;
  courseList.setAttribute("aria-busy", String(!state.status || state.busy));
  coursesTitle.textContent = availableView ? "Choose courses to connect" : "Choose connected courses";
  modePanel.hidden = availableView;
  availableActions.hidden = !availableView;
  const discovery = state.discovery;
  const showDiscoveryProgress = availableView && Boolean(discovery);
  discoveryProgress.hidden = !showDiscoveryProgress;
  loadMoreCoursesButton.hidden = true;
  if (showDiscoveryProgress) {
    const count = discovery.courseCount;
    if (discoveryExpired()) {
      discoveryProgressText.textContent = "This available-course list has expired. Find available courses again before connecting courses.";
    } else if (discovery.complete) {
      discoveryProgressText.textContent = `Page ${discovery.pageNumber} shows the final ${plural(count, "available course")} from this site.`;
    } else {
      discoveryProgressText.textContent = `Page ${discovery.pageNumber} shows ${plural(count, "available course")}. More courses are available from this site.`;
      loadMoreCoursesButton.hidden = false;
      loadMoreCoursesButton.disabled = state.busy || state.discoverySelected.size > 0;
      loadMoreCoursesButton.textContent = state.busy
        ? "Loading more courses…"
        : state.discoverySelected.size ? "Connect selected courses to continue" : "Load more available courses";
    }
  }

  if (!state.status) {
    courseList.innerHTML = '<p class="state-message">Loading connected courses…</p>';
  } else if (availableView && discoveryExpired()) {
    courseList.innerHTML = '<p class="state-message">This available-course list has expired. Find available courses again before you connect courses.</p>';
  } else if (!availableView && !connected.length) {
    courseList.innerHTML = '<p class="state-message">No connected courses are available. Choose a signed-in site above to find courses you can connect.</p>';
  } else if (!matching.length) {
    courseList.innerHTML = state.filter.trim()
      ? `<p class="state-message">No ${availableView ? "available" : "connected"} course matches this search. Clear the search to view every course in this list.</p>`
      : `<p class="state-message">No ${availableView ? "available" : "connected"} courses were found from this signed-in site.</p>`;
  } else {
    courseList.innerHTML = pageBindings.map(renderBinding).join("");
  }

  const ready = connected.filter((binding) => isEligible(binding) && binding.runtimeVerified === true);
  const max = Number.isInteger(state.status?.bindingLimit) ? state.status.bindingLimit : 500;
  if (!state.status) {
    connectionStatus.textContent = "Checking your connected course sites…";
  } else if (availableView && !discoveryExpired()) {
    const found = state.discovery?.courseCount || discoveryItems().length;
    connectionStatus.textContent = state.discovery?.complete
      ? `Page ${state.discovery.pageNumber} shows the final ${plural(found, "available course")} returned from the selected site. These courses are not connected yet.`
      : `Page ${state.discovery?.pageNumber} shows ${plural(found, "available course")}. More courses are available from the selected site.`;
  } else if (!connected.length) {
    connectionStatus.textContent = "No course is connected yet.";
  } else if (connected.length >= max) {
    connectionStatus.textContent = `The connector returned ${plural(connected.length, "connected course")}, which is the ${max}-course settings limit. Disconnect a course before adding another.`;
  } else {
    const needsSite = connected.length - ready.length;
    connectionStatus.textContent = needsSite
      ? `${plural(ready.length, "connected course")} ${ready.length === 1 ? "is" : "are"} ready to use. ${plural(needsSite, "saved course")} ${needsSite === 1 ? "needs" : "need"} an open course tab or a reconnected site.`
      : `${plural(ready.length, "connected course")} ${ready.length === 1 ? "is" : "are"} ready to use.`;
  }

  visibleScope.textContent = pageBindings.length
    ? `${plural(selectedOnPage.length, "course")} selected on this page. ${plural(selectedTotal, "course")} selected total.`
    : "No courses in this view.";
  selectVisible.disabled = state.busy || !selectableOnPage.length;
  selectVisible.textContent = selectableOnPage.length && selectedOnPage.length === selectableOnPage.length
    ? "Clear this page"
    : availableView ? "Select this page to connect" : "Select this page";

  const showPages = Boolean(state.status && matching.length > PAGE_SIZE);
  coursePages.hidden = !showPages;
  previousPage.disabled = state.busy || state.page === 0;
  nextPage.disabled = state.busy || state.page >= totalPages - 1;
  pageStatus.textContent = matching.length
    ? `Showing ${start + 1}–${Math.min(start + PAGE_SIZE, matching.length)} of ${plural(matching.length, `matching ${availableView ? "available" : "connected"} course`)}. Page ${state.page + 1} of ${totalPages}.`
    : `No matching ${availableView ? "available" : "connected"} courses.`;

  const scope = availableView ? "available course" : "connected course";
  const emptyList = state.filter.trim()
    ? `No ${scope} matches this search.`
    : !availableView
      ? "No course is connected yet."
      : discoveryExpired()
        ? "This available-course list has expired. Find available courses again."
        : "No available course was found from this signed-in site.";
  // The visible notice owns the status region while it shows, so an action result is not replaced
  // by the list summary that follows it.
  if (notice.hidden) {
    announce(!state.status ? "" : matching.length
      ? `${state.filter.trim() ? "Search matches " : ""}${plural(matching.length, scope)}${totalPages > 1 ? `, page ${state.page + 1} of ${totalPages}` : ""}.`
      : emptyList);
  }

  availableSelectionSummary.textContent = discoveryExpired()
    ? "Find available courses again. The previous course list is no longer valid."
    : !state.discoverySelected.size
      ? "Available courses on this page are not connected yet. Select courses to connect them with Plan access only."
      : `${plural(state.discoverySelected.size, "available course")} selected to connect on this page. This does not grant Edit access.`;
  connectSelectedButton.disabled = state.busy || discoveryExpired() || !state.discoverySelected.size;
  connectSelectedButton.textContent = state.discoverySelected.size ? `Connect ${plural(state.discoverySelected.size, "selected course")} in Plan` : "Connect selected courses in Plan";
  restoreCourseFocus(focus);
}

function allowedEditDurations() {
  const values = Array.isArray(state.status?.editDurations) ? state.status.editDurations : [];
  return values.filter((entry) => Number.isSafeInteger(entry?.value) && entry.value > 0 && typeof entry.label === "string" && entry.label);
}

function selectedEditDuration() {
  const value = Number(editDuration.value);
  return allowedEditDurations().some((entry) => entry.value === value) ? value : null;
}

function renderEditDuration(showEditStage) {
  const durations = allowedEditDurations();
  const selected = selectedEditDuration();
  const preferred = durations.some((entry) => entry.value === selected)
    ? selected
    : durations.find((entry) => entry.value === DEFAULT_EDIT_DURATION_MS)?.value || durations[0]?.value || null;
  editDuration.innerHTML = durations.map((entry) => `<option value="${entry.value}">${escapeHtml(entry.label)}</option>`).join("");
  if (preferred !== null) editDuration.value = String(preferred);
  editDuration.disabled = state.busy || !showEditStage || !durations.length;
}

function renderSelection() {
  const selected = selectedBindings();
  const categoriesSelected = state.selectedCategories.size;
  const availableCategories = availableCategoriesForSelection();
  selectionSummary.textContent = !state.status
    ? "Loading connected courses…"
    : !selected.length
      ? "No course selected. Select a course above, then choose Plan or Edit."
      : state.mode === "plan"
        ? `${plural(selected.length, "course")} selected. Plan keeps changes ready for your review.`
        : !availableCategories.size
          ? `${plural(selected.length, "course")} selected. Choose courses from one platform to set Edit.`
          : !categoriesSelected
            ? `${plural(selected.length, "course")} selected. Choose at least one change before you save Edit.`
            : `${plural(selected.length, "course")} selected. Morrow can make: ${categoryLabels([...state.selectedCategories])}.${courseReachNote([...state.selectedCategories])}`;
  const showEditStage = state.mode === "edit" && selected.length > 0;
  categoryFieldset.hidden = !showEditStage;
  categoryFieldset.disabled = state.busy || !showEditStage;
  renderEditDuration(showEditStage);
  editStageHint.hidden = showEditStage;
  editStageHint.textContent = !selected.length
    ? "Select courses, then choose Edit to review the available actions."
    : "Choose Edit to review and select the actions Morrow may apply.";
  permissionActions.hidden = !selected.length;
  modePlan.disabled = state.busy || !selected.length;
  modeEdit.disabled = state.busy || !selected.length;
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
  saveEditButton.disabled = state.busy || confirming || !showEditStage || !categoriesSelected || !availableCategories.size || !selectedEditDuration();
  returnPlanButton.textContent = `Return ${plural(selected.length, "selected course")} to Plan`;
  saveEditButton.textContent = showEditStage ? `Save Edit access for ${plural(selected.length, "course")}` : "Save Edit access";
  actionHelp.textContent = state.mode === "plan"
    ? "Plan is active for these courses. Return them to Plan to remove any saved Edit access immediately."
    : !availableCategories.size
      ? "The selected courses use different platforms. Choose courses from one platform before you save Edit."
      : !categoriesSelected
        ? "Choose at least one action. Unchecked actions stay in Plan for your review."
        : `Morrow can apply only the checked actions in these courses for ${editDuration.options[editDuration.selectedIndex]?.text || "the selected duration"}. Save again if available actions change.`;
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

function render(courseFocus = focusedCourseControl()) {
  renderAnchors();
  renderCategories();
  renderCourses(courseFocus);
  renderSelection();
  renderFileStorageAccess();
}

function normalizeStatus(result) {
  if (!result || typeof result !== "object" || !Array.isArray(result.bindings) || !Array.isArray(result.editDurations)) {
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
  courseList.setAttribute("aria-busy", "true");
  refreshButton.disabled = true;
  try {
    const result = normalizeStatus(await request("morrow_edit_policy_status"));
    state.status = result;
    const valid = new Set(result.bindings.filter(isEligible).map((binding) => binding.sourceBindingId));
    state.selected = new Set([...state.selected].filter((id) => valid.has(id)));
    state.optionsByBinding = new Map([...state.optionsByBinding].filter(([sourceBindingId, details]) => {
      const binding = result.bindings.find((candidate) => candidate.sourceBindingId === sourceBindingId);
      return binding && details?.provider === binding.provider && details.policyRevision === Number(binding.editPolicyRevision || 0) && details.catalogDigest === result.catalogDigest;
    }));
    const expiredSelected = selectedBindings().filter(permissionHasExpired);
    if (expiredSelected.length) {
      state.mode = "plan";
      state.selectedCategories.clear();
      modePlan.checked = true;
      modeEdit.checked = false;
      showNotice(`${plural(expiredSelected.length, "selected course")} returned to Plan because temporary Edit access ended.`);
    }
    if (state.discovery && !anchors().some((anchor) => anchor.siteAnchorId === state.discovery.siteAnchorId)) {
      state.discovery = null;
      state.discoverySelected.clear();
      state.view = "connected";
      state.page = 0;
    }
    rebuildCategories();
    reconcileSelectedCategories();
    clearError();
  } catch (cause) {
    state.status = null;
    state.categories = [];
    state.optionsByBinding.clear();
    state.selected.clear();
    showError(cause);
  } finally {
    refreshButton.disabled = state.busy;
    await refreshCourseFileStorageAccess();
    render();
    void refreshSelectedOptions();
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
  const pending = bindings.filter((binding) => !optionsFor(binding));
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
    state.optionsLoading = false;
    rebuildCategories();
    reconcileSelectedCategories();
    clearError();
  } catch (cause) {
    if (requestToken !== state.optionsRequestToken) return;
    state.optionsLoading = false;
    rebuildCategories();
    reconcileSelectedCategories();
    showError(cause);
  }
  render();
}

function setBusy(value) {
  state.busy = value;
  refreshButton.disabled = value;
  render();
}

async function returnToPlan(bindings) {
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
    showNotice(`${plural(completed, "course")} returned to Plan. Edit access was removed immediately.`);
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
  const expiresInMs = selectedEditDuration();
  if (!bindings.length || !enabledCategories.length || !availableCategoriesForSelection().size || !expiresInMs || state.busy) return;
  if (enabledCategories.some((id) => !bindings.every((binding) => supportsCategory(binding, id)))) {
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
  let expiresAt = null;
  try {
    for (const binding of bindings) {
      const result = await request("morrow_edit_policy_save", { sourceBindingId: binding.sourceBindingId, enabledCategories, expiresInMs });
      if (!result?.editPermission || !Array.isArray(result.editPermission.enabledCategories)) {
        throw new Error("edit_policy_save_unconfirmed");
      }
      if (Number.isSafeInteger(result.editPermission.expiresAt)) expiresAt = result.editPermission.expiresAt;
      completed += 1;
    }
    showNotice(`Edit access saved for ${plural(completed, "course")}. Allowed actions: ${categoryLabels(enabledCategories)}. It ends ${expiresAt ? expiryLabel(expiresAt) : "after the selected duration"}.`);
  } catch (cause) {
    showError(cause, { prefix: completed ? `Edit access saved for ${plural(completed, "course")}. ` : "" });
  } finally {
    state.pendingSaveConfirmation = false;
    state.saveConfirmedFor = null;
    setBusy(false);
    await refresh();
  }
}

function normalizeDiscovery(result, siteAnchorId, prior = null) {
  if (!result || typeof result !== "object" || result.siteAnchorId !== siteAnchorId || typeof result.discoveryReceiptId !== "string" || !result.discoveryReceiptId
    || !Number.isFinite(result.expiresAt) || !Array.isArray(result.courses) || typeof result.complete !== "boolean"
    || !Number.isSafeInteger(result.pageNumber) || result.pageNumber < 1
    || !Number.isSafeInteger(result.courseCount) || result.courseCount < 0 || result.courseCount > DISCOVERY_PAGE_LIMIT) {
    throw new Error("course_discovery_failed");
  }
  const courseIds = new Set();
  const courses = result.courses.filter((course) => {
    const id = nativeCourseId(course?.id);
    if (!id || courseIds.has(id) || typeof course?.name !== "string" || !course.name) return false;
    courseIds.add(id);
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
    if (!sameIdentity || result.pageNumber !== prior.pageNumber + 1 || state.discoverySelected.size) throw new Error("course_discovery_failed");
  }
  return { ...result, courses };
}

async function startDiscovery() {
  const anchor = selectedAnchor();
  if (!anchor || state.busy) return;
  setBusy(true);
  clearError();
  clearNotice();
  try {
    const discovery = normalizeDiscovery(await request("morrow_course_discovery_start", { siteAnchorId: anchor.siteAnchorId }), anchor.siteAnchorId);
    state.discovery = discovery;
    state.discoverySelected.clear();
    state.filter = "";
    courseFilter.value = "";
    state.page = 0;
    state.view = "available";
    if (discoveryExpired()) throw new Error("course_discovery_receipt_stale");
  } catch (cause) {
    state.discovery = null;
    state.discoverySelected.clear();
    state.view = "connected";
    showError(cause);
  } finally {
    setBusy(false);
  }
}

function selectedNativeCourseIds() {
  const selected = new Set(state.discoverySelected);
  const values = [];
  for (const course of state.discovery?.courses || []) {
    const id = nativeCourseId(course?.id);
    if (id && selected.delete(id)) values.push(Number(id));
  }
  return selected.size ? [] : values;
}

async function loadMoreCourses() {
  const discovery = state.discovery;
  if (!discovery || state.busy || discovery.complete) return;
  if (discoveryExpired()) {
    showError("course_discovery_receipt_stale");
    render();
    return;
  }
  if (state.discoverySelected.size) {
    showNotice("Connect or clear selected courses before loading the next page.");
    render();
    return;
  }
  setBusy(true);
  clearError();
  clearNotice();
  try {
    state.discovery = normalizeDiscovery(await request("morrow_course_discovery_more", {
      siteAnchorId: discovery.siteAnchorId,
      discoveryReceiptId: discovery.discoveryReceiptId
    }), discovery.siteAnchorId, discovery);
  } catch (cause) {
    const code = String(cause?.message || cause);
    if (code === "course_discovery_receipt_missing" || code === "course_discovery_receipt_stale") state.discovery = { ...discovery, requiresRefresh: true };
    showError(code === "course_discovery_failed" ? "course_discovery_more_failed" : cause);
  } finally {
    setBusy(false);
  }
}

async function connectSelectedCourses() {
  if (state.busy || discoveryExpired()) {
    showError("course_discovery_receipt_stale");
    render();
    return;
  }
  const courseIds = selectedNativeCourseIds();
  if (!courseIds.length) {
    showError("course_selection_invalid");
    return;
  }
  const { siteAnchorId, discoveryReceiptId } = state.discovery;
  setBusy(true);
  clearError();
  clearNotice();
  try {
    const result = await request("morrow_course_selection_save", { siteAnchorId, discoveryReceiptId, courseIds });
    const connected = new Set((result?.bindings || []).map((binding) => nativeCourseId(binding?.courseId)).filter(Boolean));
    if (result?.siteAnchorId !== siteAnchorId || connected.size !== courseIds.length || courseIds.some((id) => !connected.has(String(id)))) {
      throw new Error("course_selection_target_refused");
    }
    state.discoverySelected.clear();
    state.page = 0;
    showNotice(`${plural(courseIds.length, "course")} connected in Plan. Continue through the available-course pages or view connected courses.`);
  } catch (cause) {
    const code = String(cause?.message || cause);
    if (code === "course_discovery_receipt_missing" || code === "course_discovery_receipt_stale") {
      state.discovery = { ...state.discovery, requiresRefresh: true };
    }
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

categoryList.addEventListener("change", (event) => {
  const input = event.target;
  if (!(input instanceof HTMLInputElement) || input.type !== "checkbox") return;
  if (input.checked) state.selectedCategories.add(input.value);
  else state.selectedCategories.delete(input.value);
  state.pendingSaveConfirmation = false;
  renderSelection();
});

actionFilter.addEventListener("input", () => {
  state.actionFilter = actionFilter.value;
  renderCategories();
});

actionCheckedOnly.addEventListener("change", () => {
  state.actionCheckedOnly = actionCheckedOnly.checked;
  renderCategories();
});

editDuration.addEventListener("change", () => renderSelection());

courseFilter.addEventListener("input", () => {
  state.filter = courseFilter.value;
  state.page = 0;
  renderCourses();
  renderSelection();
});

selectVisible.addEventListener("click", () => {
  const availableView = state.view === "available";
  const selectable = availableView ? currentPage().bindings : currentPage().bindings.filter(isEligible);
  const allSelected = selectable.length && selectable.every((binding) => availableView
    ? state.discoverySelected.has(binding.courseId)
    : state.selected.has(binding.sourceBindingId));
  for (const binding of selectable) {
    if (availableView) {
      if (allSelected) state.discoverySelected.delete(binding.courseId);
      else state.discoverySelected.add(binding.courseId);
    } else if (allSelected) state.selected.delete(binding.sourceBindingId);
    else state.selected.add(binding.sourceBindingId);
  }
  if (!availableView) {
    rebuildCategories();
    reconcileSelectedCategories();
  }
  render();
  if (!availableView) void refreshSelectedOptions();
});

courseList.addEventListener("click", (event) => {
  if (!(event.target instanceof Element) || event.target.closest("input, button, a, summary, details")) return;
  const card = event.target.closest(".course-card");
  if (!card || card.classList.contains("is-unavailable")) return;
  const input = card.querySelector(".available-course-select, .course-select");
  if (input instanceof HTMLInputElement && !input.disabled) input.click();
});

courseList.addEventListener("change", (event) => {
  const input = event.target;
  if (!(input instanceof HTMLInputElement)) return;
  if (input.classList.contains("available-course-select")) {
    const card = input.closest("[data-course-id]");
    const id = nativeCourseId(card?.dataset.courseId);
    if (!id) return;
    if (input.checked) state.discoverySelected.add(id);
    else state.discoverySelected.delete(id);
    render();
    return;
  }
  if (!input.classList.contains("course-select")) return;
  const card = input.closest("[data-binding-id]");
  const id = card?.dataset.bindingId;
  if (!id) return;
  if (input.checked) state.selected.add(id);
  else state.selected.delete(id);
  state.pendingSaveConfirmation = false;
  rebuildCategories();
  reconcileSelectedCategories();
  render();
  void refreshSelectedOptions();
});

refreshButton.addEventListener("click", () => void refresh());
siteAnchor.addEventListener("change", () => {
  if (state.view === "available") {
    state.discovery = null;
    state.discoverySelected.clear();
    state.view = "connected";
    state.page = 0;
  }
  render();
});
discoverCoursesButton.addEventListener("click", () => void startDiscovery());
loadMoreCoursesButton.addEventListener("click", () => void loadMoreCourses());
showConnectedButton.addEventListener("click", () => {
  state.view = "connected";
  state.page = 0;
  state.filter = "";
  courseFilter.value = "";
  render();
});
connectSelectedButton.addEventListener("click", () => void connectSelectedCourses());
previousPage.addEventListener("click", () => {
  state.page = Math.max(0, state.page - 1);
  renderCourses();
});
nextPage.addEventListener("click", () => {
  const { totalPages } = currentPage();
  state.page = Math.min(totalPages - 1, state.page + 1);
  renderCourses();
});
returnPlanButton.addEventListener("click", () => void returnToPlan(selectedBindings()));
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
});
enableFileStorageButton.addEventListener("click", () => void enableCourseFileStorageAccess());
revokeFileStorageButton.addEventListener("click", () => void revokeCourseFileStorageAccess());

chrome.storage?.onChanged?.addListener((_changes, areaName) => {
  if (areaName === "local") void refresh();
});
chrome.permissions?.onAdded?.addListener(() => void refreshCourseFileStorageAccess());
chrome.permissions?.onRemoved?.addListener(() => void refreshCourseFileStorageAccess());

await refresh();
