/**
 * The setup views Morrow renders. Every function here takes the installer state
 * as an argument and returns plain data, so the renderer and `node --test` read
 * exactly the same views.
 */

export const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", "\"": "&quot;",
}[character]));

export function assistantFor(current) {
  const assistants = Array.isArray(current?.assistants) ? current.assistants : [];
  return assistants.find((assistant) => assistant?.selected === true)
    || assistants.find((assistant) => assistant?.id === current?.selectedAssistantId)
    || null;
}

export function configuredAssistants(current) {
  const assistants = Array.isArray(current?.assistants) ? current.assistants : [];
  return assistants.filter((assistant) => assistant?.configured === true);
}

/**
 * The configured assistant the setup views speak about. Morrow can be set up in
 * more than one assistant, so the most recent choice is used when it is one of
 * them and any other configured assistant otherwise: adding a second assistant
 * never takes the steps of the first one away.
 */
export function configuredAssistant(current) {
  const assistant = assistantFor(current);
  return assistant?.configured === true ? assistant : configuredAssistants(current)[0] || null;
}

export function pendingAssistant(current) {
  const assistant = assistantFor(current);
  return assistant?.pending === true ? assistant : null;
}

/**
 * Whether setup offers the optional Blackboard connection. Its form asks for
 * credentials a Blackboard administrator issues, so setup offers it only once
 * an assistant is configured: the first screen never asks for credentials.
 * Saving, listing and removing a connection each read Morrow's own private
 * file access from the local runtime, so setup offers none of them until that
 * runtime is ready.
 */
export function blackboardSetupOffered(current) {
  return configuredAssistant(current) !== null && current?.runtime?.status === "ready";
}

function verifiedCourse(current) {
  const count = Number.isSafeInteger(current?.bridge?.runtimeVerifiedCourseCount)
    ? current.bridge.runtimeVerifiedCourseCount
    : 0;
  return count > 0;
}

function previewReady(current) {
  return current?.firstPreview?.available === true;
}

function previewCompleted(current) {
  return current?.firstPreview?.completed === true;
}

function deliveryBlocked(current) {
  return current?.lifecycle === "bridge_delivery_unavailable" || current?.bridge?.delivery === "unavailable";
}

/**
 * Whether the Chrome Bridge step is still the step Morrow is asking for. A
 * confirmed load and a paired Bridge are each proof the step is done. An
 * unconfirmed load ("unknown") is not proof, so Morrow keeps showing how to
 * add it.
 */
function needsBridge(current) {
  const bridge = current?.bridge || {};
  if (bridge.loadedInChrome === true || bridge.paired === true) return false;
  return bridge.delivery === "available" || bridge.delivery === "developer_temporary";
}

/**
 * Whether the Update panel is offered. Updating a Bridge in Chrome needs a
 * connected Bridge to pause and reload it. With none connected, Check Bridge
 * on the Chrome steps replaces the folder itself, so the update waits.
 */
function bridgeUpdateOffered(current) {
  const bridge = current?.bridge || {};
  return bridge.updateAvailable === true && (bridge.loadedInChrome === true || bridge.paired === true);
}

// The header's live region announces the summary of the panel on screen. The
// panel decision carries it, so the two cannot name different steps.
export function statusSummary(current) {
  return current ? actionPanel(current).summary : "Checking setup";
}

const STEP_LABELS = Object.freeze(["Assistant", "Morrow Bridge", "Course"]);

export function progress(current) {
  if (!current) return STEP_LABELS.map((label) => ({ label, detail: "Not checked yet", status: "pending", current: false }));
  const repairRequired = current.lifecycle === "repair_required" || current.runtime?.status === "repair_required";
  const assistant = configuredAssistant(current);
  const pending = pendingAssistant(current);
  const bridge = current?.bridge || {};
  const courseReady = verifiedCourse(current);
  const blocked = deliveryBlocked(current);
  const reloadRequired = bridge.manualChromeReloadRequired === true;
  const updateAvailable = bridgeUpdateOffered(current);
  const loaded = bridge.loadedInChrome === true || bridge.paired === true;
  const paired = bridge.paired === true;
  const firstPreviewReady = previewReady(current);
  const firstPreviewCompleted = previewCompleted(current);
  // After the first read, the panel asks for a quit and reopen until the assistant connects, so the
  // rail points back at the Assistant step for that time.
  const restart = firstPreviewCompleted && !repairRequired ? restartAssistant(current) : null;
  // A configured assistant cannot use Morrow while its materials folder is gone.
  const materialsMissing = !repairRequired && assistant !== null && !current.materialsFolder && Boolean(current.materialsFolderMissing);
  const active = repairRequired ? -1 : !assistant || materialsMissing ? 0 : reloadRequired || updateAvailable || !paired ? 1 : restart ? 0 : firstPreviewCompleted ? -1 : 2;
  const bridgeDetail = blocked
    ? "Not available yet"
    : reloadRequired
      ? "Reload in Chrome, then check"
      : updateAvailable
        ? "Update available"
      : paired
        ? "Connected to Morrow"
        : loaded
          ? "Installed; connect to Morrow"
          : bridge.delivery === "developer_temporary"
            ? "Add in Chrome"
            : "Install from Chrome";
  const course = bridge.selectedCourseName
    || (bridge.runtimeVerifiedCourseCount > 1 ? `${bridge.runtimeVerifiedCourseCount} courses` : "Selected course");
  const courseDetail = firstPreviewCompleted
    ? `${course}; first read complete`
    : firstPreviewReady
      ? `${course}; first read ready`
      : courseReady
        ? "Open your course in Chrome"
        : "Open Canvas or Moodle in Chrome";
  return [
    { label: "Assistant", detail: repairRequired ? "Waiting for repair" : materialsMissing ? "Materials folder not found" : restart && active === 0 ? `Quit and reopen ${restart.title}` : assistant ? configuredAssistants(current).map((entry) => entry.title).join(", ") : pending ? pending.checking === true ? "Checking the Claude Desktop connection" : "Finish approval in Claude Desktop" : "Choose an installed assistant", status: repairRequired ? "pending" : materialsMissing || (restart && active === 0) ? "current" : assistant ? "done" : "current" },
    { label: "Morrow Bridge", detail: bridgeDetail, status: blocked ? "blocked" : active === 1 ? "current" : paired ? "done" : "pending" },
    { label: "Course", detail: courseDetail, status: firstPreviewCompleted ? "done" : active === 2 ? "current" : "pending" },
  ].map((step, index) => ({ ...step, current: index === active && step.status !== "done" }));
}

