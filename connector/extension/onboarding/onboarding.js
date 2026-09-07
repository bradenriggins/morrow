import { problemCode, problemText } from "../src/bridge-problem-copy.js";
import { SETUP_CHECK_IDS, SETUP_MODE_KEY, setupGuideState, shouldRefreshForStorageChange } from "./onboarding-state.js";

const guideMode = document.querySelector("#guide-mode");
const quickMode = document.querySelector("#quick-mode");
const guidePanel = document.querySelector("#guide-panel");
const quickPanel = document.querySelector("#quick-panel");
const readinessTitle = document.querySelector("#readiness-title");
const readinessDetail = document.querySelector("#readiness-detail");
const checkLines = Object.fromEntries(SETUP_CHECK_IDS.map((id) => [id, document.querySelector(`#${id}-check`)]));
const statusDot = document.querySelector("#status-dot");
const nextTitle = document.querySelector("#next-title");
const nextDetail = document.querySelector("#next-detail");
const openSettings = document.querySelector("#open-settings");
const guideAssistant = document.querySelector("#guide-assistant");
const quickOpenSettings = document.querySelector("#quick-open-settings");
const error = document.querySelector("#error");

// Four triggers can fire together: returning to the tab raises both visibilitychange and focus, and
// the service worker writes storage and sends its message for one change. One read answers them all.
const REFRESH_DELAY_MS = 250;
let refreshTimer = null;
let readGeneration = 0;

// Every failure the service worker answers carries its own code, and this guide keeps that code as
// the error it raises, so the page can name the state and the next action.
async function message(type, fields = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...fields });
  if (!response?.ok) throw new Error(response?.code || response?.error || "bridge_request_failed");
  return response.result;
}

// A null status means the status read failed. setupGuideState states that in every line it fills.
function render(status) {
  const state = setupGuideState(status);
  statusDot.classList.toggle("ready", state.tone === "ready");
  statusDot.classList.toggle("waiting", state.tone === "waiting");
  readinessTitle.textContent = state.heading;
  readinessDetail.textContent = state.summary;
  for (const check of state.checks) checkLines[check.id].textContent = check.text;
  nextTitle.textContent = state.title;
  nextDetail.textContent = state.detail;
  guideAssistant.hidden = !state.showAssistantGuide;
  openSettings.hidden = !state.canOpenSettings;
}

// The cause reaches the page, not only the console: one code becomes what happened, why, and the
// one next step, from connector/extension/src/bridge-problem-copy.js.
function showError(cause) {
  const code = problemCode(cause);
  error.hidden = false;
  error.textContent = problemText(code);
  console.warn("Morrow setup status failed", code, cause);
}

function clearError() {
  error.hidden = true;
  error.textContent = "";
}

function setMode(mode) {
  const quick = mode === "quick";
  guideMode.setAttribute("aria-pressed", String(!quick));
  quickMode.setAttribute("aria-pressed", String(quick));
  guidePanel.hidden = quick;
  quickPanel.hidden = !quick;
}

async function saveMode(mode) {
  setMode(mode);
  await chrome.storage.local.set({ [SETUP_MODE_KEY]: mode });
}

// A status read reaches the course tab, so a slow one can still be open when the next starts. The
// newest read owns the page: an earlier answer never replaces a later one.
async function refresh() {
  const generation = (readGeneration += 1);
  try {
    const status = await message("morrow_status");
    if (generation !== readGeneration) return;
    render(status);
    clearError();
  } catch (cause) {
    if (generation !== readGeneration) return;
    render(null);
    showError(cause);
  }
}

function scheduleRefresh() {
  if (refreshTimer !== null) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void refresh();
  }, REFRESH_DELAY_MS);
}

guideMode.addEventListener("click", () => { void saveMode("guide"); });
quickMode.addEventListener("click", () => { void saveMode("quick"); });
openSettings.addEventListener("click", () => { void chrome.runtime.openOptionsPage(); });
quickOpenSettings.addEventListener("click", () => { void chrome.runtime.openOptionsPage(); });
document.addEventListener("visibilitychange", () => { if (!document.hidden) scheduleRefresh(); });
window.addEventListener("focus", () => scheduleRefresh());
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (shouldRefreshForStorageChange(changes, areaName)) scheduleRefresh();
});
chrome.runtime.onMessage.addListener((incoming) => {
  if (incoming?.type === "morrow_bridge_status_changed") scheduleRefresh();
});

const saved = await chrome.storage.local.get(SETUP_MODE_KEY);
setMode(saved[SETUP_MODE_KEY] === "quick" ? "quick" : "guide");
await refresh();
