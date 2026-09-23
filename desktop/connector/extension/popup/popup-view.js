import { problemCode, VERSION_MISMATCH_RECOVERY } from "../src/bridge-problem-copy.js";
import { CURATED_CATEGORY_SPECS } from "../src/edit-policy.js";

const NOT_CHECKED = "Not checked";

// WI-5.8: every curated category id that is routine, grouped by provider. A static table, the same
// one settings.js keeps (ROUTINE_CATEGORY_IDS_BY_PROVIDER), so the popup's D7 state text needs no
// extra fetch beyond morrow_edit_policy_status.
const ROUTINE_CATEGORY_IDS_BY_PROVIDER = CURATED_CATEGORY_SPECS.filter((spec) => spec.routine === true)
  .reduce((byProvider, spec) => {
    (byProvider[spec.provider] ||= []).push(spec.id);
    return byProvider;
  }, {});

/**
 * A grant saved while Edit was timed still carries its own end time, and it lapses to Plan then.
 * Every newer grant has none: Edit stays on until the educator turns it off.
 */
function permissionLapsed(permission) {
  return Number.isFinite(permission?.expiresAt) && permission.expiresAt <= Date.now();
}

/**
 * D7: one connection's own state text, read only from its editPermission summary. A permission
 * present in morrow_edit_policy_status's bindings is already fresh (the service worker filters out
 * a lapsed or catalog-stale one), so the popup needs no separate staleness check to show it (see
 * settings.js's isStale for the fuller check Plan and Edit settings keeps for other reasons).
 */
export function courseStateText(binding) {
  const permission = binding?.editPermission;
  const ids = Array.isArray(permission?.enabledCategories) ? permission.enabledCategories.filter((id) => typeof id === "string") : [];
  if (!ids.length || permissionLapsed(permission)) return "Plan. Asks first.";
    const routineIds = ROUTINE_CATEGORY_IDS_BY_PROVIDER[binding.provider] || [];
  const isRoutine = routineIds.length > 0 && ids.length === routineIds.length && routineIds.every((id) => ids.includes(id));
  if (isRoutine) return "Edit. Routine edits.";
  if (ids.length === 1) return "Edit. 1 kind of edit.";
  return "Edit. Custom.";
}

/**
 * WI-5.8: the popup's own course list, "up to 5, then All courses". `editBindings` is
 * morrow_edit_policy_status's own bindings array, the one source that carries both the course name
 * and the live editPermission summary together.
 */
export function connectedCourseRows(editBindings, limit = 5) {
  const eligible = (Array.isArray(editBindings) ? editBindings : [])
    .filter((binding) => typeof binding?.sourceBindingId === "string" && binding.sourceBindingId && typeof binding.courseName === "string" && binding.courseName);
  const rows = eligible.map((binding) => ({
    sourceBindingId: binding.sourceBindingId,
    name: binding.courseName,
    state: courseStateText(binding),
  }));
  return { shown: rows.slice(0, limit), more: Math.max(0, rows.length - limit) };
}

function siteAnchors(status) {
  return Array.isArray(status?.siteAnchors) ? status.siteAnchors : [];
}

export function currentSiteAnchor(status) {
  const anchors = siteAnchors(status);
  return anchors.find((anchor) => anchor?.runtimeVerified === true) || anchors.at(-1) || null;
}

export function currentBinding(status) {
  return status?.bindings?.at(-1) || null;
}

// WI-2.4 (D1b): the reviews that wait, pushed by the runtime's ui_state command and kept by the
// Bridge in memory only. The popup lists them; it never opens one by itself. They belong to the
// Morrow connection that sent them, so none shows while Morrow is not connected.
export function pendingReviews(status) {
  return status?.connected === true && Array.isArray(status?.reviews)
    ? status.reviews.filter((review) => review && typeof review.url === "string" && typeof review.label === "string")
    : [];
}

export function reviewButtonLabel(review) {
  return `Review: ${review.label}`;
}

function providerName(provider) {
  return provider === "canvas" ? "Canvas" : provider === "moodle" ? "Moodle" : "";
}

export function currentPlatform(status, detectedProvider = null) {
  const detected = providerName(detectedProvider);
  if (detected) return detected;
  return providerName(currentBinding(status)?.provider || currentSiteAnchor(status)?.provider);
}