/** What an assistant card says when this computer does not have that assistant. */
function notFoundDetail(assistant) {
  if (assistant?.id === "claude-desktop") return "Claude Desktop is not installed on this computer. Get it from claude.ai/download, then select Check status.";
  return "Not found on this computer.";
}

function assistantCards(current, chosenAssistantId) {
  const assistants = Array.isArray(current?.assistants) ? current.assistants : [];
  if (!assistants.length) return '<div class="blocked-box"><strong>No supported assistant was found</strong><p>Install a supported assistant, then check status again.</p></div>';
  const card = (assistant) => {
    const selected = assistant.id === chosenAssistantId || (chosenAssistantId === null && assistant.selected === true);
    const available = assistant.detected === true && assistant.supported !== false;
    const configured = assistant.configured === true;
    const pending = assistant.pending === true;
    const detail = configured ? "Morrow is set up here." : pending ? assistant.checking === true ? "Morrow is checking the connection to Claude Desktop." : "Finish approval in Claude Desktop." : available ? assistant.id === "claude-desktop" ? "Ready to set up. You approve it in Claude Desktop." : "Ready to set up." : assistant.detected === true ? "Not available in this Morrow version." : notFoundDetail(assistant);
    return `<button class="assistant-card" type="button" data-action="choose-assistant" data-assistant-id="${escapeHtml(assistant.id)}" aria-pressed="${selected}"${available ? "" : " disabled"}>
      <span class="assistant-title">${escapeHtml(assistant.title)}</span>
      ${configured ? '<span class="assistant-badge">Ready</span>' : ""}
      <span class="assistant-detail">${escapeHtml(detail)}</span>
    </button>`;
  };
  const primary = assistants.filter((assistant) => assistant?.tier !== "advanced");
  const advanced = assistants.filter((assistant) => assistant?.tier === "advanced" && assistant.detected === true);
  return `<div class="assistant-groups"><div class="assistant-list" role="group" aria-label="Choose an assistant">${primary.map(card).join("")}</div>${advanced.length ? `<details class="advanced-assistants"><summary>Assistants that ask for a project folder</summary><p>Set one of these up only if you already work in an assistant project. Morrow asks you to choose that project during setup.</p><div class="assistant-list" role="group" aria-label="Choose an advanced assistant">${advanced.map(card).join("")}</div></details>` : ""}</div>`;
}

/** The assistants named in one sentence, in the order setup lists them. */
function assistantTitles(assistants) {
  const titles = assistants.map((assistant) => escapeHtml(assistant.title));
  return titles.length <= 1 ? titles.join("") : `${titles.slice(0, -1).join(", ")} and ${titles.at(-1)}`;
}

/**
 * What choosing another materials folder writes, said before the change:
 * Morrow writes the folder into every assistant it configured.
 */
function rebindSentence(configured, lead) {
  if (configured.length === 0) return "";
  const claude = configured.some((assistant) => assistant.id === "claude-desktop") ? " Claude Desktop then asks you to approve Morrow again." : "";
  return ` ${lead} ${assistantTitles(configured)}.${claude}`;
}

/**
 * The materials folder row. It names the exact folder Morrow uses and offers
 * the change in every state, so the folder is never a choice a person makes
 * once and cannot revisit. What changing it does to each assistant is written
 * here, before the change, because Morrow writes the new folder into every
 * assistant it configured.
 */
function materialsRow(current, { optionalDisclosure = false } = {}) {
  const folder = typeof current?.materialsFolder === "string" && current.materialsFolder.length > 0 ? current.materialsFolder : null;
  const configured = configuredAssistants(current);
  const settled = configuredAssistant(current) !== null;
  const missing = folder ? null : current?.materialsFolderMissing || null;
  if (missing) {
    const detail = missing.isDefault
      ? "Morrow cannot find this folder. Make the folder again gives Morrow a new, empty one in the same place."
      : "Morrow cannot find this folder. If it is on a drive that is not connected, connect the drive, then select Check status.";
    const restore = missing.isDefault ? '<button class="secondary-button" type="button" data-action="restore-materials-folder">Make the folder again</button>' : "";
    return `<div class="materials-row materials-row-stacked"><div><h3>Materials folder</h3><p class="path-text">${escapeHtml(missing.path)}</p><p>${detail}${rebindSentence(configured, "Choosing a folder writes it into")}</p></div><div class="inline-actions">${restore}<button class="secondary-button" type="button" data-action="choose-workspace">Choose folder</button></div></div>`;
  }
  if (!folder) {
    const row = `<div class="materials-row"><div><h3>Materials folder</h3><p>Choose a different folder only if you want Morrow materials somewhere else. Otherwise, Morrow creates and uses its own Materials folder.</p></div><button class="secondary-button" type="button" data-action="choose-workspace">Choose folder</button></div>`;
    return optionalDisclosure ? `<details class="optional-setup"><summary>Optional: Choose another materials folder</summary>${row}</details>` : row;
  }
  const rebind = rebindSentence(configured, "Changing it writes the new folder into");
  const detail = current?.workspaceSelected === true
    ? `Morrow works with the course materials in this folder.${rebind}`
    : `Morrow made this folder for course materials. Choose a different folder to work somewhere else.${rebind}`;
  // The default folder sits inside a folder macOS and Windows hide, so the row opens it and
  // copies its path rather than leaving the person to find it.
  return `<div class="materials-row materials-row-stacked"><div><h3>Materials folder</h3><p class="path-text">${escapeHtml(folder)}</p><p>${detail}</p></div><div class="inline-actions"><button class="secondary-button" type="button" data-action="reveal-materials-folder">Show folder</button><button class="secondary-button" type="button" data-action="copy-example-prompt" data-prompt="${escapeHtml(folder)}" aria-label="Copy the materials folder path">Copy path</button><button class="secondary-button" type="button" data-action="choose-workspace">${settled ? "Change folder" : "Choose folder"}</button></div></div>`;
}

