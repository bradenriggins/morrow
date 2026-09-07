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

// The header summary follows the same order as the action panel, so the live
// region never announces a later step than the one on screen.
export function statusSummary(current) {
  if (!current) return "Checking setup";
  if (current.lifecycle === "repair_required" || current.runtime?.status === "repair_required") return "Morrow needs repair";
  if (pendingAssistant(current) && !configuredAssistant(current)) return "Finish setting up Claude Desktop";
  if (configuredAssistant(current) && current.runtime?.status !== "ready") return "Morrow is getting ready";
  if (deliveryBlocked(current)) return "Morrow Bridge is not available yet";
  if (current.bridge?.manualChromeReloadRequired === true) return "Reload Morrow Bridge in Chrome";
  if (configuredAssistant(current) && needsBridge(current)) return "Set up Morrow Bridge in Chrome";
  if (previewCompleted(current)) return "First read complete";
  if (previewReady(current)) return "First read is ready";
  if (verifiedCourse(current)) return "Selected course is ready";
  if (current.bridge?.paired === true) return "Morrow Bridge is connected";
  if (configuredAssistant(current)) return "Assistant is ready";
  return "Continue setup";
}

const STEP_LABELS = Object.freeze(["Assistant", "Bridge", "Connect", "Course", "First read"]);

export function progress(current) {
  if (!current) return STEP_LABELS.map((label) => ({ label, detail: "Not checked yet", status: "pending", current: false }));
  const assistant = configuredAssistant(current);
  const pending = pendingAssistant(current);
  const bridge = current?.bridge || {};
  const courseReady = verifiedCourse(current);
  const blocked = deliveryBlocked(current);
  const reloadRequired = bridge.manualChromeReloadRequired === true;
  const firstPreviewReady = previewReady(current);
  const firstPreviewCompleted = previewCompleted(current);
  const needsAssistant = !assistant;
  const loaded = bridge.loadedInChrome === true || bridge.paired === true;
  const bridgeStep = reloadRequired || needsBridge(current);
  const needsPairing = Boolean(assistant) && bridge.paired !== true;
  const needsCourse = bridge.paired === true && !courseReady;
  const active = needsAssistant ? 0 : bridgeStep || blocked ? 1 : needsPairing ? 2 : needsCourse ? 3 : 4;
  return [
    { label: "Assistant", detail: assistant ? configuredAssistants(current).map((entry) => entry.title).join(", ") : pending ? "Finish approval in Claude Desktop" : "Choose an installed assistant", status: assistant ? "done" : pending ? "current" : "current" },
    { label: "Bridge", detail: blocked ? "Not available yet" : reloadRequired ? "Reload in Chrome, then check" : loaded ? "Installed in Chrome" : bridge.delivery === "developer_temporary" ? "Temporary Chrome setup" : "Install from Chrome", status: blocked ? "blocked" : reloadRequired ? "current" : loaded ? "done" : active === 1 ? "current" : "pending" },
    { label: "Connect", detail: bridge.paired === true ? "Connected" : "Connect it in Morrow Bridge", status: bridge.paired === true ? "done" : active === 2 ? "current" : "pending" },
    { label: "Course", detail: courseReady ? (bridge.selectedCourseName || (bridge.runtimeVerifiedCourseCount > 1 ? `${bridge.runtimeVerifiedCourseCount} courses connected` : "Course selected")) : "Connect a signed-in course site", status: courseReady ? "done" : active === 3 ? "current" : "pending" },
    { label: "First read", detail: firstPreviewCompleted ? "Complete" : firstPreviewReady ? "Ready to try" : "Not started", status: firstPreviewCompleted ? "done" : active === 4 ? "current" : "pending" },
  ].map((step, index) => ({ ...step, current: index === active && step.status !== "done" }));
}