// Morrow refused this Bridge build (versionMismatch), or a connection is open but Morrow's answer
// does not match this extension. An update and a reload fix both, not connecting again.
export function runtimeNeedsReload(status) {
  return status?.versionMismatch === true || (status?.connected === true && status.runtimeHealthy !== true);
}

export function canChooseCourses(status, binding = currentBinding(status), anchor = currentSiteAnchor(status)) {
  return status?.runtimeHealthy === true && !binding && anchor?.runtimeVerified === true;
}

// A null status means the status read failed. Every view below states that instead of leaving the
// popup on its markup defaults.
export function statusValue(status) {
  if (!status) return NOT_CHECKED;
  if (runtimeNeedsReload(status)) return "Reload needed";
  if (status.authenticationFailed === true) return "Reconnect needed";
  return status.connected ? "Connected" : status.connecting ? "Connecting…" : status.paired ? "Not available" : "Not connected";
}

export function courseValue(status) {
  if (!status) return NOT_CHECKED;
  if (runtimeNeedsReload(status)) return "Not available";
  if (status.authenticationFailed === true) return currentBinding(status) || currentSiteAnchor(status) ? "Saved" : "Not connected";
  const binding = currentBinding(status);
  const anchor = currentSiteAnchor(status);
  const platform = currentPlatform(status);
  return binding
    ? binding.runtimeVerified === true ? "Connected" : `${platform || "Course"} is closed`
    : anchor?.runtimeVerified === true ? "Ready" : anchor ? `${platform || "Course"} is closed` : "Not connected";
}

// WI-1.1: the saved course or site is otherwise usable, but its Canvas or Moodle tab is not open.
// The Bridge already holds the permission and the session it needs, so opening it is mechanics, not
// a new consent step (D1a): the popup offers one button rather than sending the person to Chrome.
export function platformClosed(status, binding = currentBinding(status), anchor = currentSiteAnchor(status)) {
  if (!status || status.paired !== true || status.connected !== true || runtimeNeedsReload(status)) return false;
  return Boolean((binding && binding.runtimeVerified !== true) || (!binding && anchor && anchor.runtimeVerified !== true));
}

/**
 * "Open Canvas" or "Open Moodle" for the WI-1.1 button: the saved platform, never the detected one;
 * "Opening Canvas" or "Opening Moodle" once the wait has been visible long enough to need it (WI-F.10).
 */
export function openPlatformLabel(status, binding = currentBinding(status), anchor = currentSiteAnchor(status), busy = false) {
  const platform = providerName(binding?.provider || anchor?.provider);
  if (platform === "Canvas") return busy ? "Opening Canvas" : "Open Canvas";
  if (platform === "Moodle") return busy ? "Opening Moodle" : "Open Moodle";
  return busy ? "Opening Canvas or Moodle" : "Open Canvas or Moodle";
}

