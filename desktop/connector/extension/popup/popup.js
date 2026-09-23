import { problemText } from "../src/bridge-problem-copy.js";
import { activeEditBindings, canChooseCourses, connectedCourseRows, controlState, courseValue, currentBinding, currentPlatform, currentSiteAnchor, detailText, editBannerText, nextError, openPlatformLabel, pendingReviews, platformClosed, primaryLabel, reviewButtonLabel, runtimeNeedsReload, statusAnnouncement, statusValue } from "./popup-view.js";

const primary = document.querySelector("#primary");
const consentAction = document.querySelector("#consent-action");
const consentDetail = document.querySelector("#consent-detail");
const dataDisclosure = document.querySelector("#data-disclosure");
const privacyLink = document.querySelector("#privacy-link");
const connectionContent = document.querySelector("#connection-content");
const canvasAction = document.querySelector("#canvas-action");
const openPlatformAction = document.querySelector("#open-platform-action");
const disconnect = document.querySelector("#disconnect");
const label = document.querySelector("#status-label");
const value = document.querySelector("#status-value");
const courseLabel = document.querySelector("#course-label");
const canvasValue = document.querySelector("#canvas-value");
const pulse = document.querySelector("#pulse");
const detail = document.querySelector("#detail");
const error = document.querySelector("#error");
const announcement = document.querySelector("#status-announcement");
const account = document.querySelector("#account");
const accountLabel = document.querySelector("#account-label");
const accountOrigin = document.querySelector("#account-origin");
const accountLastChecked = document.querySelector("#account-last-checked");
const notice = document.querySelector("#notice");
const editAccess = document.querySelector(".edit-access");
const editingSettings = document.querySelector("#editing-settings");
const setupGuide = document.querySelector("#setup-guide");
const editAccessBanner = document.querySelector("#edit-access-banner");
const editAccessBannerText = document.querySelector("#edit-access-banner-text");
const askFirstAllCoursesButton = document.querySelector("#ask-first-all-courses");
const reviewsWaiting = document.querySelector("#reviews-waiting");
const reviewsList = document.querySelector("#reviews-list");
const coursesSection = document.querySelector("#courses");
const coursesList = document.querySelector("#courses-list");
const allCoursesButton = document.querySelector("#all-courses");
let current = null;
let actionInFlight = false;
let banner = null;
let readGeneration = 0;
let detectedProvider = null;
let editActive = [];
let editBindings = [];
let openPlatformProgressVisible = false;

// Every failure the service worker answers carries its own code, and the popup keeps that code as
// the error it raises, so one state reaches the banner instead of one generic sentence.
async function message(type, fields = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...fields });
  if (!response?.ok) throw new Error(response?.code || response?.error || "bridge_request_failed");
  return response.result;
}

function openCourseSelection() {
  void chrome.runtime.openOptionsPage();
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
  })[character]);
}

// WI-2.4 (D1b): the reviews that wait. The Bridge never opens one by itself; a click opens the
// named address, and reuses an already open tab at that address rather than collecting a second one.
function renderReviews(status) {
  const reviews = pendingReviews(status);
  reviewsWaiting.hidden = reviews.length === 0;
  reviewsList.innerHTML = reviews
    .map((review) => `<button type="button" class="secondary" data-review-url="${escapeHtml(review.url)}">${escapeHtml(reviewButtonLabel(review))}</button>`)
    .join("");
}

async function openReview(url) {
  const [existing] = await chrome.tabs.query({ url });
  if (existing?.id !== undefined) {
    await chrome.tabs.update(existing.id, { active: true });
    return;
  }
  await chrome.tabs.create({ url });
}

/** WI-1.4: the "Ask first in all courses" banner, shown while any connection can act with no review. */
function renderEditBanner() {
  const text = editBannerText(editActive.length);
  editAccessBanner.hidden = text === null;
  if (text !== null) editAccessBannerText.textContent = text;
}

// WI-5.8: the popup as home. Up to 5 connected courses with their own D7 state text, then "All
// courses", which opens the same Plan and Edit settings page as "Open Plan and Edit settings"
// below. The list needs no per-row action: opening or switching a course belongs to the primary
// action and to Plan and Edit settings, not to this glance.
function renderCourses() {
  const { shown } = connectedCourseRows(editBindings);
  coursesSection.hidden = shown.length === 0;
  coursesList.innerHTML = shown
    .map((row) => `<li class="course-row"><span class="course-row-name">${escapeHtml(row.name)}</span><span class="course-row-state">${escapeHtml(row.state)}</span></li>`)
    .join("");
  allCoursesButton.hidden = shown.length === 0;
}

