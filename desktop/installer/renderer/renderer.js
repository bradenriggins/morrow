import {
  actionView,
  assistantFor,
  awaitingBridgeFolder,
  blackboardSetupOffered,
  configuredAssistant,
  escapeHtml,
  pendingAssistant,
  problemView,
  progress,
  removalAnnouncement,
  retentionView,
  setupManagementView,
  setupUnavailableView,
  statusSummary,
  supportView
} from "../shared/setup-view.mjs";

const API = globalThis.morrowInstaller;
const setupMain = document.querySelector("#setup");
const refreshButton = document.querySelector("#refresh");
const headerStatus = document.querySelector("#header-status");
const navHome = document.querySelector("#nav-home");
const navSettings = document.querySelector("#nav-settings");
const homeView = document.querySelector("#home-view");
const settingsView = document.querySelector("#settings-view");
const setupIntro = document.querySelector(".intro");
const platformNotes = [document.querySelector("#windows-note"), document.querySelector("#macos-note")];
const progressList = document.querySelector("#progress-list");
const loading = document.querySelector("#loading");
const actionContent = document.querySelector("#action-content");
const actionTitle = document.querySelector("#action-title");
const actionCopy = document.querySelector("#action-copy");
const actionBody = document.querySelector("#action-body");
const problem = document.querySelector("#problem");
const setupManagementPanel = document.querySelector("#setup-management-panel");
const setupManagementTitle = document.querySelector("#setup-management-title");
const setupManagementBody = document.querySelector("#setup-management-body");
const updatesPanel = document.querySelector("#updates-panel");
const updatesTitle = document.querySelector("#updates-title");
const updatesCopy = document.querySelector("#updates-copy");
const updatesActions = document.querySelector("#updates-actions");
const blackboardPanel = document.querySelector("#blackboard-panel");
const blackboardSummary = document.querySelector("#blackboard-summary");
const blackboardCopy = document.querySelector("#blackboard-copy");
const blackboardAdminNote = document.querySelector("#blackboard-admin-note");
const blackboardTenantRow = document.querySelector("#blackboard-tenant");
const blackboardSavedNote = document.querySelector("#blackboard-saved-note");
const blackboardReplaceNote = document.querySelector("#blackboard-replace-note");
const blackboardForm = document.querySelector("#blackboard-form");
const blackboardBaseUrl = document.querySelector("#blackboard-base-url");
const blackboardBaseUrlError = document.querySelector("#blackboard-base-url-error");
const blackboardApplicationKey = document.querySelector("#blackboard-application-key");
const blackboardApplicationKeyError = document.querySelector("#blackboard-application-key-error");
const blackboardSecret = document.querySelector("#blackboard-application-secret");
const blackboardSecretError = document.querySelector("#blackboard-application-secret-error");
const blackboardSubmit = document.querySelector("#blackboard-submit");
const blackboardCourses = document.querySelector("#blackboard-courses");
const blackboardCoursesCopy = document.querySelector("#blackboard-courses-copy");
const blackboardCourseList = document.querySelector("#blackboard-course-list");
const retentionPanel = document.querySelector("#retention-panel");
const retentionSummary = document.querySelector("#retention-summary");
const retentionTitle = document.querySelector("#retention-title");
const retentionCopy = document.querySelector("#retention-copy");
const retentionBody = document.querySelector("#retention-body");
const removalStatus = document.querySelector("#removal-status");
const copyStatus = document.querySelector("#copy-status");
const COPIED_MS = 2_000;
// The text of the Copy button that just copied, while it says Copied.
let copiedText = null;
let copiedTimer = null;
const support = document.querySelector("#support");

// Moving between windows can raise focus several times, and a state read looks
// at this computer. Focus asks Morrow again at most this often. Check status
// and every step a person starts are never held back by it.
const FOCUS_REFRESH_INTERVAL_MS = 5_000;

// Morrow answers a state read with what it has already observed, so the runtime
// can still be starting when setup draws. While the runtime stays uncertain,
// setup asks again a few times and then waits for the person.
const SETTLING_REFRESH_MS = 750;
const SETTLING_REFRESH_MAX_MS = 5_000;
// A local runtime start includes every upstream connector, which can take well over a minute on a
// cold start. Setup keeps asking for that whole window instead of stopping after a few seconds.
const SETTLING_REFRESH_WINDOW_MS = 120_000;

let state = null;
let activeView = "home";
let chosenAssistantId = null;
let busy = false;
let latestProblem = null;
let shownProblem = null;
let loadAttempted = false;
let heldFocusKey = null;
let userActionFocusPending = false;
let blackboardDisclosureTouched = false;
let blackboardProblemsShown = false;
let lastRefreshAt = 0;
let settlingRefreshes = 0;
let settlingStartedAt = null;
let settlingTimer = null;

// Each managed-device note is only true on the platform it names, so Morrow
// shows the one matching this computer and neither when it cannot tell.
function renderPlatformNote() {
  const platform = API?.platform === "darwin" || API?.platform === "win32" ? API.platform : null;
  for (const note of platformNotes) note.hidden = note.dataset.platform !== platform;
}

