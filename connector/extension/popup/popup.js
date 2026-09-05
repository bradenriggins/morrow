const primary = document.querySelector("#primary");
const canvasAction = document.querySelector("#canvas-action");
const disconnect = document.querySelector("#disconnect");
const label = document.querySelector("#status-label");
const value = document.querySelector("#status-value");
const canvasValue = document.querySelector("#canvas-value");
const pulse = document.querySelector("#pulse");
const detail = document.querySelector("#detail");
const error = document.querySelector("#error");
const account = document.querySelector("#account");
const accountOrigin = document.querySelector("#account-origin");
const accountLastChecked = document.querySelector("#account-last-checked");
const notice = document.querySelector("#notice");
let current = null;
let actionInFlight = false;

async function message(type, fields = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...fields });
  if (!response?.ok) throw new Error(response?.error || "Morrow could not complete this request.");
  return response.result;
}

function render(status) {
  current = status;
  pulse.classList.toggle("online", status.connected);
  label.textContent = "Morrow";
  value.textContent = status.connected ? "Connected" : status.pairing ? "Waiting for approval" : status.connecting ? "Connecting…" : status.paired ? "Not available" : "Not connected";
  const binding = status.bindings?.at(-1);
  const courseOpen = binding?.runtimeVerified === true;
  account.hidden = !binding;
  accountOrigin.textContent = binding ? `${binding.courseName || "Course"} · ${binding.siteUrl || binding.origin}${status.bindingCount > 1 ? ` · ${status.bindingCount} saved connections` : ""}` : "";
  setLastChecked(binding?.lastSeenAt);
  canvasValue.textContent = binding ? courseOpen ? "Course tab open" : "Course tab needed" : "Not connected";
  disconnect.hidden = !status.paired;
  primary.hidden = Boolean(status.connected && courseOpen);
  canvasAction.hidden = !(status.connected && courseOpen);
  primary.textContent = status.pairing ? "Waiting for approval" : !status.paired ? "Connect Morrow" : !status.connected ? "Waiting for your assistant" : "Connect course";
  detail.textContent = status.pairing
    ? "Confirm this connection on the Morrow page that opens. Then return to this popup."
    : !status.paired
      ? "Add Morrow to your assistant, then open it. Select Connect Morrow to continue."
      : status.connecting
        ? "Connecting to Morrow. Keep this popup open or return in a moment."
        : !status.connected
        ? "Open the assistant where you added Morrow. This popup will reconnect when Morrow is ready."
        : courseOpen
          ? "Keep this course open and return to the assistant where you started this request. Morrow checks your sign-in before each request."
          : binding
            ? "The saved course is no longer open. Open a signed-in Canvas or Moodle course in Chrome, then select Connect course."
          : "Morrow is connected. Open a signed-in Canvas or Moodle course in Chrome, then select Connect course.";
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
  if (!status) return;
  primary.disabled = actionInFlight || Boolean(status.pairing || (status.paired && !status.connected));
  primary.setAttribute("aria-busy", String(actionInFlight || status.pairing || status.connecting));
  canvasAction.disabled = actionInFlight;
  disconnect.disabled = actionInFlight;
}

async function refresh() {
  try { render(await message("morrow_status")); }
  catch (cause) { showError(cause); }
}

function showError(cause) {
  error.hidden = false;
  const message = String(cause?.message || cause || "").toLowerCase();
  error.textContent = message.includes("blackboard browser access")
    ? "Blackboard browser access is not yet verified in this preview."
    : message.includes("signed-in")
    ? "Open a Canvas or Moodle course in Chrome and sign in. Then select Connect course."
    : message.includes("morrow and morrow course connector versions do not match")
      ? "Morrow and Morrow Course Connector versions do not match. Update or reload Morrow Course Connector in Chrome."
    : message.includes("access to this exact course site") || message.includes("permission") || message.includes("denied")
      ? "Allow Morrow to access this course site, then try again."
      : "Morrow could not complete that step. Open the assistant where you added Morrow, then try again.";
}

function clearError() {
  error.hidden = true;
  error.textContent = "";
}

function showNotice(message) {
  notice.hidden = false;
  notice.textContent = message;
}

function clearNotice() {
  notice.hidden = true;
  notice.textContent = "";
}

function permissionPattern(value) {
  const url = new URL(value);
  return `${url.protocol}//${url.hostname}/*`;
}

async function authorizeActiveCanvasTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url?.startsWith("https://")) throw new Error("Open the signed-in course that Morrow should use.");
  const origins = new Set([permissionPattern(tab.url)]);
  const frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id }).catch(() => []);
  for (const frame of frames || []) {
    try {
      const url = new URL(frame.url);
      if (/^[^.]+\.quiz-(?:lti|api)(?:-[^.]+)*\.instructure\.com$/i.test(url.hostname)) origins.add(permissionPattern(url.href));
    } catch {}
  }
  if (!await chrome.permissions.request({ origins: [...origins] })) throw new Error("Morrow needs access to this exact course site.");
  return tab.id;
}

async function runAction(action, onSuccess = () => {}) {
  if (actionInFlight) return;
  actionInFlight = true;
  updateControls();
  try {
    const result = await action();
    clearError();
    onSuccess(result);
    await refresh();
  } catch (cause) {
    showError(cause);
  } finally {
    actionInFlight = false;
    updateControls();
  }
}

async function connectCanvasCourse() {
  const tabId = await authorizeActiveCanvasTab();
  return await message("morrow_connect_course", { tabId });
}

primary.addEventListener("click", async () => {
  await runAction(async () => {
    if (!current?.paired) return await message("morrow_pair");
    return await connectCanvasCourse();
  }, () => clearNotice());
});

canvasAction.addEventListener("click", async () => {
  await runAction(connectCanvasCourse, () => clearNotice());
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