function render(status) {
  current = status;
  const nextAnnouncement = statusAnnouncement(status);
  if (announcement.textContent !== nextAnnouncement) announcement.textContent = nextAnnouncement;
  const consentRequired = status?.consentRequired === true;
  consentAction.hidden = !consentRequired;
  consentDetail.hidden = !consentRequired;
  connectionContent.hidden = consentRequired;
  consentAction.disabled = actionInFlight;
  // WI-5.8: the full data-use text shows only until the person accepts it. After that this popup
  // keeps one link to it, "What Morrow Bridge can read", instead of repeating the paragraph.
  dataDisclosure.hidden = !consentRequired;
  privacyLink.hidden = consentRequired;
  if (consentRequired) {
    pulse.classList.remove("online");
    editAccessBanner.hidden = true;
    reviewsWaiting.hidden = true;
    coursesSection.hidden = true;
    allCoursesButton.hidden = true;
    return;
  }
  renderReviews(status);
  renderEditBanner();
  const binding = currentBinding(status);
  const anchor = currentSiteAnchor(status);
  const chooseCourses = canChooseCourses(status, binding, anchor);
  const runtimeReady = status?.connected === true && !runtimeNeedsReload(status);
  pulse.classList.toggle("online", runtimeReady);
  label.textContent = "Morrow";
  value.textContent = statusValue(status);
  account.hidden = !binding && !anchor;
  if (binding || anchor) {
    accountLabel.textContent = binding ? "Course" : anchor?.runtimeVerified === true ? "Connected platform" : "Saved platform";
    accountOrigin.textContent = binding
      ? `${binding.courseName || "Selected course"}${status.bindingCount > 1 ? ` · ${status.bindingCount} courses selected` : ""}`
      : `${anchor?.provider === "moodle" ? "Moodle" : anchor?.provider === "canvas" ? "Canvas" : "Learning platform"}`;
    setLastChecked(binding?.lastSeenAt ?? anchor?.lastSeenAt);
  }
  courseLabel.textContent = binding ? "Connection" : anchor?.runtimeVerified === true ? "Course selection" : anchor ? "Learning platform" : "Course";
  canvasValue.textContent = courseValue(status);
  disconnect.hidden = status?.paired !== true;
  renderCourses();
  const alreadyConnected = Boolean(runtimeReady && binding?.runtimeVerified === true);
  canvasAction.hidden = !alreadyConnected;
  // WI-1.1: the saved site's own open action. It needs no active matching tab, unlike Connect,
  // because the Bridge already holds the permission and the session it needs (D1a).
  const closed = platformClosed(status, binding, anchor);
  openPlatformAction.hidden = !closed;
  if (closed) {
    openPlatformAction.textContent = openPlatformLabel(status, binding, anchor, openPlatformProgressVisible);
    openPlatformAction.setAttribute("aria-busy", String(openPlatformProgressVisible));
  }
  editAccess.hidden = status?.paired !== true || !runtimeReady || chooseCourses || (!binding && !anchor);
  setupGuide.hidden = runtimeNeedsReload(status);
  // WI-5.8: one primary action for the present tab. Reopening the saved course (closed) already has
  // its own control above, and an already-connected course needs none, so primary is hidden in both,
  // leaving "Connect this course" as the only text it ever shows.
  const primaryText = primaryLabel(status, detectedProvider);
  primary.hidden = alreadyConnected || closed || primaryText === "";
  primary.textContent = primaryText;
  detail.textContent = detailText(status, detectedProvider);
  updateControls(status);
}

function setLastChecked(lastSeenAt) {
  const date = new Date(typeof lastSeenAt === "number" && Number.isFinite(lastSeenAt) ? lastSeenAt : NaN);
  if (Number.isNaN(date.getTime())) {
    accountLastChecked.textContent = "Last checked time is not available";
    accountLastChecked.removeAttribute("datetime");
    return;
  }
  accountLastChecked.dateTime = date.toISOString();
  accountLastChecked.textContent = `Last checked ${new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" }).format(date)}`;
}