function focusKey(element) {
  if (!(element instanceof HTMLElement)) return null;
  if (element.tagName === "SUMMARY") {
    const disclosure = element.closest("details");
    if (disclosure?.id) return `disclosure ${disclosure.id}`;
    for (const className of ["advanced-assistants", "optional-setup"]) {
      if (disclosure?.classList.contains(className)) return `disclosure ${className}`;
    }
  }
  if (element.dataset.courseId) return `course ${element.dataset.courseId}`;
  const action = element.dataset.action;
  if (action) return element.dataset.assistantId ? `${action} ${element.dataset.assistantId}` : action;
  return element.id ? `#${element.id}` : null;
}

// The controls Morrow replaces or disables while it works.
function controls() {
  return [
    refreshButton,
    blackboardSubmit,
    ...actionBody.querySelectorAll("[data-action]"),
    ...setupManagementBody.querySelectorAll("[data-action]"),
    ...updatesActions.querySelectorAll("[data-action]"),
    ...blackboardTenantRow.querySelectorAll("[data-action]"),
    ...blackboardCourseList.querySelectorAll("[data-action]"),
    ...retentionBody.querySelectorAll("[data-action]"),
    ...support.querySelectorAll("[data-action]")
  ];
}

function focusTargets() {
  return [
    ...controls(),
    actionTitle,
    setupManagementTitle,
    updatesTitle,
    blackboardSummary,
    retentionSummary,
    ...actionBody.querySelectorAll("summary")
  ];
}

function focusedKey() {
  const active = document.activeElement;
  return focusTargets().includes(active) ? focusKey(active) : null;
}

function restoreFocus(key) {
  if (!key) return false;
  const target = focusTargets().find((element) => focusKey(element) === key);
  if (!(target instanceof HTMLElement) || target.disabled === true) return false;
  target.focus();
  return document.activeElement === target;
}

function rememberUserActionFocus(target) {
  if (actionBody.contains(target)) userActionFocusPending = "action";
  else if (setupManagementBody.contains(target)) userActionFocusPending = "settings";
  else return;
  heldFocusKey = focusKey(target);
}

function focusActionTransition() {
  const primary = actionBody.querySelector(".primary-button");
  if (primary instanceof HTMLElement && primary.disabled !== true) {
    primary.focus();
    if (document.activeElement === primary) return true;
  }
  actionTitle.focus();
  return document.activeElement === actionTitle;
}

// The Settings-view counterpart of focusActionTransition: a control that
// disappeared after its own action (for example, Remove) hands focus to the
// setup-management heading instead of leaving it on nothing.
function focusSettingsTransition() {
  setupManagementTitle.focus();
  return document.activeElement === setupManagementTitle;
}

function applyBusy() {
  setupMain.setAttribute("aria-busy", String(busy));
  refreshButton.disabled = busy;
  navHome.disabled = busy;
  navSettings.disabled = busy;
  if (!busy) return;
  for (const control of controls()) control.disabled = true;
}

function renderProgress(current) {
  progressList.innerHTML = progress(current).map((step, index) => `
    <li class="progress-step" data-status="${step.status}"${step.current ? ' aria-current="step"' : ""}>
      <span class="step-state" aria-hidden="true">${step.status === "done" ? "✓" : step.status === "blocked" ? "!" : index + 1}</span>
      <span><span class="step-label">${escapeHtml(step.label)}</span><span class="step-detail">${escapeHtml(step.detail)}</span></span>
    </li>
  `).join("");
}

function renderWelcome(current) {
  const needsWelcome = !configuredAssistant(current)
    && !pendingAssistant(current)
    && current?.lifecycle !== "repair_required"
    && current?.runtime?.status !== "repair_required";
  setupIntro.hidden = !needsWelcome;
  // The intro's own h1 is hidden with it, so the step heading becomes the
  // page's level-one heading until the welcome screen returns.
  actionTitle.setAttribute("aria-level", needsWelcome ? "2" : "1");
}

function setProblem(value) {
  latestProblem = value || null;
  const next = problemView(latestProblem);
  if (next?.message === shownProblem?.message && next?.recovery === shownProblem?.recovery) return;
  shownProblem = next;
  if (!next) {
    problem.hidden = true;
    problem.innerHTML = "";
    return;
  }
  problem.hidden = false;
  problem.innerHTML = `<strong>${escapeHtml(next.message)}</strong><p>${escapeHtml(next.recovery)}</p>`;
  // The step body can be taller than the window, so a new problem is brought into view.
  problem.scrollIntoView?.({ block: "nearest" });
}

