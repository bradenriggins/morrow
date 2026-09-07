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

export function canChooseCourses(status, binding = currentBinding(status), anchor = currentSiteAnchor(status)) {
  return !binding && anchor?.runtimeVerified === true;
}

// A null status means the status read failed. Every view below states that instead of leaving the
// popup on its markup defaults.
export function statusValue(status) {
  if (!status) return NOT_CHECKED;
  return status.connected ? "Connected" : status.pairing ? "Waiting for approval" : status.connecting ? "Connecting…" : status.paired ? "Not available" : "Not connected";
}

export function courseValue(status) {
  if (!status) return NOT_CHECKED;
  const binding = currentBinding(status);
  const anchor = currentSiteAnchor(status);
  return binding
    ? binding.runtimeVerified === true ? "Connected" : "Course site tab needed"
    : anchor?.runtimeVerified === true ? "Ready" : anchor ? "Course site tab needed" : "Not connected";
}

export function primaryLabel(status) {
  if (!status) return "Try again";
  return status.pairing ? "Waiting for approval" : !status.paired ? "Connect Morrow" : canChooseCourses(status) ? "Choose courses" : !status.connected ? "Waiting for your assistant" : "Connect course site";
}

export function detailText(status) {
  if (!status) return "Morrow could not read this connection state. Select Try again. If the state does not change, close this popup and open it again.";
  const binding = currentBinding(status);
  const anchor = currentSiteAnchor(status);
  return status.pairing
    ? "Confirm this connection on the Morrow page that opens. Then return to this popup."
    : !status.paired
      ? "Add Morrow to your assistant, then open it. Select Connect Morrow to continue."
      : status.connecting
        ? "Connecting to Morrow. Keep this popup open or return in a moment."
        : !status.connected
        ? "Open the assistant where you added Morrow. This popup will reconnect when Morrow is ready."
        : binding?.runtimeVerified === true
          ? "This selected course is connected. Keep one signed-in course site tab open while you work in Morrow."
          : binding
            ? "This selected course is connected, but its course site tab is no longer open. Open a signed-in course from this site in Chrome, then select Connect course site."
            : anchor?.runtimeVerified === true
              ? "Choose courses in Plan and Edit settings. Plan keeps changes ready for your review."
              : anchor
                ? "The saved course site is no longer open. Open a signed-in course from this site in Chrome, then connect the course site again."
                : "Morrow is connected. Open a signed-in Canvas or Moodle course in Chrome, then select Connect course site.";
}

export function controlState(status, { actionInFlight = false } = {}) {
  if (!status) return { primaryDisabled: actionInFlight, primaryBusy: actionInFlight, secondaryDisabled: true };
  const waiting = Boolean(status.pairing || (!canChooseCourses(status) && status.paired && !status.connected));
  return {
    primaryDisabled: actionInFlight || waiting,
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