/** What one assistant row says about that assistant, in the words it can prove. */
function assistantDetail(assistant) {
  if (assistant.configured === true) return "Morrow is set up in this assistant.";
  if (assistant.pending === true) return assistant.checking === true ? "Morrow is checking the connection to Claude Desktop." : "Waiting for your approval in Claude Desktop.";
  if (assistant.detected !== true) return "Not found on this computer.";
  return "Not set up yet.";
}

function assistantRow(assistant) {
  const title = escapeHtml(assistant.title);
  const identifier = escapeHtml(assistant.id);
  // The assistant reads Morrow's entry only inside the project folder it was set up in. With that
  // folder gone there is nothing to repair, so the row names the folder and offers Remove alone.
  if (assistant.projectFolderMissing === true) {
    return `<div class="materials-row materials-row-stacked"><div><h3>${title}</h3><p class="path-text">${escapeHtml(assistant.projectFolder)}</p><p>Morrow cannot find the project folder ${title} was set up in. If it is on a drive that is not connected, connect the drive, then select Check status. Otherwise select Remove, then set up ${title} in the project you use now.</p></div><div class="inline-actions"><button class="secondary-button" type="button" data-action="remove-assistant" data-assistant-id="${identifier}" aria-label="Remove Morrow from ${title}">Remove</button></div></div>`;
  }
  const actions = [];
  if (assistant.pending === true) {
    actions.push('<button class="secondary-button" type="button" data-action="open-claude-desktop">Open Claude Desktop</button>');
    actions.push('<button class="secondary-button" type="button" data-action="reveal-claude-extension">Show Morrow extension</button>');
    actions.push('<button class="secondary-button" type="button" data-action="check-claude-desktop">Check setup</button>');
  }
  if (assistant.configured === true || assistant.pending === true) {
    actions.push(`<button class="secondary-button" type="button" data-action="remove-assistant" data-assistant-id="${identifier}" aria-label="Remove Morrow from ${title}">Remove</button>`);
  } else if (assistant.detected === true && assistant.supported !== false) {
    actions.push(`<button class="secondary-button" type="button" data-action="install-assistant" data-assistant-id="${identifier}">Set up ${title}</button>`);
  }
  // Claude Desktop keeps its own copy of an extension it installed, so removing
  // it here leaves a step inside Claude Desktop. That is said before the click.
  const claudeNote = assistant.id === "claude-desktop" && (assistant.configured === true || assistant.pending === true)
    ? "<p>Remove takes away the Morrow extension Morrow made for Claude Desktop. If Claude Desktop has it installed, remove Morrow there as well, under Settings, Extensions.</p>"
    : "";
  return `<div class="materials-row"><div><h3>${title}</h3><p>${assistantDetail(assistant)}</p>${claudeNote}</div><div class="inline-actions">${actions.join("")}</div></div>`;
}

/**
 * The setup a person can change once there is a setup to change: the
 * materials folder, every assistant Morrow is set up in, and every other
 * assistant on this computer it can be added to. It lives on the Settings
 * view (D8, D9): Home shows status and example requests only, never the
 * setup a person can change. Repair is the exception: from that state Morrow
 * offers the repair and a re-check and nothing else, so Settings shows
 * nothing to change either.
 */
export function setupManagementView(current) {
  if (current?.lifecycle === "repair_required" || current?.runtime?.status === "repair_required") return null;
  const all = Array.isArray(current?.assistants) ? current.assistants : [];
  const projectFolderMissing = all.some((assistant) => assistant?.projectFolderMissing === true);
  if (!configuredAssistant(current) && !pendingAssistant(current) && !projectFolderMissing) return null;
  const assistants = all
    .filter((assistant) => assistant?.configured === true || assistant?.pending === true || assistant?.projectFolderMissing === true
      || (assistant?.detected === true && assistant?.supported !== false));
  return { title: "Setup you can change", body: `${materialsRow(current)}${assistants.map(assistantRow).join("")}` };
}

/** The one step the panel asks for. Setup management moved to Settings (D8). */
export function actionView(current, options = {}) {
  return actionPanel(current, options);
}

// The one status line each row of the Home screen shows once the first read
// is complete (D8): a fixed label, one state word, and the one action Home
// offers for it. Deeper management for each area lives on the Settings view.
const HOME_STATUS_ROWS = Object.freeze([
  { label: "Assistant", word: "Ready", action: "open-settings", actionLabel: "Manage" },
  { label: "Morrow Bridge", word: "Connected", action: "check-bridge", actionLabel: "Check Bridge" },
  { label: "Courses", word: "Connected", action: "run-first-read", actionLabel: "Check connection" },
]);

const EXAMPLE_REQUESTS = Object.freeze([
  "Find images with no alternative text in this course.",
  "Move the due date of the first assignment one week later.",
  "Summarize the modules in this course and flag anything that needs review.",
]);

function examplePrompt(text) {
  return `<div class="prompt"><span class="prompt-text">${escapeHtml(text)}</span><div class="inline-actions"><button class="secondary-button" type="button" data-action="copy-example-prompt" data-prompt="${escapeHtml(text)}">Copy</button></div></div>`;
}