function plural(count, singular, pluralForm = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/** WI-1.4: which bindings from morrow_edit_policy_status can act with no review right now. */
export function activeEditBindings(bindings) {
  return (Array.isArray(bindings) ? bindings : []).filter((binding) => {
    const permission = binding?.editPermission;
    return Boolean(binding?.sourceBindingId) && Array.isArray(permission?.enabledCategories) && permission.enabledCategories.length > 0
      && !permissionLapsed(permission);
  });
}

/** WI-1.4: null while no connection can act with no review, else the banner's one sentence. */
export function editBannerText(activeEditCount) {
  return activeEditCount > 0 ? `Morrow can make some changes with no review in ${plural(activeEditCount, "course")}.` : null;
}

export function statusAnnouncement(status) {
  if (status?.consentRequired === true) return "Morrow: Agreement required. Course: Not checked.";
  return `Morrow: ${statusValue(status)}. Course: ${courseValue(status)}.`;
}

// WI-5.8: one primary action for the present tab, and only one. Its wording never names a
// platform: the person already knows what course the active tab shows (D1a). popup.js hides this
// control instead, whenever the saved course's own tab needs reopening (platformClosed) or nothing
// is detected here, so "Connect this course", "Open Canvas"/"Open Moodle", or no primary action at
// all are the only three outcomes. The label and the step a click takes come from this one
// decision, so the button can never say one thing and do another.
export function primaryAction(status, detectedProvider = null) {
  if (!status) return { id: "retry", label: "Try again" };
  if (runtimeNeedsReload(status)) return { id: "open_setup", label: "Open setup guide" };
  if (status.authenticationFailed === true) return { id: "pair", label: "Reconnect Morrow" };
  if (!status.paired) return { id: "pair", label: "Connect Morrow" };
  if (canChooseCourses(status)) return { id: "choose_courses", label: "Choose courses" };
  if (!status.connected) return { id: "wait", label: "Waiting for your assistant" };
  return currentPlatform(status, detectedProvider) ? { id: "connect_course", label: "Connect this course" } : { id: "none", label: "" };
}

export function primaryLabel(status, detectedProvider = null) {
  return primaryAction(status, detectedProvider).label;
}

function courseTabName(platform) {
  return platform ? `${platform} course` : "Canvas or Moodle course";
}

function closedBindingDetail(platform, savedPlatform) {
  if (platform && platform !== savedPlatform) {
    return `The selected ${savedPlatform || "learning platform"} course is not open. Morrow Bridge detected ${platform} in this tab. Select ${savedPlatform ? `Open ${savedPlatform}` : "the platform button Morrow Bridge shows"} to reopen the selected course, or open it yourself in ${savedPlatform || "its learning platform"}.`;
  }
  return `This selected course is connected, but its ${savedPlatform || "learning platform"} tab is no longer open. Select ${savedPlatform ? `Open ${savedPlatform}` : "the platform button Morrow Bridge shows"} to reopen it.`;
}

function staleAnchorDetail(platform) {
  return `The saved ${platform || "learning platform"} connection is no longer open. Select ${platform ? `Open ${platform}` : "the platform button Morrow Bridge shows"} to reopen it.`;
}

export function detailText(status, detectedProvider = null) {
  if (!status) return "Morrow could not read this connection state. Select Try again. If the state does not change, close this popup and open it again.";
  if (runtimeNeedsReload(status)) return `The Morrow app and Morrow Bridge versions do not match. ${VERSION_MISMATCH_RECOVERY}`;
  const binding = currentBinding(status);
  const anchor = currentSiteAnchor(status);
  const platform = currentPlatform(status, detectedProvider);
  const savedPlatform = currentPlatform(status);
  return status.authenticationFailed === true
    ? "Morrow refused the connection Morrow Bridge saved. Select Reconnect Morrow to connect again. Your selected courses stay saved."
    : !status.paired
      ? "Add Morrow to your assistant, then open it. Select Connect Morrow to connect this extension to Morrow. Connecting does not approve changes to your courses."
      : status.connecting
        ? "Connecting to Morrow. Keep this popup open or return in a moment."
        : !status.connected
        ? "Open the assistant where you added Morrow. This popup will reconnect when Morrow is ready."
        : binding?.runtimeVerified === true
          ? `This selected course is connected. Keep one signed-in ${courseTabName(platform)} tab open while you work in Morrow.`
          : binding
            ? closedBindingDetail(platform, savedPlatform)
            : anchor?.runtimeVerified === true
              ? "Choose courses in Plan and Edit settings. Plan keeps changes ready for your review."
              : anchor
                ? staleAnchorDetail(platform)
                : platform
                  ? `Morrow Bridge detected ${platform}. Select Connect this course to allow access to this signed-in course.`
                  : "Open a signed-in Canvas or Moodle course in Chrome. Morrow Bridge will detect the platform and show Connect this course.";
}

export function controlState(status, { actionInFlight = false, detectedProvider = null } = {}) {
  if (!status) return { primaryDisabled: actionInFlight, primaryBusy: actionInFlight, secondaryDisabled: true };
  const waiting = Boolean(status.authenticationFailed !== true && !runtimeNeedsReload(status) && !canChooseCourses(status) && status.paired && !status.connected);
  const needsDetectedCourse = status.paired === true && status.connected === true
    && !canChooseCourses(status) && currentBinding(status)?.runtimeVerified !== true;
  return {
    primaryDisabled: actionInFlight || waiting || (needsDetectedCourse && !currentPlatform(status, detectedProvider)),
    primaryBusy: actionInFlight || status.connecting === true,
    secondaryDisabled: actionInFlight,
  };
}

// The banner answers the last request, and it carries the code rather than the sentence: the popup
// reads the words for that code from connector/extension/src/bridge-problem-copy.js. A successful
// status read clears a failed status read, but it does not answer a failed action: the service
// worker writes storage while an action runs, and that write refreshes this popup, which would
// otherwise erase the message before it can be read.
export function nextError(current, { source, cause } = {}) {
  if (cause) return { source, code: problemCode(cause) };
  return source === "status" && current?.source === "action" ? current : null;
}