function renderUpdates(current) {
  const updates = current?.updates;
  if (updates?.schema === "morrow.desktop-update.v1" && updates.status === "unavailable") {
    updatesPanel.hidden = false;
    updatesCopy.textContent = "This copy of Morrow does not update itself. Get newer versions from meetmorrow.app/download.";
    renderUpdateActions("");
    return;
  }
  if (!updates || updates.schema !== "morrow.desktop-update.v1") {
    updatesPanel.hidden = true;
    updatesCopy.textContent = "";
    renderUpdateActions("");
    return;
  }
  updatesPanel.hidden = false;
  const version = typeof updates.availableVersion === "string" && updates.availableVersion ? ` version ${updates.availableVersion}` : " an update";
  const automatic = updates.automatic === true;
  if (updates.status === "idle") {
    updatesCopy.textContent = automatic ? "Morrow checks for updates automatically. You can also check now." : "Morrow is ready to check for an update.";
    renderUpdateActions('<button class="secondary-button" type="button" data-action="check-for-updates">Check for updates</button>');
    return;
  }
  if (updates.status === "checking") {
    updatesCopy.textContent = "Morrow is checking for an update.";
    renderUpdateActions("");
    return;
  }
  if (updates.status === "available" || updates.status === "downloading") {
    updatesCopy.textContent = updates.status === "available"
      ? `Morrow found${version} and will download it in the background.`
      : `Morrow is downloading${version} in the background. You can keep working while it finishes.`;
    renderUpdateActions("");
    return;
  }
  if (updates.status === "ready") {
    if (updates.reason === "active_or_uncertain_operations") {
      updatesCopy.textContent = "Morrow will restart after course work finishes or its current state is clear.";
      renderUpdateActions("");
      return;
    }
    if (updates.reason === "update_install_failed") {
      updatesCopy.textContent = "Morrow could not install the update. Try again when course work is idle.";
      renderUpdateActions('<button class="secondary-button" type="button" data-action="install-update">Try restart again</button>');
      return;
    }
    updatesCopy.textContent = `${updates.availableVersion ? `Version ${updates.availableVersion} is ready.` : "An update is ready."} Restart Morrow when course work is idle to finish the update.`;
    renderUpdateActions('<button class="primary-button" type="button" data-action="install-update">Restart to update</button>');
    return;
  }
  if (updates.status === "installing") {
    updatesCopy.textContent = "Morrow is installing its update. It will reopen when the update is complete.";
    renderUpdateActions("");
    return;
  }
  if (updates.reason === "update_rolled_back") {
    updatesCopy.textContent = updates.currentVersion
      ? `The update did not start; Morrow is running version ${updates.currentVersion}.`
      : "The update did not start; Morrow is running the version it started from.";
    renderUpdateActions('<button class="secondary-button" type="button" data-action="check-for-updates">Retry the update</button>');
    return;
  }
  if (updates.reason === "disk_space_unavailable") {
    updatesCopy.textContent = "Morrow could not download the update: this computer does not have enough free space for it.";
    renderUpdateActions('<button class="secondary-button" type="button" data-action="check-for-updates">Try again</button>');
    return;
  }
  updatesCopy.textContent = "Morrow could not check for an update.";
  renderUpdateActions('<button class="secondary-button" type="button" data-action="check-for-updates">Try again</button>');
}

function renderUpdateActions(html) {
  if (updatesActions.innerHTML !== html) updatesActions.innerHTML = html;
  for (const action of updatesActions.querySelectorAll("[data-action]")) action.disabled = busy;
}

const UPDATE_STATUSES = new Set(["unavailable", "idle", "checking", "available", "downloading", "ready", "installing", "error"]);
let latestUpdateRevision = -1;

function isUpdateSnapshot(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && value.schema === "morrow.desktop-update.v1"
    && Number.isSafeInteger(value.revision) && value.revision >= 0
    && UPDATE_STATUSES.has(value.status)
    && typeof value.currentVersion === "string" && value.currentVersion.length <= 160
    && (value.availableVersion === null || (typeof value.availableVersion === "string" && value.availableVersion.length <= 160))
    && typeof value.automatic === "boolean"
    && (value.reason === null || (typeof value.reason === "string" && value.reason.length <= 160)));
}

function receiveUpdateSnapshot(snapshot) {
  if (!state || !isUpdateSnapshot(snapshot) || snapshot.revision < latestUpdateRevision) return;
  latestUpdateRevision = snapshot.revision;
  const active = document.activeElement;
  const focus = [...updatesActions.querySelectorAll("[data-action]")].includes(active) ? focusKey(active) : null;
  state = { ...state, updates: snapshot };
  renderUpdates(state);
  applyBusy();
  if (focus && !restoreFocus(focus) && !updatesPanel.hidden) updatesTitle.focus();
}

function stateWithNewestUpdates(current) {
  if (!current || typeof current !== "object" || Array.isArray(current)) return current;
  if (isUpdateSnapshot(current.updates) && current.updates.revision >= latestUpdateRevision) {
    latestUpdateRevision = current.updates.revision;
    return current;
  }
  return latestUpdateRevision >= 0 && isUpdateSnapshot(state?.updates)
    ? { ...current, updates: state.updates }
    : current;
}

function blackboardHealth(current) {
  const blackboard = current?.blackboard;
  return blackboard?.schema === "morrow.blackboard.health.v1" ? blackboard : null;
}

// Setup writes one Blackboard connection, so the courses belong to that one.
function blackboardTenant(current) {
  const blackboard = blackboardHealth(current);
  return blackboard?.tenants[0] || null;
}

function blackboardNeedsRepair(current) {
  const status = blackboardHealth(current)?.status;
  return Boolean(status && status !== "not_configured" && status !== "api_configured_live_untested");
}