function homeStatusLines() {
  return `<ul class="home-status">${HOME_STATUS_ROWS.map((row) => `<li class="home-status-row"><span class="home-status-label">${escapeHtml(row.label)}</span><span class="home-status-word">${escapeHtml(row.word)}</span><button class="secondary-button" type="button" data-action="${row.action}">${row.actionLabel}</button></li>`).join("")}</ul>`;
}

/**
 * Whether the action panel is asking the person to load the unpacked Bridge
 * folder in Chrome. The renderer times this step so it can point at the exact
 * folder when Chrome has not loaded it after a while.
 */
export function awaitingBridgeFolder(current) {
  return Boolean(current) && current.appLocation !== "move_required" && current.assistantsNeedRepoint !== true
    && current.lifecycle !== "repair_required" && current.runtime?.status === "ready"
    && configuredAssistant(current) !== null && !deliveryBlocked(current)
    && current.bridge?.manualChromeReloadRequired !== true && !bridgeUpdateOffered(current)
    && needsBridge(current) && current.bridge?.folderReady === true && current.bridge?.delivery === "developer_temporary";
}

/**
 * The exact Bridge folder, a Copy button, and the way to reach it from Chrome's
 * folder picker, which does not show this hidden folder by default.
 */
function bridgeFolderBlock(current, { platform = null, bridgeWaitExpired = false } = {}) {
  const folder = current?.bridge?.folderPath;
  if (typeof folder !== "string" || folder.length === 0) return "";
  const reach = platform === "win32"
    ? "In the folder picker Chrome opens, paste this path into the address bar at the top of the folder picker, press Enter, then select <strong>Select Folder</strong>."
    : platform === "darwin"
      ? "In the folder picker Chrome opens, press <strong>Command+Shift+G</strong>, paste this path, press Return, then select <strong>Select</strong>."
      : "In the folder picker Chrome opens, go to this path.";
  const late = bridgeWaitExpired
    ? '<div class="blocked-box"><strong>Chrome has not loaded Morrow Bridge yet</strong><p>Check that you chose this exact folder in <strong>Load unpacked</strong>, not a folder inside it or a copy of it.</p></div>'
    : "";
  return `${late}<div class="materials-row"><div><h3>Bridge folder</h3><p class="path-text">${escapeHtml(folder)}</p><p>${reach}</p></div><button class="secondary-button" type="button" data-action="copy-example-prompt" data-prompt="${escapeHtml(folder)}" aria-label="Copy the Bridge folder path">Copy path</button></div>`;
}