function updateControls(status = current) {
  consentAction.disabled = actionInFlight;
  if (status?.consentRequired === true) return;
  const controls = controlState(status, { actionInFlight, detectedProvider });
  primary.disabled = controls.primaryDisabled;
  primary.setAttribute("aria-busy", String(controls.primaryBusy));
  canvasAction.disabled = controls.secondaryDisabled;
  openPlatformAction.disabled = controls.secondaryDisabled;
  disconnect.disabled = controls.secondaryDisabled;
  askFirstAllCoursesButton.disabled = controls.secondaryDisabled || editActive.length === 0;
}

function focusFirstConnectionAction() {
  for (const control of [primary, canvasAction, openPlatformAction, disconnect, editingSettings, setupGuide]) {
    if (!control.hidden && !control.disabled) {
      control.focus();
      return;
    }
  }
}

async function refresh() {
  const generation = ++readGeneration;
  try {
    const status = await message("morrow_status");
    if (generation !== readGeneration) return;
    detectedProvider = null;
    editActive = [];
    editBindings = [];
    let editStatusFailure = null;
    // WI-1.4: morrow_status carries no editPermission per binding, so the popup reads the same
    // command the settings page uses to learn which connections can act with no review. Skipped
    // while choosing courses: no course is selected yet, so no Edit access can exist. WI-5.8: the
    // same read also gives the course list its own name and D7 state, so the popup fetches nothing
    // extra to show it. A failed read is named: hiding it would hide Edit access that is on.
    if (status?.consentRequired !== true && status?.paired === true && status?.connected === true && !canChooseCourses(status)) {
      let editStatus = null;
      try {
        editStatus = await message("morrow_edit_policy_status");
      } catch (cause) {
        editStatusFailure = cause;
      }
      if (generation !== readGeneration) return;
      editActive = activeEditBindings(editStatus?.bindings);
      editBindings = Array.isArray(editStatus?.bindings) ? editStatus.bindings : [];
    }
    if (status?.consentRequired !== true && status?.paired === true && status?.connected === true && !canChooseCourses(status)
      && currentBinding(status)?.runtimeVerified !== true) {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const result = await message("morrow_detect_course_platform", { tabId: tab?.id }).catch(() => null);
      if (generation !== readGeneration) return;
      detectedProvider = result?.provider === "canvas" || result?.provider === "moodle" ? result.provider : null;
    }
    render(status);
    if (editStatusFailure) reportError("status", editStatusFailure);
    else reportSuccess("status");
  } catch (cause) {
    if (generation !== readGeneration) return;
    editActive = [];
    editBindings = [];
    render(null);
    reportError("status", cause);
  }
}

async function retryStatus() {
  if (actionInFlight) return;
  actionInFlight = true;
  updateControls();
  try { await refresh(); }
  finally {
    actionInFlight = false;
    updateControls();
  }
}

function applyError(next) {
  banner = next;
  error.hidden = !banner;
  error.textContent = banner ? problemText(banner.code) : "";
}

function reportError(source, cause) {
  applyError(nextError(banner, { source, cause }));
}

function reportSuccess(source) {
  applyError(nextError(banner, { source }));
}

function showNotice(message) {
  notice.hidden = false;
  notice.textContent = message;
}

function clearNotice() {
  notice.hidden = true;
  notice.textContent = "";
}

async function cancelCourseConnection(intentId) {
  await message("morrow_connect_course_cancel", { intentId }).catch(() => {});
}

async function authorizeActiveCanvasTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url?.startsWith("https://")) throw new Error("course_tab_missing");
  const intent = await message("morrow_connect_course_prepare", { tabId: tab.id });
  let granted = false;
  try {
    granted = await chrome.permissions.request({ origins: intent.origins });
  } catch {
    // Chrome refused to open its own request, so the person never answered it.
    await cancelCourseConnection(intent.id);
    throw new Error("course_permission_prompt_missing");
  }
  if (!granted) {
    await cancelCourseConnection(intent.id);
    throw new Error("course_permission_denied");
  }
  return await message("morrow_connect_course_complete", { intentId: intent.id });
}

async function runAction(action, onSuccess = () => {}) {
  if (actionInFlight) return;
  actionInFlight = true;
  updateControls();
  try {
    const result = await action();
    reportSuccess("action");
    onSuccess(result);
    await refresh();
  } catch (cause) {
    reportError("action", cause);
  } finally {
    actionInFlight = false;
    updateControls();
  }
}

async function connectCanvasCourse() {
  return await authorizeActiveCanvasTab();
}

consentAction.addEventListener("click", async () => {
  if (actionInFlight) return;
  actionInFlight = true;
  let accepted = false;
  updateControls();
  try {
    await message("morrow_course_data_consent_accept");
    accepted = true;
    reportSuccess("action");
    await refresh();
  } catch (cause) {
    reportError("action", cause);
  } finally {
    actionInFlight = false;
    updateControls();
    if (accepted) focusFirstConnectionAction();
  }
});