function assistantCards(current, chosenAssistantId) {
  const assistants = Array.isArray(current?.assistants) ? current.assistants : [];
  if (!assistants.length) return '<div class="blocked-box"><strong>No supported assistant was found</strong><p>Install a supported assistant, then check status again.</p></div>';
  const card = (assistant) => {
    const selected = assistant.id === chosenAssistantId || (chosenAssistantId === null && assistant.selected === true);
    const available = assistant.detected === true && assistant.supported !== false;
    const configured = assistant.configured === true;
    const pending = assistant.pending === true;
    const detail = configured ? "Morrow is set up here." : pending ? "Finish approval in Claude Desktop." : available ? assistant.id === "claude-desktop" ? "Ready to set up. You approve it in Claude Desktop." : "Ready to set up." : assistant.detected === true ? "Not available in this Morrow version." : "Not found on this computer.";
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
 * The materials folder row. It names the exact folder Morrow uses and offers
 * the change in every state, so the folder is never a choice a person makes
 * once and cannot revisit. What changing it does to each assistant is written
 * here, before the change, because Morrow writes the new folder into every
 * assistant it configured.
 */
function materialsRow(current) {
  const folder = typeof current?.materialsFolder === "string" && current.materialsFolder.length > 0 ? current.materialsFolder : null;
  const configured = configuredAssistants(current);
  const settled = configuredAssistant(current) !== null;
  if (!folder) {
    return `<div class="materials-row"><div><h3>Materials folder</h3><p>Optional. Choose a folder for Morrow materials. If you continue, Morrow creates its own Materials folder.</p></div><button class="secondary-button" type="button" data-action="choose-workspace">Choose folder</button></div>`;
  }
  const rebind = configured.length === 0 ? ""
    : ` Changing it writes the new folder into ${assistantTitles(configured)}.${configured.some((assistant) => assistant.id === "claude-desktop") ? " Claude Desktop then asks you to approve Morrow again." : ""}`;
  const detail = current?.workspaceSelected === true
    ? `Morrow works with the course materials in this folder.${rebind}`
    : `Morrow made this folder for course materials. Choose a different folder to work somewhere else.${rebind}`;
  return `<div class="materials-row"><div><h3>Materials folder</h3><p>${escapeHtml(folder)}</p><p>${detail}</p></div><button class="secondary-button" type="button" data-action="choose-workspace">${settled ? "Change folder" : "Choose folder"}</button></div>`;
}

/** What one assistant row says about that assistant, in the words it can prove. */
function assistantDetail(assistant) {
  if (assistant.configured === true) return "Morrow is set up in this assistant.";
  if (assistant.pending === true) return "Waiting for your approval in Claude Desktop.";
  if (assistant.detected !== true) return "Not found on this computer.";
  return "Not set up yet.";
}

function assistantRow(assistant) {
  const title = escapeHtml(assistant.title);
  const identifier = escapeHtml(assistant.id);
  const actions = [];
  if (assistant.pending === true) {
    actions.push('<button class="secondary-button" type="button" data-action="open-claude-desktop">Open Claude Desktop</button>');
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
 * The setup a person can change after it is done: the materials folder, every
 * assistant Morrow is set up in, and every other assistant on this computer it
 * can be added to. It is shown in every state after setup, so neither the
 * folder nor the assistant list is reachable only from the first screen.
 */
function manageSetup(current) {
  const assistants = (Array.isArray(current?.assistants) ? current.assistants : [])
    .filter((assistant) => assistant?.configured === true || assistant?.pending === true
      || (assistant?.detected === true && assistant?.supported !== false));
  return `<h3 class="setup-heading">Setup you can change</h3>${materialsRow(current)}${assistants.map(assistantRow).join("")}`;
}

/**
 * The one step the panel asks for, plus the setup a person can change once
 * there is a setup to change. Repair is the exception: from that state Morrow
 * offers the repair and a re-check and nothing else.
 */
export function actionView(current, options = {}) {
  const view = actionPanel(current, options);
  if (current?.lifecycle === "repair_required" || current?.runtime?.status === "repair_required") return view;
  if (!configuredAssistant(current) && !pendingAssistant(current)) return view;
  return { ...view, body: `${view.body}${manageSetup(current)}` };
}

function actionPanel(current, { chosenAssistantId = null } = {}) {
  const bridge = current.bridge || {};
  const assistant = configuredAssistant(current);
  const selected = assistantFor(current);
  const blocked = deliveryBlocked(current);
  if (current.lifecycle === "repair_required" || current.runtime?.status === "repair_required") {
    return {
      title: "Repair Morrow before you connect a course.",
      copy: "Morrow did not confirm that its local runtime is ready. No course connection or course action will start from this state.",
      body: '<div class="blocked-box"><strong>Setup needs repair</strong><p>Repair checks the files inside Morrow and restores what it can. It replaces the Morrow Bridge folder from the copy Morrow ships when the folder on this computer does not match it, and it writes your assistant setting again. It leaves a newer assistant setting alone, and it changes nothing in your course.</p></div><div class="inline-actions"><button class="primary-button" type="button" data-action="repair">Repair Morrow</button><button class="secondary-button" type="button" data-action="check-setup-state">Check again</button></div>',
    };
  }
  const pending = pendingAssistant(current);
  // A second assistant waiting for approval must not take the steps of the
  // assistant that is already set up away, so this is the panel only while no
  // assistant is configured.
  if (pending?.id === "claude-desktop" && !assistant) {
    return {
      title: "Finish setting up Claude Desktop.",
      copy: "Morrow opened Claude Desktop with its local extension. Approve it there, then return here to check the connection.",
      body: '<div class="inline-actions"><button class="primary-button" type="button" data-action="open-claude-desktop">Open Claude Desktop</button><button class="secondary-button" type="button" data-action="check-claude-desktop">Check setup</button></div>',
    };
  }
  if (!assistant) {
    const selectedId = chosenAssistantId || selected?.id || "";
    const active = Array.isArray(current.assistants) && current.assistants.find((entry) => entry?.id === selectedId && entry.detected === true && entry.supported !== false);
    return {
      title: "Choose your assistant.",
      copy: "Morrow configures only the assistant you choose. Your course sign-in remains separate in Chrome.",
      body: `${assistantCards(current, chosenAssistantId)}${materialsRow(current)}<div class="inline-actions"><button class="primary-button" type="button" data-action="install-assistant"${active ? "" : " disabled"}>${active ? `Set up ${escapeHtml(active.title)}` : "Choose an assistant"}</button></div>`,
    };
  }
  if (current.runtime?.status !== "ready") {
    return {
      title: "Morrow is getting ready.",
      copy: "Morrow will show the next Bridge step when its local runtime is ready. It will not open Chrome setup before then.",
      body: '<div class="info-box"><strong>Local setup is still in progress</strong><p>Keep Morrow open, then check status again.</p></div>',
    };
  }
  if (blocked) {
    return {
      title: "Morrow Bridge is not available yet.",
      copy: "Your assistant can be ready while the Chrome connection is still unavailable. Morrow will not suggest an unverified installation route.",
      body: '<div class="blocked-box"><strong>Chrome delivery is not ready</strong><p>Check status again when Morrow Bridge delivery is available.</p></div>',
    };
  }
  if (bridge.manualChromeReloadRequired === true) {
    return {
      title: "Reload Morrow Bridge.",
      copy: "Morrow staged a verified Bridge update. Chrome must reload Morrow Bridge before Morrow can check the update.",
      body: '<ol class="instructions"><li>In Chrome, open the <strong>three-dot menu</strong>, select <strong>Extensions</strong>, then <strong>Manage Extensions</strong>.</li><li>Find <strong>Morrow Bridge</strong> on that page and select <strong>Reload</strong>.</li><li>Return here and select <strong>Check Bridge</strong>.</li></ol><div class="inline-actions"><button class="primary-button" type="button" data-action="check-bridge">Check Bridge</button></div>',
    };
  }
  if (needsBridge(current) && bridge.folderReady !== true) {
    return {
      title: "Morrow Bridge is not ready to open.",
      copy: "Morrow could not verify its Bridge folder. Repair Morrow to restore the folder from the copy included with the app.",
      body: '<div class="info-box"><strong>Repair the local setup</strong><p>Repair checks Morrow, restores its Bridge folder, and checks your assistant setup. It preserves newer assistant settings and makes no course changes.</p></div><div class="inline-actions"><button class="primary-button" type="button" data-action="repair">Repair Morrow</button><button class="secondary-button" type="button" data-action="check-setup-state">Check again</button></div>',
    };
  }
  if (needsBridge(current) && bridge.delivery === "developer_temporary") {
    return {
      title: "Add Morrow Bridge.",
      copy: "Use this temporary Chrome method until Morrow Bridge is available in the Chrome Web Store.",
      body: '<ol class="instructions"><li>Select <strong>Show Bridge folder</strong>. Morrow opens the folder named <strong>Bridge</strong> and selects its manifest.json file.</li><li>In Chrome, open the <strong>three-dot menu</strong>, select <strong>Extensions</strong>, then <strong>Manage Extensions</strong>.</li><li>On that page, turn on <strong>Developer mode</strong>.</li><li>Select <strong>Load unpacked</strong>, then select that <strong>Bridge</strong> folder.</li><li>Open <strong>Morrow Bridge</strong> in Chrome and select <strong>Connect Morrow</strong>.</li></ol><div class="inline-actions"><button class="primary-button" type="button" data-action="reveal-bridge-folder">Show Bridge folder</button><button class="secondary-button" type="button" data-action="check-bridge">Check Bridge</button></div>',
    };
  }
  if (needsBridge(current) && bridge.delivery === "available") {
    return {
      title: "Install Morrow Bridge.",
      copy: "Morrow Bridge uses the course site where you are already signed in. It asks Chrome for access only to the exact course site you choose.",
      body: '<ol class="instructions"><li>In Chrome, open the <strong>three-dot menu</strong>, select <strong>Extensions</strong>, then <strong>Visit Chrome Web Store</strong>.</li><li>Search the store for <strong>Morrow Bridge</strong>, then select <strong>Add to Chrome</strong>.</li><li>Open <strong>Morrow Bridge</strong> in Chrome and select <strong>Connect Morrow</strong>.</li></ol><div class="inline-actions"><button class="primary-button" type="button" data-action="check-bridge">Check Bridge</button></div>',
    };
  }
  if (bridge.paired !== true) {
    const title = assistant.title;
    return {
      title: "Connect Morrow Bridge.",
      copy: `${title} is configured. Open Morrow Bridge in Chrome to complete the connection you start.`,
      body: '<ol class="instructions"><li>Open <strong>Morrow Bridge</strong> in Chrome.</li><li>Select <strong>Connect Morrow</strong>.</li><li>On the Morrow page that opens, select <strong>Allow connection</strong> only if you started it.</li><li>Return here and select <strong>Check Bridge</strong>.</li></ol><div class="inline-actions"><button class="secondary-button" type="button" data-action="check-bridge">Check Bridge</button></div>',
    };
  }
  if (!verifiedCourse(current)) {
    return {
      title: "Connect your course.",
      copy: "Connect a Canvas or Moodle course that you can access before Morrow reads course information.",
      body: '<ol class="instructions"><li>Open a Canvas or Moodle course you can access in <strong>Chrome</strong> and sign in.</li><li>In <strong>Morrow Bridge</strong>, select Connect course site and allow Chrome access to that exact site.</li><li>Open Plan and Edit settings, choose a course, then connect it in <strong>Plan</strong>.</li></ol>',
    };
  }
  const course = bridge.firstPreviewCourseName || bridge.selectedCourseName || "your selected course";
  if (previewCompleted(current)) {
    return {
      title: "Your course is connected.",
      copy: `Morrow read ${course} successfully. Continue in ${assistant.title} and ask what you want to do, for example:`,
      body: '<div class="prompt">Summarize the modules in this course and flag anything that needs review.</div>',
    };
  }
  if (previewReady(current)) {
    return {
      title: "Check your course connection.",
      copy: `Morrow will read ${course} to confirm the connection. This check does not change the course.`,
      body: '<button class="primary-button" type="button" data-action="run-first-read">Check connection</button>',
    };
  }
  return {
    title: "Your selected course is connected.",
    copy: `${course} is connected. Morrow will show when its first read is available.`,
    body: '<div class="info-box"><strong>First read is still preparing</strong><p>Check status again before you ask Morrow to inspect the course.</p></div>',
  };
}

const UNINSTALL_STEPS = Object.freeze({
  move_to_trash: "To remove the Morrow application, quit Morrow and move it to the Trash.",
  windows_settings_apps: "To remove the Morrow application, quit Morrow, then open Settings, select Apps, select Morrow, and select Uninstall.",
  unknown: "To remove the Morrow application, quit Morrow and remove it the way this computer removes an application."
});

const KEPT_REASONS = Object.freeze({
  assistant_configuration: "Your assistant's own settings file. Morrow leaves it as it is.",
  outside_morrow_data: "Outside the folders Morrow keeps its own files in. Morrow leaves it as it is."
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
export function retentionView(current) {
  const retention = current?.retention;
  if (retention?.schema !== "morrow.installer-retention.v1" || !Array.isArray(retention.locations) || retention.locations.length === 0) return null;
  const removable = retention.locations.filter((location) => location.removable === true);
  const kept = retention.locations.filter((location) => location.removable !== true);
  return {
    title: "What stays on this computer",
    copy: "Removing the Morrow application removes the application only. Everything below stays on this computer until you remove it here.",
    body: [
      removable.length ? `<div><h3>Morrow can remove these</h3>${retentionRows(removable)}</div>` : "",
      kept.length ? `<div><h3>Morrow does not remove these</h3>${retentionRows(kept)}</div>` : "",
      retentionRemoval(retention.removal),
      `<p>${escapeHtml(UNINSTALL_STEPS[retention.uninstall] || UNINSTALL_STEPS.unknown)}</p>`,
      '<p>Chrome loaded Morrow Bridge from the Bridge folder above. To remove it, open the Chrome <strong>three-dot menu</strong>, select <strong>Extensions</strong>, then <strong>Manage Extensions</strong>, then remove <strong>Morrow Bridge</strong>.</p>',
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

// The support address the Morrow application already names for itself, in the
// Claude Desktop bundle it writes (installer/shared/claude-desktop.cjs:120).
const SUPPORT_ADDRESS = "https://meetmorrow.app/support";

/**
 * What a person needs when they ask for help: which Morrow this is, where it
 * keeps its own files, and where to write. Morrow names only what its state
 * carries, so a value it has not read is left out instead of guessed at. The
 * address is text rather than a link because Morrow opens no web page.
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
    stateFolder ? { label: "Setup record and journal", value: stateFolder, path: true } : null,
    { label: "Support", value: SUPPORT_ADDRESS, path: false }
  ].filter(Boolean);
  return {
    title: "Where to get help",
    copy: "Morrow opens no web page. Open the support address in your browser, and name the version below when you write.",
    body: `<ul class="support-list">${rows.map((row) => `<li><span class="support-label">${escapeHtml(row.label)}</span><span class="${row.path ? "support-path" : "support-value"}">${escapeHtml(row.value)}</span></li>`).join("")}</ul>`
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