function actionPanel(current, { chosenAssistantId = null, platform = null, bridgeWaitExpired = false } = {}) {
  if (current.appLocation === "move_required") return movePanel();
  const bridge = current.bridge || {};
  const assistant = configuredAssistant(current);
  const selected = assistantFor(current);
  const blocked = deliveryBlocked(current);
  if (current.lifecycle === "repair_required" || current.runtime?.status === "repair_required") {
    return {
      summary: "Morrow needs repair",
      title: "Repair Morrow before you connect a course.",
      copy: "Morrow did not confirm that its local runtime is ready. No course connection or course action will start from this state.",
      body: '<div class="blocked-box"><strong>Setup needs repair</strong><p>Repair checks the files inside Morrow and restores what it can. It replaces the Morrow Bridge folder from the copy Morrow ships when the folder on this computer does not match it. It writes Morrow&#39;s own entry in each assistant&#39;s settings file again and leaves the rest of that file as it is. It changes nothing in your course.</p></div><div class="inline-actions"><button class="primary-button" type="button" data-action="repair">Repair Morrow</button><button class="secondary-button" type="button" data-action="check-setup-state">Check again</button></div>',
    };
  }
  if (current.assistantsNeedRepoint === true) return repointPanel();
  const pending = pendingAssistant(current);
  // A second assistant waiting for approval must not take the steps of the
  // assistant that is already set up away, so this is the panel only while no
  // assistant is configured.
  if (pending?.id === "claude-desktop" && pending.checking === true && !assistant) {
    return {
      summary: "Checking the Claude Desktop connection",
      title: "Morrow is checking the Claude Desktop connection.",
      copy: "Claude Desktop started Morrow, and Morrow is confirming that the Claude Desktop app on this computer started it. On a busy computer this can take a minute. Morrow keeps checking on its own. Select Check setup to see the result.",
      body: '<div class="inline-actions"><button class="primary-button" type="button" data-action="check-claude-desktop">Check setup</button><button class="secondary-button" type="button" data-action="open-claude-desktop">Open Claude Desktop</button></div>',
    };
  }
  if (pending?.id === "claude-desktop" && !assistant) {
    return {
      summary: "Finish setting up Claude Desktop",
      title: "Finish setting up Claude Desktop.",
      copy: "Morrow prepared its extension for Claude Desktop. Install it there, then return here to check the connection.",
      body: '<ol class="instructions"><li>Open Claude Desktop and select <strong>Settings</strong>, then <strong>Extensions</strong>.</li><li>Open <strong>Advanced settings</strong> and select <strong>Install Extension</strong>.</li><li>Select <strong>Show Morrow extension</strong> below to find <strong>Morrow.mcpb</strong>. Choose that file in Claude Desktop and approve the installation.</li></ol><div class="inline-actions"><button class="primary-button" type="button" data-action="open-claude-desktop">Open Claude Desktop</button><button class="secondary-button" type="button" data-action="reveal-claude-extension">Show Morrow extension</button><button class="secondary-button" type="button" data-action="check-claude-desktop">Check setup</button></div>',
    };
  }
  if (!assistant) {
    const selectedId = chosenAssistantId || selected?.id || "";
    const active = Array.isArray(current.assistants) && current.assistants.find((entry) => entry?.id === selectedId && entry.detected === true && entry.supported !== false);
    return {
      summary: "Choose your assistant",
      title: "Choose your assistant.",
      copy: "Morrow configures only the assistant you choose. Your course sign-in remains separate in Chrome.",
      body: `${assistantCards(current, chosenAssistantId)}${materialsRow(current, { optionalDisclosure: true })}<div class="inline-actions"><button class="primary-button" type="button" data-action="install-assistant"${active ? "" : " disabled"}>${active ? `Set up ${escapeHtml(active.title)}` : "Choose an assistant"}</button></div>`,
    };
  }
  // The runtime cannot start without its materials folder, so this comes before
  // the wait for the runtime: waiting never brings the folder back.
  const missing = current.materialsFolder ? null : current.materialsFolderMissing;
  if (missing?.isDefault === true) {
    return {
      summary: "Materials folder not found",
      title: "Morrow cannot find its Materials folder.",
      copy: "Morrow keeps course materials in its own Materials folder, and that folder is gone. Your assistant cannot use Morrow until Morrow has a materials folder again.",
      body: `<div class="materials-row materials-row-stacked"><div><h3>Materials folder</h3><p class="path-text">${escapeHtml(missing.path)}</p><p>Make the folder again gives Morrow a new, empty Materials folder in the same place. Files that were in the old folder do not come back. If you moved the folder, select Choose folder and choose it where it is now.${rebindSentence(configuredAssistants(current), "Choosing a folder writes it into")}</p></div></div><div class="inline-actions"><button class="primary-button" type="button" data-action="restore-materials-folder">Make the folder again</button><button class="secondary-button" type="button" data-action="choose-workspace">Choose folder</button></div>`,
    };
  }
  if (missing) {
    return {
      summary: "Materials folder not found",
      title: "Morrow cannot find your materials folder.",
      copy: "The folder may have been moved, renamed, or deleted, or it may be on a drive that is not connected. Your assistant cannot use Morrow until Morrow has a materials folder again.",
      body: `<div class="materials-row materials-row-stacked"><div><h3>Materials folder</h3><p class="path-text">${escapeHtml(missing.path)}</p><p>${rebindSentence(configuredAssistants(current), "Choosing a folder writes it into").trimStart()}</p></div></div><ol class="instructions"><li>If the folder is on a drive that is not connected, connect the drive, then select <strong>Check again</strong>.</li><li>Otherwise select <strong>Choose folder</strong> and choose the folder where it is now, or another folder.</li></ol><div class="inline-actions"><button class="primary-button" type="button" data-action="choose-workspace">Choose folder</button><button class="secondary-button" type="button" data-action="check-setup-state">Check again</button></div>`,
    };
  }
  if (current.runtime?.status !== "ready") {
    return {
      summary: "Morrow is getting ready",
      title: "Morrow is getting ready.",
      copy: "Morrow will show the next Bridge step when its local runtime is ready. It will not open Chrome setup before then.",
      body: '<div class="info-box"><strong>Local setup is still in progress</strong><p>Keep Morrow open, then check status again.</p></div>',
    };
  }
  if (blocked) {
    return {
      summary: "Morrow Bridge is not available yet",
      title: "Morrow Bridge is not available yet.",
      copy: "Your assistant can be ready while the Chrome connection is still unavailable. Morrow will not suggest an unverified installation route.",
      body: '<div class="blocked-box"><strong>Chrome delivery is not ready</strong><p>Check status again when Morrow Bridge delivery is available.</p></div>',
    };
  }
  if (bridge.manualChromeReloadRequired === true) {
    return {
      summary: "Reload Morrow Bridge in Chrome",
      title: "Reload Morrow Bridge.",
      copy: "Morrow staged a verified Bridge update. Chrome must reload Morrow Bridge before Morrow can check the update.",
      body: '<ol class="instructions"><li>In Chrome, open the <strong>three-dot menu</strong>, select <strong>Extensions</strong>, then <strong>Manage Extensions</strong>.</li><li>Find <strong>Morrow Bridge</strong> on that page and select <strong>Reload</strong>.</li><li>Return here and select <strong>Check Bridge</strong>.</li></ol><div class="inline-actions"><button class="primary-button" type="button" data-action="check-bridge">Check Bridge</button><button class="secondary-button" type="button" data-action="restore-bridge">Restore previous Bridge</button></div>',
    };
  }
  if (bridgeUpdateOffered(current)) {
    return {
      summary: "Update Morrow Bridge",
      title: "Update Morrow Bridge.",
      copy: "This Morrow app includes newer Bridge files. Update the app-owned Bridge folder, then reload the extension in Chrome. This does not change your course.",
      body: '<div class="inline-actions"><button class="primary-button" type="button" data-action="check-bridge">Update Bridge</button></div>',
    };
  }
  if (needsBridge(current) && bridge.folderReady !== true) {
    return {
      summary: "Morrow Bridge is not ready to open",
      title: "Morrow Bridge is not ready to open.",
      copy: "Morrow could not verify its Bridge folder. Repair Morrow to restore the folder from the copy included with the app.",
      body: '<div class="info-box"><strong>Repair the local setup</strong><p>Repair checks Morrow and restores its Bridge folder. It writes Morrow&#39;s own entry in each assistant&#39;s settings file again and leaves the rest of that file as it is. It makes no course changes.</p></div><div class="inline-actions"><button class="primary-button" type="button" data-action="repair">Repair Morrow</button><button class="secondary-button" type="button" data-action="check-setup-state">Check again</button></div>',
    };
  }
  if (needsBridge(current) && bridge.delivery === "developer_temporary") {
    return {
      summary: "Set up Morrow Bridge in Chrome",
      title: "Add Morrow Bridge.",
      copy: "Use this temporary Chrome method until Morrow Bridge is available in the Chrome Web Store.",
      body: bridgeFolderBlock(current, { platform, bridgeWaitExpired }) + '<ol class="instructions"><li>Select <strong>Show Bridge folder</strong>. Morrow opens the folder named <strong>Bridge</strong> and selects its manifest.json file.</li><li>In Chrome, open the <strong>three-dot menu</strong>, select <strong>Extensions</strong>, then <strong>Manage Extensions</strong>.</li><li>On that page, turn on <strong>Developer mode</strong>.</li><li>Select <strong>Load unpacked</strong>, then select that <strong>Bridge</strong> folder.</li><li>Open <strong>Morrow Bridge</strong> in Chrome and select <strong>Connect Morrow</strong>.</li></ol><div class="inline-actions"><button class="primary-button" type="button" data-action="reveal-bridge-folder">Show Bridge folder</button><button class="secondary-button" type="button" data-action="check-bridge">Check Bridge</button><button class="secondary-button" type="button" data-action="repair">Repair Morrow</button></div>',
    };
  }
  if (needsBridge(current) && bridge.delivery === "available") {
    return {
      summary: "Set up Morrow Bridge in Chrome",
      title: "Install Morrow Bridge.",
      copy: "Morrow Bridge uses the learning platform where you are already signed in. It asks Chrome for access only to the exact learning platform you choose.",
      body: '<ol class="instructions"><li>In Chrome, open the <strong>three-dot menu</strong>, select <strong>Extensions</strong>, then <strong>Visit Chrome Web Store</strong>.</li><li>Search the store for <strong>Morrow Bridge</strong>, then select <strong>Add to Chrome</strong>.</li><li>Open <strong>Morrow Bridge</strong> in Chrome and select <strong>Connect Morrow</strong>.</li></ol><div class="inline-actions"><button class="primary-button" type="button" data-action="check-bridge">Check Bridge</button></div>',
    };
  }
  if (bridge.paired !== true) {
    const title = assistant.title;
    return {
      summary: "Connect Morrow Bridge",
      title: "Connect Morrow Bridge.",
      copy: `${title} is configured. Open Morrow Bridge in Chrome and select Connect Morrow.`,
      body: '<ol class="instructions"><li>Open <strong>Morrow Bridge</strong> in Chrome.</li><li>Select <strong>Connect Morrow</strong>. Morrow connects only the Morrow Bridge loaded from the folder Morrow shows.</li><li>Return here and select <strong>Check Bridge</strong>.</li></ol><div class="inline-actions"><button class="primary-button" type="button" data-action="check-bridge">Check Bridge</button></div>',
    };
  }
  if (!verifiedCourse(current)) {
    return {
      summary: "Morrow Bridge is connected",
      title: "Open your course in Chrome.",
      copy: "Morrow Bridge identifies Canvas or Moodle after you open a signed-in course.",
      body: '<ol class="instructions"><li>Open a Canvas or Moodle course you can access in <strong>Chrome</strong> and sign in.</li><li>Open <strong>Morrow Bridge</strong>. It identifies the platform and shows <strong>Connect this course</strong>.</li><li>Select that button and allow access to the exact platform address Chrome shows.</li><li>In Morrow Bridge, select <strong>Open Plan and Edit settings</strong>. Under <strong>Your courses</strong>, select <strong>Connect</strong> next to each course Morrow may use. Each course starts in Plan.</li><li>Return here and select <strong>Check Bridge</strong>.</li></ol><div class="inline-actions"><button class="primary-button" type="button" data-action="check-bridge">Check Bridge</button></div>',
    };
  }
  const course = bridge.firstPreviewCourseName || bridge.selectedCourseName || "your selected course";
  if (previewCompleted(current) && restartAssistant(current)) return restartPanel(restartAssistant(current), current);
  if (previewCompleted(current)) {
    return {
      summary: "First read complete",
      title: "Your course is connected.",
      copy: `Morrow read ${course} successfully. Continue in ${assistant.title} and ask what you want to do.`,
      body: `${homeStatusLines()}<h3>Try asking</h3>${EXAMPLE_REQUESTS.map(examplePrompt).join("")}`,
    };
  }
  if (previewReady(current)) {
    return {
      summary: "First read is ready",
      title: "Check your course connection.",
      copy: `Morrow will read ${course} to confirm the connection. This check does not change the course.`,
      body: '<button class="primary-button" type="button" data-action="run-first-read">Check connection</button>',
    };
  }
  // A connected course Morrow cannot read now: none is readable yet, or its
  // read just failed. Either way the course is not usable, so it is never
  // called connected here.
  return {
    summary: "Morrow cannot read your course yet",
    title: "Morrow cannot read your course yet.",
    copy: "Open your Canvas or Moodle course in Chrome and make sure you are signed in, then select Check status.",
    body: '<div class="info-box"><strong>Morrow reads your course once to confirm the connection</strong><p>This read does not change the course.</p></div>',
  };
}

