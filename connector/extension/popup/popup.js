import { problemText } from "../src/bridge-problem-copy.js";
import { canChooseCourses, controlState, courseValue, currentBinding, currentSiteAnchor, detailText, nextError, primaryLabel, runtimeNeedsReload, statusValue } from "./popup-view.js";

const primary = document.querySelector("#primary");
const canvasAction = document.querySelector("#canvas-action");
const disconnect = document.querySelector("#disconnect");
const label = document.querySelector("#status-label");
const value = document.querySelector("#status-value");
const courseLabel = document.querySelector("#course-label");
const canvasValue = document.querySelector("#canvas-value");
const pulse = document.querySelector("#pulse");
const detail = document.querySelector("#detail");
const error = document.querySelector("#error");
const account = document.querySelector("#account");
const accountLabel = document.querySelector("#account-label");
const accountOrigin = document.querySelector("#account-origin");
const accountLastChecked = document.querySelector("#account-last-checked");
const notice = document.querySelector("#notice");
const editAccess = document.querySelector(".edit-access");
const editingSettings = document.querySelector("#editing-settings");
const setupGuide = document.querySelector("#setup-guide");
let current = null;
let actionInFlight = false;
let banner = null;
let readGeneration = 0;

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

function render(status) {
  current = status;
  const binding = currentBinding(status);
  const anchor = currentSiteAnchor(status);
  const chooseCourses = canChooseCourses(status, binding, anchor);
  const runtimeReady = status?.connected === true && !runtimeNeedsReload(status);
  pulse.classList.toggle("online", runtimeReady);
  label.textContent = "Morrow";
  value.textContent = statusValue(status);
  account.hidden = !binding && !anchor;
  if (binding || anchor) {
    accountLabel.textContent = binding ? "Selected course" : anchor?.runtimeVerified === true ? "Signed-in course site" : "Saved course site";
    accountOrigin.textContent = binding
      ? `${binding.courseName || "Selected course"}${status.bindingCount > 1 ? ` · ${status.bindingCount} courses selected` : ""}`
      : `${anchor?.provider === "moodle" ? "Moodle" : anchor?.provider === "canvas" ? "Canvas" : "Course"} signed-in site`;
    setLastChecked(binding?.lastSeenAt ?? anchor?.lastSeenAt);
  }
  courseLabel.textContent = binding ? "Selected course" : anchor?.runtimeVerified === true ? "Course selection" : anchor ? "Course site" : "Course";
  canvasValue.textContent = courseValue(status);
  disconnect.hidden = status?.paired !== true;
  primary.hidden = Boolean(runtimeReady && binding?.runtimeVerified === true);
  canvasAction.hidden = !(runtimeReady && binding?.runtimeVerified === true);
  editAccess.hidden = status?.paired !== true || !runtimeReady || chooseCourses || (!binding && !anchor);
  setupGuide.hidden = runtimeNeedsReload(status);
  primary.textContent = primaryLabel(status);
  detail.textContent = detailText(status);
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
  const controls = controlState(status, { actionInFlight });
  primary.disabled = controls.primaryDisabled;
  primary.setAttribute("aria-busy", String(controls.primaryBusy));
  canvasAction.disabled = controls.secondaryDisabled;
  disconnect.disabled = controls.secondaryDisabled;
}

async function refresh() {
  const generation = ++readGeneration;
  try {
    const status = await message("morrow_status");
    if (generation !== readGeneration) return;
    render(status);
    reportSuccess("status");
  } catch (cause) {
    if (generation !== readGeneration) return;
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
  await runAction(connectCanvasCourse, () => clearNotice());
});

editingSettings.addEventListener("click", () => {
  void chrome.runtime.openOptionsPage();
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