// A saved connection is the only place a person can see the site and account
// Morrow stored, and saving a different pair releases the courses derived from
// the old one. Morrow puts back the two stored values it is free to show, and
// leaves a field a person is working in alone. The secret is never shown again.
function fillStoredBlackboardIdentity(tenant) {
  if (tenant && blackboardBaseUrl.value === "" && document.activeElement !== blackboardBaseUrl) blackboardBaseUrl.value = tenant.baseUrl;
}

// Morrow holds one Blackboard connection on this computer, so saving a
// different site replaces the saved one. A person reads that consequence with
// the saved site named in it, before the save, and only while the address in
// the form is a different site than the one already saved.
function renderBlackboardReplacement(tenant) {
  const site = blackboardSiteFrom(blackboardBaseUrl.value);
  const replacing = Boolean(tenant) && site.startsWith("https://") && site !== tenant.baseUrl;
  blackboardReplaceNote.hidden = !replacing;
  blackboardReplaceNote.textContent = replacing
    ? `Saving this replaces the Blackboard connection Morrow saved for ${tenant.baseUrl}: its courses and the secret saved for it are removed from this computer.`
    : "";
}

// The saved connection, in the three values the health snapshot carries: the
// site, the account, and the name Morrow saved it under. Remove is offered here
// because a connection saved for the wrong site or account is otherwise
// permanent, and what removal takes away is written beside the button.
function renderBlackboardTenant(tenant, needsRepair) {
  blackboardTenantRow.hidden = !tenant && !needsRepair;
  blackboardTenantRow.innerHTML = tenant ? `
    <div class="materials-row">
      <div>
        <h3>${escapeHtml(tenant.baseUrl)}</h3>
        <p>Blackboard verified account ${escapeHtml(tenant.principalId)} when Morrow saved this connection as ${escapeHtml(tenant.id)}.</p>
        <p>${needsRepair ? "Remove saved data takes this damaged connection and its secret off this computer." : "Remove takes this connection and the secret saved for it off this computer."} It changes nothing in Blackboard.</p>
      </div>
      <button class="secondary-button" type="button" data-action="${needsRepair ? "remove-blackboard-data" : "remove-blackboard-tenant"}" data-tenant-id="${escapeHtml(tenant.id)}" aria-label="Remove the Blackboard connection for ${escapeHtml(tenant.baseUrl)}">${needsRepair ? "Remove saved data" : "Remove connection"}</button>
    </div>
  ` : needsRepair ? `
    <div class="materials-row">
      <div>
        <h3>Saved Blackboard data needs repair</h3>
        <p>Morrow cannot safely read the saved connection. Remove saved data before you connect it again. This changes nothing in Blackboard.</p>
      </div>
      <button class="secondary-button" type="button" data-action="remove-blackboard-data">Remove saved data</button>
    </div>
  ` : "";
}

// Blackboard verifies the service account and its accessible courses before it
// stores a connection. It does not perform a course read or change during setup.
function renderBlackboard(current) {
  // Blackboard is optional and its form asks for credentials an administrator
  // issues, so setup offers it only once an assistant is configured.
  blackboardPanel.hidden = !blackboardSetupOffered(current);
  if (blackboardPanel.hidden) return;
  const health = blackboardHealth(current);
  const tenant = blackboardTenant(current);
  const needsRepair = blackboardNeedsRepair(current);
  const removalOnly = health?.status === "configuration_repair_required" || health?.status === "private_access_refused";
  if (health?.status === "credential_missing") {
    blackboardCopy.textContent = "Morrow found the saved Blackboard connection, but its secret is missing. Paste the application key and secret to repair it, or remove the saved data.";
  } else if (health?.status === "credential_mismatched") {
    blackboardCopy.textContent = "Morrow found the saved Blackboard connection, but its secret no longer matches it. Paste the application key and secret to repair it, or remove the saved data.";
  } else if (health?.status === "private_access_refused") {
    blackboardCopy.textContent = "Morrow found saved Blackboard data that it cannot safely open. Repair the file access and check status again, or remove the saved data.";
  } else if (health?.status === "configuration_repair_required") {
    blackboardCopy.textContent = "Morrow found saved Blackboard data that it cannot safely read. Remove the saved data before you connect Blackboard again.";
  } else {
    blackboardCopy.textContent = tenant
      ? "Blackboard verified this account and its accessible courses when Morrow saved the connection. Morrow has not tested a course action."
      : "Morrow verifies the Blackboard account and its accessible courses before it saves this connection on this computer.";
  }
  blackboardAdminNote.hidden = removalOnly || (Boolean(tenant) && !needsRepair);
  blackboardSavedNote.hidden = !tenant || needsRepair;
  renderBlackboardTenant(tenant, needsRepair);
  fillStoredBlackboardIdentity(tenant);
  renderBlackboardReplacement(tenant);
  blackboardForm.hidden = removalOnly;
  blackboardSubmit.textContent = needsRepair ? "Repair Blackboard connection" : "Save Blackboard connection";
  blackboardCourses.hidden = !tenant || needsRepair;
  const selected = new Set(tenant?.courseBindings.map((binding) => binding.courseId) || []);
  const courses = tenant?.availableCourses || [];
  blackboardCoursesCopy.textContent = !tenant ? ""
    : courses.length === 0
      ? `Blackboard verified this account, but it returned no accessible courses on ${tenant.baseUrl}.`
      : `Select the Blackboard courses Morrow can work in on ${tenant.baseUrl}. Blackboard verified this list when you saved the connection.`;
  blackboardCourseList.innerHTML = courses.map((course) => {
    const connected = selected.has(course.courseId);
    const actionLabel = connected
      ? `Remove ${course.title} (${course.courseId}) from Morrow`
      : `Allow Morrow to use ${course.title} (${course.courseId})`;
    return `
      <li class="materials-row">
        <span><strong>${escapeHtml(course.title)}</strong><span class="course-id">${escapeHtml(course.courseId)}</span></span>
        <button class="secondary-button" type="button" data-action="${connected ? "remove-blackboard-course" : "select-blackboard-course"}" data-course-id="${escapeHtml(course.courseId)}" aria-label="${escapeHtml(actionLabel)}">${connected ? "Remove" : "Allow Morrow"}</button>
      </li>
    `;
  }).join("");
  blackboardSubmit.disabled = busy;
  // A saved connection is what a person opens this panel to see, so Morrow
  // opens the disclosure once. After that the disclosure stays where the
  // person left it.
  if ((tenant || needsRepair) && !blackboardDisclosureTouched) blackboardPanel.open = true;
}