/**
 * The configured assistant whose own Morrow session has not connected yet. An
 * assistant reads its settings when it starts, so it must be quit and opened
 * again before it can use Morrow. Claude Desktop is configured only once its
 * session connected, so it never needs this step.
 */
function restartAssistant(current) {
  const assistant = configuredAssistant(current);
  return assistant && assistant.id !== "claude-desktop" && assistant.connected !== true ? assistant : null;
}

function restartPanel(assistant, current) {
  const title = escapeHtml(assistant.title);
  // The runtime sees that an assistant session connected, not which assistant it is, so a check
  // after any one reopens counts for every assistant set up.
  const configured = configuredAssistants(current);
  const which = configured.length > 1
    ? `<div class="info-box"><strong>Reopen each assistant</strong><p>Morrow can tell that an assistant opened Morrow, but it cannot tell which one. Quit and reopen each assistant you set up: ${assistantTitles(configured)}.</p></div>`
    : "";
  // Claude Code and Gemini CLI read Morrow's entry only in the project folder chosen at setup, and
  // Claude Code uses a project's server only after the person approves it there.
  const folder = typeof assistant.projectFolder === "string" && assistant.projectFolder.length > 0
    ? `<span class="path-text">${escapeHtml(assistant.projectFolder)}</span>`
    : null;
  const reopen = folder && assistant.id === "claude-code"
    ? `<li>Quit <strong>${title}</strong> completely.</li><li>Open <strong>${title}</strong> in the project folder ${folder}. When ${title} asks whether to use the morrow server from this project, approve it.</li>`
    : folder
      ? `<li>Quit <strong>${title}</strong> completely.</li><li>Start <strong>${title}</strong> in the project folder ${folder}.</li>`
      : `<li>Quit <strong>${title}</strong> completely. Closing its window is not enough.</li><li>Open <strong>${title}</strong> again and start a new chat.</li>`;
  return {
    summary: `Quit and reopen ${assistant.title}`,
    title: "Quit and reopen your assistant.",
    copy: folder
      ? `${assistant.title} reads Morrow's entry only from the project folder you chose, and only when it starts there.`
      : `${assistant.title} reads its settings only when it starts. It cannot use Morrow until you open it again.`,
    body: `${which}<ol class="instructions">${reopen}<li>Return here and select <strong>Check ${title}</strong>.</li></ol><div class="inline-actions"><button class="primary-button" type="button" data-action="check-assistant-connection">Check ${title}</button></div>`,
  };
}