primary.addEventListener("click", async () => {
  if (!current) {
    await retryStatus();
    return;
  }
  if (runtimeNeedsReload(current)) {
    clearNotice();
    await runAction(() => message("morrow_open_setup"));
    return;
  }
  if (canChooseCourses(current)) {
    clearNotice();
    openCourseSelection();
    return;
  }
  await runAction(async () => {
    if (current?.authenticationFailed === true) return await message("morrow_pair");
    if (!current?.paired) return await message("morrow_pair");
    return await connectCanvasCourse();
  }, (result) => {
    if (result?.siteAnchorId) {
      clearNotice();
      openCourseSelection();
    }
    else clearNotice();
  });
});

canvasAction.addEventListener("click", async () => {
  await runAction(connectCanvasCourse, (result) => {
    clearNotice();
    if (result?.siteAnchorId) openCourseSelection();
  });
});

// WI-1.1: opens the saved, already-permitted site itself. No permission prompt, because Chrome
// already granted this address; a sign-in is the only thing left that can still be necessary. The
// button disables at once, so a second click cannot start a second tab, but its text only changes
// to "Opening…" once the wait has run long enough to need it (WI-F.10): no flash of progress for a
// fast open. Matches settings.js's openSavedPlatform.
openPlatformAction.addEventListener("click", async () => {
  if (actionInFlight) return;
  const binding = currentBinding(current);
  const anchor = currentSiteAnchor(current);
  // A selected course opens only on its own site, never on another saved site that happens to be open.
  const siteAnchorId = binding ? binding.siteAnchorId : anchor?.siteAnchorId;
  if (!siteAnchorId) {
    reportError("action", new Error("platform_open_anchor_missing"));
    return;
  }
  const platform = currentPlatform(current);
  actionInFlight = true;
  openPlatformProgressVisible = false;
  updateControls();
  const revealTimer = setTimeout(() => {
    openPlatformProgressVisible = true;
    openPlatformAction.textContent = openPlatformLabel(current, binding, anchor, true);
    openPlatformAction.setAttribute("aria-busy", "true");
  }, 400);
  try {
    const result = await message("morrow_open_platform", binding?.sourceBindingId ? { siteAnchorId, sourceBindingId: binding.sourceBindingId } : { siteAnchorId });
    reportSuccess("action");
    if (result?.verified === false) showNotice(`Sign in to ${platform || "the learning platform"} in the tab that opened. Morrow continues after that.`);
    else clearNotice();
  } catch (cause) {
    reportError("action", cause);
  } finally {
    clearTimeout(revealTimer);
    actionInFlight = false;
    openPlatformProgressVisible = false;
    await refresh();
  }
});

reviewsList.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-review-url]");
  if (!button) return;
  void openReview(button.dataset.reviewUrl).catch((cause) => reportError("action", cause));
});

askFirstAllCoursesButton.addEventListener("click", async () => {
  const bindings = editActive;
  if (!bindings.length) return;
  await runAction(async () => {
    for (const binding of bindings) {
      const result = await message("morrow_edit_policy_revoke", { sourceBindingId: binding.sourceBindingId });
      if (result?.revoked !== true) throw new Error("edit_policy_revoke_unconfirmed");
    }
  }, () => showNotice("Done. Morrow asks first in all courses."));
});

editingSettings.addEventListener("click", () => {
  void chrome.runtime.openOptionsPage();
});

// WI-5.8: "All courses" opens the same Plan and Edit settings page as "Open Plan and Edit settings".
allCoursesButton.addEventListener("click", () => {
  openCourseSelection();
});

setupGuide.addEventListener("click", () => {
  void message("morrow_open_setup").catch((cause) => reportError("action", cause));
});

disconnect.addEventListener("click", async () => {
  await runAction(() => message("morrow_disconnect"), (result) => {
    if (result?.permissionsRevoked === false) {
      showNotice("Morrow is disconnected. Chrome site access still needs removal in this extension's settings.");
    } else {
      clearNotice();
    }
  });
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) void refresh();
});
window.addEventListener("focus", () => void refresh());
chrome.storage.onChanged.addListener((_changes, areaName) => {
  if (areaName === "local") void refresh();
});
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "morrow_bridge_status_changed") void refresh();
});

await refresh();
