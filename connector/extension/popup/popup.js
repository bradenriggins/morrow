const primary = document.querySelector("#primary");
const disconnect = document.querySelector("#disconnect");
const label = document.querySelector("#status-label");
const value = document.querySelector("#status-value");
const pulse = document.querySelector("#pulse");
const detail = document.querySelector("#detail");
const error = document.querySelector("#error");
const account = document.querySelector("#account");
const accountOrigin = document.querySelector("#account-origin");
let current = null;

async function message(type, fields = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...fields });
  if (!response?.ok) throw new Error(response?.error || "Morrow could not complete this request.");
  return response.result;
}

function render(status) {
  current = status;
  pulse.classList.toggle("online", status.connected);
  label.textContent = status.connected || status.connecting ? "Local MCP" : status.pairing ? "Pairing" : status.paired ? "MCP offline" : "Setup";
  value.textContent = status.connected ? "Ready" : status.pairing ? "Waiting for approval" : status.connecting ? "Connecting…" : status.paired ? "Waiting to reconnect" : "Not paired";
  const binding = status.bindings?.at(-1);
  account.hidden = !binding;
  accountOrigin.textContent = binding ? `${binding.origin}${binding.courseId ? ` · Course ${binding.courseId}` : ""}${status.bindingCount > 1 ? ` · ${status.bindingCount} accounts` : ""}` : "";
  disconnect.hidden = !status.paired;
  primary.disabled = Boolean(status.pairing || (status.paired && !status.connected));
  primary.textContent = status.pairing ? "Waiting for approval" : !status.paired ? "Connect to Morrow MCP" : "Connect this Canvas tab";
  detail.textContent = status.pairing
    ? "Approve the local pairing page. This popup will update when you return."
    : !status.paired
      ? "Start the Morrow MCP first. Then approve one local pairing page. No Canvas token is copied."
      : status.connecting
        ? "Connecting to the Morrow MCP. This connector will update when the local bridge is ready."
        : !status.connected
        ? "The Morrow MCP is offline. Start or restart it. This connector will reconnect automatically."
        : "Open the exact signed-in Canvas course, then connect it. Morrow requests access only to that site.";
}

async function refresh() {
  try { render(await message("morrow_status")); }
  catch (cause) { showError(cause); }
}

function showError(cause) {
  error.hidden = false;
  error.textContent = String(cause?.message || cause);
}

function permissionPattern(value) {
  const url = new URL(value);
  return `${url.protocol}//${url.hostname}/*`;
}

async function authorizeActiveCanvasTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url?.startsWith("https://")) throw new Error("Open the signed-in Canvas course that Morrow should use.");
  const origins = new Set([permissionPattern(tab.url)]);
  const frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id }).catch(() => []);
  for (const frame of frames || []) {
    try {
      const url = new URL(frame.url);
      if (/^[^.]+\.quiz-(?:lti|api)(?:-[^.]+)*\.instructure\.com$/i.test(url.hostname)) origins.add(permissionPattern(url.href));
    } catch {}
  }
  if (!await chrome.permissions.request({ origins: [...origins] })) throw new Error("Morrow needs access to this exact Canvas site.");
  return tab.id;
}

primary.addEventListener("click", async () => {
  primary.disabled = true;
  error.hidden = true;
  try {
    if (!current?.paired) await message("morrow_pair");
    else {
      const tabId = await authorizeActiveCanvasTab();
      await message("morrow_connect_canvas", { tabId });
    }
    await refresh();
  } catch (cause) {
    showError(cause);
  } finally {
    primary.disabled = Boolean(current?.pairing || (current?.paired && !current?.connected));
  }
});

disconnect.addEventListener("click", async () => {
  disconnect.disabled = true;
  error.hidden = true;
  try {
    await message("morrow_disconnect");
    await refresh();
  } catch (cause) {
    showError(cause);
  } finally {
    disconnect.disabled = false;
  }
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