function movePanel() {
  return {
    summary: "Move Morrow to Applications",
    title: "Move Morrow to Applications.",
    copy: "Morrow is running from the disk image or a download folder. An assistant set up from here would lose Morrow when that place goes away.",
    body: '<div class="info-box"><strong>Morrow moves itself</strong><p>Morrow moves to your Applications folder and opens again from there. Then continue setup.</p></div><div class="inline-actions"><button class="primary-button" type="button" data-action="move-to-applications">Move to Applications</button></div>',
  };
}

function repointPanel() {
  return {
    summary: "Update your assistant settings",
    title: "Update your assistant settings.",
    copy: "Your assistant still starts Morrow from the place Morrow was before it moved.",
    body: '<div class="info-box"><strong>Repair writes the new place</strong><p>Repair changes only Morrow&#39;s own entry in each assistant&#39;s settings file and leaves the rest of that file as it is.</p></div><div class="inline-actions"><button class="primary-button" type="button" data-action="repair">Repair Morrow</button><button class="secondary-button" type="button" data-action="check-setup-state">Check again</button></div>',
  };
}

// Remove Morrow's data takes Morrow's entry out of the assistant settings files
// Morrow changed and nothing out of Claude Desktop, so no step claims it stops
// every assistant from starting Morrow. The Claude Desktop step goes between
// the two when Claude Desktop keeps its own copy of the extension.
const UNINSTALL_FIRST_STEP = "To remove the Morrow application, first select Remove Morrow's data. It takes Morrow's entry out of every assistant settings file Morrow changed.";
const UNINSTALL_CLAUDE_STEP = "Also remove Morrow in Claude Desktop under Settings, Extensions.";
const UNINSTALL_STEPS = Object.freeze({
  move_to_trash: "Then quit Morrow and move it to the Trash.",
  // Windows 11 and Windows 10 name the Settings page and its buttons differently.
  windows_settings_apps: "Then quit Morrow and open Settings, then Apps. On Windows 11, select Installed apps, find Morrow, select More, then Uninstall. On Windows 10, select Apps & features, select Morrow, then Uninstall.",
  unknown: "Then quit Morrow and remove it the way this computer removes an application."
});

const KEPT_REASONS = Object.freeze({
  assistant_configuration: "Your assistant's own settings file. Remove Morrow's data takes only Morrow's own entry out of it and leaves the rest.",
  assistant_backup: "Copies of your assistant settings from before Morrow changed them. Morrow keeps these copies so you can put a settings file back.",
  outside_morrow_data: "Outside the folders Morrow keeps its own files in. Morrow leaves it as it is.",
  claude_desktop_extension: "Claude Desktop keeps its own copy of the Morrow extension. Remove Morrow in Claude Desktop under Settings, Extensions."
});

function retentionRows(locations) {
  return `<ul class="retention-list">${locations.map((location) => `<li>
    <span class="retention-label">${escapeHtml(location.label)}</span>
    <span class="retention-path">${escapeHtml(location.path)}</span>
    ${location.keptReason ? `<span class="retention-note">${escapeHtml(KEPT_REASONS[location.keptReason] || "Morrow leaves it as it is.")}</span>` : ""}
  </li>`).join("")}</ul>`;
}

function retentionPathList(paths) {
  return `<ul class="retention-list">${paths.map((value) => `<li><span class="retention-path">${escapeHtml(value)}</span></li>`).join("")}</ul>`;
}

/**
 * What one removal did, in the words the receipt supports. A path the removal
 * could not remove is named as still on this computer, never as removed.
 */
function retentionRemoval(removal) {
  if (!removal) return "";
  if (removal.status === "cancelled") {
    return '<div class="info-box"><strong>Nothing was removed</strong><p>Morrow removed nothing from this computer.</p></div>';
  }
  const removed = removal.removed.length
    ? `<p>Morrow removed these:</p>${retentionPathList(removal.removed)}`
    : "<p>Morrow removed nothing.</p>";
  if (removal.status === "removed") {
    return `<div class="info-box"><strong>Morrow removed its data</strong>${removed}<p>Morrow creates an empty setup folder for itself again while it stays open, so quit Morrow before you remove the application.</p></div>`;
  }
  return `<div class="blocked-box"><strong>Morrow could not remove everything</strong>${removed}<p>These are still on this computer:</p>${retentionPathList(removal.remaining)}<p>Close anything that is using them and select Remove Morrow's data again, or remove them yourself.</p></div>`;
}

/**
 * The data-retention section. It names the exact place of every file this
 * installation keeps, which of them the in-app removal can remove, and the step
 * this computer uses to remove the application itself.
 */