// The exact places this installation keeps data, and the one action that
// removes them. Morrow shows this section only when it has a state that names
// those places.
function renderRetention(current) {
  const view = retentionView(current);
  retentionPanel.hidden = !view;
  if (!view) {
    retentionBody.innerHTML = "";
    return;
  }
  retentionTitle.textContent = view.title;
  retentionCopy.textContent = view.copy;
  retentionBody.innerHTML = view.body;
}

// The version, folders and support address, shown from the first drawn state
// on, so a person who cannot finish setup still has what support asks for.
function renderSupport(current, drawn) {
  support.hidden = !drawn;
  if (!drawn) return;
  const view = supportView(current);
  support.innerHTML = `<h2>${escapeHtml(view.title)}</h2><p>${escapeHtml(view.copy)}</p>${view.body}`;
}

// A data removal changes the panel while focus stays on the button that ran it,
// so its result is also announced. The text is written only when it changes, so
// returning to the window does not read the same result again.
function announceRemoval(current) {
  const announcement = removalAnnouncement(current);
  if (removalStatus.textContent !== announcement) removalStatus.textContent = announcement;
}

// The setup a person can change, now on the Settings view (D8, D9). Hidden
// entirely in the one state it never applies to: repair, and before any
// assistant is configured or waiting for approval.
function renderSetupManagement(current) {
  const view = setupManagementView(current);
  setupManagementPanel.hidden = !view;
  if (!view) {
    setupManagementBody.innerHTML = "";
    return;
  }
  setupManagementTitle.textContent = view.title;
  setupManagementBody.innerHTML = view.body;
}

// Home carries the setup wizard and, once it is done, status and example
// requests (D8). Settings carries the setup a person can change, Updates, the
// Blackboard connection, what stays on this computer, and Support. Switching
// is local to the renderer: it changes nothing Morrow has read or saved.
//
// The hidden view keeps the `hidden` attribute, which styles.css enforces
// with `display: none !important` (so it always wins over any inline style).
// The visible view additionally gets inline `display: contents`: `.setup`
// lays its children out as a CSS grid, so a plain wrapper div around each
// view would take its own grid cell instead of letting its children keep
// their own placement. `display: contents` removes the wrapper from that box
// tree so its children sit in the grid exactly as before.
function applyActiveView() {
  const onSettings = activeView === "settings";
  homeView.hidden = onSettings;
  homeView.style.display = onSettings ? "" : "contents";
  settingsView.hidden = !onSettings;
  settingsView.style.display = onSettings ? "contents" : "";
  navHome.setAttribute("aria-current", onSettings ? "false" : "page");
  navSettings.setAttribute("aria-current", onSettings ? "page" : "false");
}

function setActiveView(next) {
  if (activeView === next) return;
  activeView = next;
  applyActiveView();
}

// How long the Chrome folder step may show before setup points at the exact
// folder, since loading a folder inside it or a copy of it is the usual mistake.
const BRIDGE_FOLDER_HINT_MS = 90_000;
let bridgeStepShownAt = null;
let bridgeHintTimer = null;

function bridgeWaitExpired(current) {
  if (!awaitingBridgeFolder(current)) {
    bridgeStepShownAt = null;
    return false;
  }
  bridgeStepShownAt ??= Date.now();
  const remaining = bridgeStepShownAt + BRIDGE_FOLDER_HINT_MS - Date.now();
  if (remaining > 0 && bridgeHintTimer === null) {
    bridgeHintTimer = setTimeout(() => { bridgeHintTimer = null; render(state); }, remaining);
    bridgeHintTimer?.unref?.();
  }
  return remaining <= 0;
}

