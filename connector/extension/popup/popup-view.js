import { problemCode } from "../src/bridge-problem-copy.js";

const NOT_CHECKED = "Not checked";

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

function providerName(provider) {
  return provider === "canvas" ? "Canvas" : provider === "moodle" ? "Moodle" : "";
}

export function currentPlatform(status, detectedProvider = null) {
  const detected = providerName(detectedProvider);
  if (detected) return detected;
  return providerName(currentBinding(status)?.provider || currentSiteAnchor(status)?.provider);
}

export function runtimeNeedsReload(status) {
  return status?.connected === true && status.runtimeHealthy !== true;
}

export function canChooseCourses(status, binding = currentBinding(status), anchor = currentSiteAnchor(status)) {
  return status?.runtimeHealthy === true && !binding && anchor?.runtimeVerified === true;
}

// A null status means the status read failed. Every view below states that instead of leaving the
// popup on its markup defaults.
export function statusValue(status) {
  if (!status) return NOT_CHECKED;
  if (runtimeNeedsReload(status)) return "Reload needed";
  return status.connected ? "Connected" : status.pairing ? "Waiting for approval" : status.connecting ? "Connecting…" : status.paired ? "Not available" : "Not connected";
}

export function courseValue(status) {
  if (!status) return NOT_CHECKED;
  if (runtimeNeedsReload(status)) return "Not available";
  const binding = currentBinding(status);
  const anchor = currentSiteAnchor(status);
  const platform = currentPlatform(status);
  return binding
    ? binding.runtimeVerified === true ? "Connected" : `${platform || "Course"} tab needed`
    : anchor?.runtimeVerified === true ? "Ready" : anchor ? `${platform || "Course"} tab needed` : "Not connected";
}

export function primaryLabel(status, detectedProvider = null) {
  if (!status) return "Try again";
  if (runtimeNeedsReload(status)) return "Open setup guide";
  if (status.pairing) return "Waiting for approval";
  if (!status.paired) return "Connect Morrow";
  if (canChooseCourses(status)) return "Choose courses";
  if (!status.connected) return "Waiting for your assistant";
  const platform = currentPlatform(status, detectedProvider);
  return platform ? `Connect ${platform}` : "Open Canvas or Moodle";
}

function courseTabName(platform) {
  return platform ? `${platform} course` : "Canvas or Moodle course";
}

function closedBindingDetail(platform, savedPlatform) {
  if (platform && platform !== savedPlatform) {
    return `The selected ${savedPlatform || "learning platform"} course is not open. Morrow Bridge detected ${platform}. Select Connect ${platform} to add it, or open the selected course in ${savedPlatform || "its learning platform"}.`;
  }
  return `This selected course is connected, but its ${savedPlatform || "learning platform"} tab is no longer open. Open the course in Chrome, sign in, then select ${savedPlatform ? `Connect ${savedPlatform}` : "the platform button Morrow Bridge shows"}.`;
}

function staleAnchorDetail(platform) {
  return `The saved ${platform || "learning platform"} connection is no longer open. Open a ${courseTabName(platform)} in Chrome, sign in, then select ${platform ? `Connect ${platform}` : "the platform button Morrow Bridge shows"}.`;
}

export function detailText(status, detectedProvider = null) {
  if (!status) return "Morrow could not read this connection state. Select Try again. If the state does not change, close this popup and open it again.";
  if (runtimeNeedsReload(status)) return "The Morrow app and Morrow Bridge versions do not match. Open the setup guide, update or repair Morrow Bridge, then reload Morrow Bridge in Chrome.";
  const binding = currentBinding(status);
  const anchor = currentSiteAnchor(status);
  const platform = currentPlatform(status, detectedProvider);
  const savedPlatform = currentPlatform(status);
  return status.pairing
    ? "Confirm this connection on the Morrow page that opens. Then return to this popup."
    : !status.paired
      ? "Add Morrow to your assistant, then open it. Select Connect Morrow to continue."
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
                  ? `Morrow Bridge detected ${platform}. Select Connect ${platform} to allow access to this signed-in course.`
                  : "Open a signed-in Canvas or Moodle course in Chrome. Morrow Bridge will detect the platform and show Connect Canvas or Connect Moodle.";
}

export function controlState(status, { actionInFlight = false, detectedProvider = null } = {}) {
  if (!status) return { primaryDisabled: actionInFlight, primaryBusy: actionInFlight, secondaryDisabled: true };
  const waiting = Boolean(status.pairing || (!canChooseCourses(status) && status.paired && !status.connected));
  const needsDetectedCourse = status.paired === true && status.connected === true
    && !canChooseCourses(status) && currentBinding(status)?.runtimeVerified !== true;
  return {
    primaryDisabled: actionInFlight || waiting || (needsDetectedCourse && !currentPlatform(status, detectedProvider)),
    primaryBusy: actionInFlight || status.pairing === true || status.connecting === true,
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