// Chrome is named as having loaded Morrow Bridge only when setup saw it loaded
// or connected, and the folder it loaded is only named when it is listed above.
function bridgeRemovalSentence(current, locations) {
  const steps = "open the Chrome <strong>three-dot menu</strong>, select <strong>Extensions</strong>, then <strong>Manage Extensions</strong>, then remove <strong>Morrow Bridge</strong>.";
  const bridge = current?.bridge || {};
  if (bridge.loadedInChrome !== true && bridge.paired !== true) return `If you added <strong>Morrow Bridge</strong> in Chrome, remove it there too: ${steps}`;
  const folderListed = bridge.delivery === "developer_temporary" && locations.some((location) => location.id === "bridge");
  return `${folderListed ? "Chrome loaded Morrow Bridge from the Bridge folder above. " : ""}To remove Morrow Bridge from Chrome, ${steps}`;
}

export function retentionView(current) {
  const retention = current?.retention;
  if (retention?.schema !== "morrow.installer-retention.v1" || !Array.isArray(retention.locations) || retention.locations.length === 0) return null;
  const removable = retention.locations.filter((location) => location.removable === true);
  const kept = retention.locations.filter((location) => location.removable !== true);
  return {
    title: "What stays on this computer",
    copy: `Removing the Morrow application removes the application only. ${removable.length && kept.length
      ? "Remove Morrow's data removes the first group below. Morrow never removes the second group."
      : removable.length ? "Remove Morrow's data removes everything below." : "Morrow never removes anything below."}`,
    body: [
      removable.length ? `<div><h3>Morrow can remove these</h3>${retentionRows(removable)}</div>` : "",
      kept.length ? `<div><h3>Morrow does not remove these</h3>${retentionRows(kept)}</div>` : "",
      retentionRemoval(retention.removal),
      `<p>${escapeHtml([
        UNINSTALL_FIRST_STEP,
        ...(retention.locations.some((location) => location.id === "claude_desktop_extension") ? [UNINSTALL_CLAUDE_STEP] : []),
        UNINSTALL_STEPS[retention.uninstall] || UNINSTALL_STEPS.unknown
      ].join(" "))}</p>`,
      `<p>${bridgeRemovalSentence(current, retention.locations)}</p>`,
      removable.length ? '<div class="inline-actions"><button class="secondary-button danger-button" type="button" data-action="remove-data">Remove Morrow&#39;s data</button></div>' : ""
    ].join("")
  };
}

/**
 * The view Morrow shows when it has no setup state to read. There is no state
 * to summarise here, so this view carries its own header summary.
 */
export function setupUnavailableView() {
  return {
    summary: "Morrow could not read its setup state",
    title: "Morrow could not read its setup state.",
    copy: "Morrow could not read the setup record it keeps on this computer, so it cannot show which steps are complete. No setup step ran.",
    body: '<div class="blocked-box"><strong>No setup state was returned</strong><p>Check again. If Morrow still cannot read its setup state, close Morrow and open it again.</p></div><div class="inline-actions"><button class="primary-button" type="button" data-action="check-setup-state">Check again</button></div>',
  };
}

export function problemView(problem) {
  if (!problem) return null;
  return {
    message: problem.message || "Morrow could not complete that step.",
    recovery: problem.recovery || "Check the setup state and try again.",
  };
}

// The support address Morrow is allowed to open (D5). It matches the fixed
// external-address allow list in installer/main.cjs, and the address the
// Claude Desktop bundle already names for itself
// (installer/shared/claude-desktop.cjs:120).
const SUPPORT_ADDRESS = "https://meetmorrow.app/support";

/**
 * What a person needs when they ask for help: which Morrow this is, where it
 * keeps its own files, and where to write. Morrow names only what its state
 * carries, so a value it has not read is left out instead of guessed at. The
 * support address is a control, not a link, because Chrome sandboxing denies
 * in-window navigation: selecting it asks the main process to open exactly
 * this address, the one entry of the allow list Morrow can reach today.
 */
export function supportView(current) {
  const version = typeof current?.updates?.currentVersion === "string" && current.updates.currentVersion.length > 0
    ? current.updates.currentVersion
    : null;
  const materials = typeof current?.materialsFolder === "string" && current.materialsFolder.length > 0 ? current.materialsFolder : null;
  const locations = Array.isArray(current?.retention?.locations) ? current.retention.locations : [];
  const stateFolder = locations.find((location) => location.id === "state")?.path || null;
  const rows = [
    version ? { label: "Morrow version", value: version, path: false } : null,
    materials ? { label: "Materials folder", value: materials, path: true } : null,
    stateFolder ? { label: "Setup record and journal", value: stateFolder, path: true } : null
  ].filter(Boolean);
  const supportRow = `<li><span class="support-label">Support</span><button class="quiet-button" type="button" data-action="open-support">${escapeHtml(SUPPORT_ADDRESS)}</button></li>`;
  return {
    title: "Where to get help",
    copy: version
      ? "Morrow opens its support page. Select Support to open it, and name the version below when you write."
      : "Morrow opens its support page. Select Support to open it.",
    body: `<ul class="support-list">${rows.map((row) => `<li><span class="support-label">${escapeHtml(row.label)}</span><span class="${row.path ? "support-path" : "support-value"}">${escapeHtml(row.value)}</span></li>`).join("")}${supportRow}</ul>`
  };
}

/**
 * What a screen reader hears after one data removal, in the words the panel
 * shows. It is empty until a removal has run, so nothing is announced before
 * then, and it never reports a removal the receipt does not support.
 */
export function removalAnnouncement(current) {
  const removal = current?.retention?.removal;
  if (!removal) return "";
  if (removal.status === "cancelled") return "Morrow removed nothing from this computer.";
  if (removal.status === "removed") return "Morrow removed its data from this computer. Quit Morrow before you remove the application.";
  const remaining = removal.remaining.length;
  return `Morrow could not remove everything. ${remaining === 1 ? "One place is" : `${remaining} places are`} still on this computer, listed under What stays on this computer.`;
}