function render(current) {
  current = stateWithNewestUpdates(current);
  state = current;
  if (!chosenAssistantId && current?.selectedAssistantId) chosenAssistantId = current.selectedAssistantId;
  const view = current ? actionView(current, { chosenAssistantId, platform: API?.platform || null, bridgeWaitExpired: bridgeWaitExpired(current) }) : loadAttempted ? setupUnavailableView() : null;
  headerStatus.textContent = current || !view ? statusSummary(current) : view.summary;
  loading.hidden = Boolean(view);
  actionContent.hidden = !view;
  renderWelcome(current);
  renderProgress(current);
  const restoreKey = focusedKey() || heldFocusKey;
  if (view) {
    const advancedOpen = actionBody.querySelector(".advanced-assistants")?.open === true;
    actionTitle.textContent = view.title;
    actionCopy.textContent = view.copy;
    actionBody.innerHTML = view.body;
    const advanced = actionBody.querySelector(".advanced-assistants");
    if (advanced && advancedOpen) advanced.open = true;
  }
  if (current) {
    renderSetupManagement(current);
    renderUpdates(current);
    renderBlackboard(current);
    renderRetention(current);
  }
  renderSupport(current, Boolean(view));
  announceRemoval(current);
  if (copiedText !== null) markCopied();
  setProblem(latestProblem);
  applyActiveView();
  applyBusy();
  let restored = restoreFocus(restoreKey);
  if (!busy && userActionFocusPending) {
    if (!restored) restored = userActionFocusPending === "settings" ? focusSettingsTransition() : focusActionTransition();
    userActionFocusPending = false;
  }
  heldFocusKey = busy && !restored ? restoreKey : null;
}

/** Says Copied on the Copy button that copied, and once to a screen reader, for about 2 seconds. */
function showCopied(text) {
  if (copiedTimer !== null) clearTimeout(copiedTimer);
  copiedText = text;
  copyStatus.textContent = "Copied to the clipboard.";
  copiedTimer = setTimeout(() => {
    copiedTimer = null;
    copiedText = null;
    copyStatus.textContent = "";
    markCopied();
  }, COPIED_MS);
}

function markCopied() {
  for (const button of actionBody.querySelectorAll("[data-action]")) {
    if (button.dataset.action !== "copy-example-prompt") continue;
    if (button.dataset.prompt === copiedText) {
      button.dataset.copyLabel ??= button.textContent;
      button.textContent = "Copied";
    } else if (button.dataset.copyLabel !== undefined) {
      button.textContent = button.dataset.copyLabel;
      delete button.dataset.copyLabel;
    }
  }
}

async function invoke(method, payload) {
  if (!API?.invoke) {
    setProblem({ message: "Morrow setup is unavailable.", recovery: "Restart Morrow, then check status again." });
    return null;
  }
  busy = true;
  render(state);
  try {
    const result = await API.invoke(method, payload);
    if (!result || result.schema !== "morrow.installer-result.v1" || !result.state) {
      setProblem({ message: "Morrow returned an incomplete setup state.", recovery: "Check status again." });
      return null;
    }
    latestProblem = result.ok === true || result.error?.code === "cancelled" ? null : result.error || { message: "Morrow could not complete that step.", recovery: "Check status and try again." };
    scheduleSettlingRefresh(result.state);
    return result.state;
  } catch {
    setProblem({ message: "Morrow could not check setup.", recovery: "Check status again." });
    return null;
  } finally {
    busy = false;
  }
}

/**
 * Reads the setup state and draws it. `recheckAssistants` belongs to Check
 * status, which asks Morrow to look at this computer again instead of reusing
 * what it already read.
 */
async function refresh({ recheckAssistants = false } = {}) {
  lastRefreshAt = Date.now();
  const next = await invoke("installer:get-state", recheckAssistants ? { recheckAssistants: true } : undefined);
  loadAttempted = true;
  if (next) render(next);
  else render(state);
}

/**
 * Every control that means "check now". It is never held back by the focus
 * limit, and it asks Morrow to read this computer again.
 */
function checkNow() {
  settlingRefreshes = 0;
  settlingStartedAt = null;
  return refresh({ recheckAssistants: true });
}

/**
 * Asks again shortly while the runtime is still uncertain, so a runtime that
 * becomes ready a moment after setup drew shows up without the person doing
 * anything. The number of attempts is limited; Check status starts it over.
 */
function scheduleSettlingRefresh(next) {
  if (settlingTimer !== null) {
    clearTimeout(settlingTimer);
    settlingTimer = null;
  }
  if (!next) return;
  if (next.runtime?.status !== "uncertain") {
    settlingRefreshes = 0;
    settlingStartedAt = null;
    return;
  }
  settlingStartedAt ??= Date.now();
  const delay = Math.min(SETTLING_REFRESH_MS * (2 ** settlingRefreshes), SETTLING_REFRESH_MAX_MS);
  if (Date.now() + delay - settlingStartedAt > SETTLING_REFRESH_WINDOW_MS) return;
  settlingRefreshes += 1;
  settlingTimer = setTimeout(() => {
    settlingTimer = null;
    if (!busy) void refresh();
  }, delay);
  settlingTimer?.unref?.();
}

async function handleAction(event) {
  const target = event.target instanceof Element ? event.target.closest("[data-action]") : null;
  if (!(target instanceof HTMLElement) || busy) return;
  const action = target.dataset.action;
  rememberUserActionFocus(target);
  if (action === "choose-assistant") {
    chosenAssistantId = target.dataset.assistantId || null;
    latestProblem = null;
    render(state);
    return;
  }
  if (action === "open-settings") {
    setActiveView("settings");
    return;
  }
  if (action === "choose-workspace") {
    const next = await invoke("installer:choose-workspace");
    if (next) render(next);
    else render(state);
    return;
  }
  if (action === "install-assistant") {
    // A row names the assistant it belongs to. The setup button on the first
    // screen names none, and uses the card the person chose there.
    const assistantId = target.dataset.assistantId || chosenAssistantId || assistantFor(state)?.id;
    if (!assistantId) return;
    const next = await invoke("installer:install-assistant", { assistantId });
    if (next) render(next);
    else render(state);
    return;
  }
  if (action === "remove-assistant") {
    const assistantId = target.dataset.assistantId;
    if (!assistantId) return;
    const next = await invoke("installer:remove-assistant", { assistantId });
    if (next) render(next);
    else render(state);
    return;
  }
  if (action === "check-assistant-connection" || action === "move-to-applications") {
    const next = await invoke(action === "move-to-applications" ? "installer:move-to-applications" : "installer:check-assistant-connection");
    if (next) render(next);
    else render(state);
    return;
  }
  if (action === "reveal-bridge-folder") {
    const next = await invoke("installer:reveal-bridge-folder");
    if (next) render(next);
    else render(state);
    return;
  }
  if (action === "copy-example-prompt") {
    const text = target.dataset.prompt;
    if (!text) return;
    const next = await invoke("installer:copy-to-clipboard", { text });
    if (next && latestProblem === null) showCopied(text);
    if (next) render(next);
    else render(state);
    return;
  }
  if (action === "open-support") {
    const next = await invoke("installer:open-support");
    if (next) render(next);
    else render(state);
    return;
  }
  if (action === "check-bridge") {
    const next = await invoke("installer:reconcile-bridge");
    if (next) render(next);
    else render(state);
    return;
  }
  if (action === "check-for-updates") {
    const next = await invoke("installer:check-for-updates");
    if (next) render(next);
    else render(state);
    return;
  }
  if (action === "install-update") {
    const next = await invoke("installer:install-update");
    if (next) render(next);
    else render(state);
    return;
  }
  if (action === "run-first-read") {
    const next = await invoke("installer:run-first-read");
    if (next) render(next);
    else render(state);
    return;
  }
  if (action === "open-claude-desktop") {
    const next = await invoke("installer:open-claude-desktop");
    if (next) render(next);
    else render(state);
    return;
  }
  if (action === "reveal-claude-extension") {
    const next = await invoke("installer:reveal-claude-extension");
    if (next) render(next);
    else render(state);
    return;
  }
  if (action === "repair") {
    const next = await invoke("installer:repair");
    if (next) render(next);
    else render(state);
    return;
  }
  if (action === "restore-bridge") {
    const next = await invoke("installer:restore-bridge");
    if (next) render(next);
    else render(state);
    return;
  }
  if (action === "remove-data") {
    const next = await invoke("installer:remove-data");
    if (next) render(next);
    else render(state);
    return;
  }
  if (action === "remove-blackboard-tenant") {
    const tenantId = target.dataset.tenantId;
    if (!tenantId) return;
    const next = await invoke("installer:remove-blackboard-tenant", { tenantId });
    if (next) render(next);
    else render(state);
    // The site and account in the form were the ones Morrow saved. Once that
    // connection is gone they are not saved values any more, so the form no
    // longer offers them as if they were.
    if (!blackboardTenant(state)) {
      blackboardForm.reset();
      blackboardProblemsShown = false;
      clearFieldProblems(blackboardConnectionFields);
      renderBlackboardReplacement(null);
    }
    return;
  }
  if (action === "remove-blackboard-data") {
    const next = await invoke("installer:remove-blackboard-data");
    if (next) render(next);
    else render(state);
    if (!blackboardTenant(state)) {
      blackboardForm.reset();
      blackboardProblemsShown = false;
      clearFieldProblems(blackboardConnectionFields);
      renderBlackboardReplacement(null);
    }
    return;
  }
  if (action === "select-blackboard-course") {
    const tenant = blackboardTenant(state);
    const courseId = target.dataset.courseId;
    if (!tenant || !courseId) return;
    const selected = tenant.courseBindings.map((binding) => binding.courseId);
    await selectBlackboardCourses(tenant, selected.includes(courseId) ? selected : [...selected, courseId]);
    return;
  }
  if (action === "remove-blackboard-course") {
    const tenant = blackboardTenant(state);
    if (!tenant) return;
    await selectBlackboardCourses(tenant, tenant.courseBindings.map((binding) => binding.courseId).filter((courseId) => courseId !== target.dataset.courseId));
    return;
  }
  if (action === "check-claude-desktop" || action === "check-setup-state") {
    await checkNow();
  }
}

// A person pastes the address they open Blackboard with; Morrow stores the site
// that address belongs to, which is what every Blackboard request is bound to.
function blackboardSiteFrom(value) {
  const text = typeof value === "string" ? value.trim() : "";
  try { return new URL(text).origin; } catch { return text; }
}

/**
 * The message each Blackboard field shows under itself. Every rule here is one
 * installer/shared/blackboard.cjs enforces when it saves, written out so a
 * person reads the rule instead of the browser's generic format message. A
 * message stays under its field until that field satisfies the rule.
 */
const blackboardConnectionFields = [
  {
    input: blackboardBaseUrl,
    message: blackboardBaseUrlError,
    problem(value) {
      const site = blackboardSiteFrom(value);
      if (site === "") return "Enter the web address you use to open Blackboard.";
      return site.startsWith("https://") ? "" : "Enter an address that starts with https://, such as https://learn.example.edu.";
    }
  },
  {
    input: blackboardApplicationKey,
    message: blackboardApplicationKeyError,
    problem: (value) => (value.trim() === "" ? "Paste the application key your Blackboard administrator gave you." : "")
  },
  {
    input: blackboardSecret,
    message: blackboardSecretError,
    problem: (value) => (value === "" ? "Paste the application secret your Blackboard administrator gave you." : "")
  }
];

// Returns the first field a person has to correct, or null when every field is
// ready to save.
function showFieldProblems(fields) {
  let first = null;
  for (const field of fields) {
    const problem = field.problem(field.input.value);
    field.message.textContent = problem;
    field.input.setAttribute("aria-invalid", problem === "" ? "false" : "true");
    if (problem !== "" && !first) first = field.input;
  }
  return first;
}

function clearFieldProblems(fields) {
  for (const field of fields) {
    field.message.textContent = "";
    field.input.setAttribute("aria-invalid", "false");
  }
}

async function selectBlackboardCourses(tenant, courseIds) {
  const next = await invoke("installer:select-blackboard-courses", { tenantId: tenant.id, courseBindings: courseIds.map((courseId) => ({ courseId })) });
  if (next) render(next);
  else render(state);
  return Boolean(next) && latestProblem === null;
}

async function submitBlackboard(event) {
  event.preventDefault();
  if (busy) return;
  blackboardProblemsShown = true;
  const incomplete = showFieldProblems(blackboardConnectionFields);
  if (incomplete) { incomplete.focus(); return; }
  const fields = new FormData(blackboardForm);
  let applicationSecret = fields.get("applicationSecret");
  fields.delete("applicationSecret");
  let request = null;
  let saved = false;
  try {
    request = {
      baseUrl: blackboardSiteFrom(fields.get("baseUrl")),
      applicationKey: fields.get("applicationKey"),
      applicationSecret,
    };
    const pending = invoke("installer:configure-blackboard", request);
    request.applicationSecret = "";
    applicationSecret = "";
    const next = await pending;
    saved = Boolean(next) && latestProblem === null;
    if (next) render(next);
    else render(state);
  } finally {
    applicationSecret = "";
    if (request) request.applicationSecret = "";
    fields.delete("applicationSecret");
    if (saved) {
      blackboardProblemsShown = false;
      clearFieldProblems(blackboardConnectionFields);
      blackboardForm.reset();
      fillStoredBlackboardIdentity(blackboardTenant(state));
    } else {
      // Every field passed its rule before saving, and Morrow empties the
      // secret itself, so no field has a message: the problem states why.
      blackboardSecret.value = "";
      blackboardProblemsShown = false;
      clearFieldProblems(blackboardConnectionFields);
    }
    renderBlackboardReplacement(blackboardTenant(state));
  }
}

refreshButton.addEventListener("click", () => { void checkNow(); });
navHome.addEventListener("click", () => setActiveView("home"));
navSettings.addEventListener("click", () => setActiveView("settings"));
actionBody.addEventListener("click", (event) => { void handleAction(event); });
setupManagementBody.addEventListener("click", (event) => { void handleAction(event); });
updatesActions.addEventListener("click", (event) => { void handleAction(event); });
blackboardPanel.addEventListener("click", (event) => { void handleAction(event); });
retentionBody.addEventListener("click", (event) => { void handleAction(event); });
support.addEventListener("click", (event) => { void handleAction(event); });
blackboardPanel.addEventListener("toggle", () => { blackboardDisclosureTouched = true; });
blackboardForm.addEventListener("submit", (event) => { void submitBlackboard(event); });
// A message a person is already correcting clears as soon as the value is right.
blackboardForm.addEventListener("input", () => {
  if (blackboardProblemsShown) showFieldProblems(blackboardConnectionFields);
  renderBlackboardReplacement(blackboardTenant(state));
});
window.addEventListener("focus", () => {
  if (busy || Date.now() - lastRefreshAt < FOCUS_REFRESH_INTERVAL_MS) return;
  void refresh();
});
renderPlatformNote();
if (typeof API?.subscribeUpdates === "function") API.subscribeUpdates(receiveUpdateSnapshot);
void (async () => {
  await refresh();
  if (typeof API?.rendererReady === "function") await API.rendererReady();
})();
