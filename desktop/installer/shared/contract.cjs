const {
  DATA_REMOVAL_SCHEMA,
  KEPT_REASONS,
  REMOVAL_STATUSES,
  RETENTION_SCHEMA,
  UNINSTALL_STEPS,
  uninstallPolicy
} = require("./state-policy.cjs");

const ASSISTANTS = Object.freeze([
  Object.freeze({ id: "codex", title: "ChatGPT", tier: "primary", needsProject: false, supported: true }),
  Object.freeze({ id: "claude-desktop", title: "Claude Desktop", tier: "primary", needsProject: false, supported: true }),
  Object.freeze({ id: "claude-code", title: "Claude Code", tier: "advanced", needsProject: true, supported: true }),
  Object.freeze({ id: "gemini-cli", title: "Gemini CLI", tier: "advanced", needsProject: true, supported: true }),
]);

const ASSISTANT_IDS = new Set(ASSISTANTS.map(({ id }) => id));
const RETENTION_IDS = new Set([
  "state",
  "backups",
  "bridge",
  "materials",
  "blackboard_credentials",
  "blackboard_configuration",
  "assistant_configuration"
]);
/**
 * Every error the renderer can be shown, with the exact message and recovery
 * it carries. This table is the whole public error vocabulary: `envelope`
 * refuses any other code and emits only these texts, so an internal message
 * or path carried by a thrown error never reaches the renderer.
 */
const PUBLIC_ERRORS = Object.freeze({
  assistant_not_found: {
    message: "That assistant is not available on this computer.",
    recovery: "Install or open the assistant, then return to Morrow."
  },
  workspace_required: {
    message: "Choose a Morrow materials folder first.",
    recovery: "Choose a folder that contains only the materials you want Morrow to use."
  },
  existing_morrow_configuration: {
    message: "Morrow is already set up differently.",
    recovery: "Morrow left the existing settings unchanged. Review that setup before trying again."
  },
  assistant_configuration_changed: {
    message: "That assistant's settings file changed after Morrow wrote it.",
    recovery: "Morrow left that file exactly as it is. Open it, remove the morrow entry yourself, then select Check status.",
    fileRecovery: "Morrow left {file} exactly as it is. Open it, remove the morrow entry yourself, then select Check status."
  },
  assistant_config_invalid: {
    message: "That assistant's settings file has a mistake Morrow cannot read.",
    recovery: "Morrow changed nothing. Open the assistant's settings file, fix the mistake, then try again.",
    fileRecovery: "Morrow changed nothing. Open {file}, fix the mistake, then try again."
  },
  assistant_config_unreadable: {
    message: "Morrow cannot safely read that assistant's settings file.",
    recovery: "Morrow changed nothing. The settings file must be one ordinary file under 4 MB that your account owns.",
    fileRecovery: "Morrow changed nothing. {file} must be one ordinary file under 4 MB that your account owns. Fix that, then try again."
  },
  assistant_config_read_only: {
    message: "That assistant's settings file is read-only.",
    recovery: "Morrow changed nothing. Allow changes to the assistant's settings file, then try again.",
    fileRecovery: "Morrow changed nothing. Allow changes to {file}, then try again."
  },
  assistant_config_permission_denied: {
    message: "Morrow is not allowed to change that assistant's settings file.",
    recovery: "Morrow changed nothing. Make sure your account can change the settings file and its folder, then try again.",
    fileRecovery: "Morrow changed nothing. Make sure your account can change {file} and the folder it is in, then try again."
  },
  assistant_config_symlink: {
    message: "That assistant's settings file is a link to another place.",
    recovery: "Morrow changed nothing. Replace the link with the file itself, then try again.",
    fileRecovery: "Morrow changed nothing. Replace the link at {file} with the file itself, then try again."
  },
  assistant_config_busy: {
    message: "The assistant is using its settings file.",
    recovery: "Quit the assistant, then try again. Morrow changed nothing.",
    fileRecovery: "Quit the assistant, then try again. Morrow changed nothing in {file}."
  },
  assistant_not_connected: {
    message: "Morrow has not heard from your assistant yet.",
    recovery: "Quit the assistant completely, open it again, and start a new chat. Then select Check again."
  },
  assistant_connection_unconfirmed: {
    message: "Morrow could not check your assistant yet.",
    recovery: "Keep Morrow open until it is ready, then select Check again."
  },
  app_location_move_failed: {
    message: "Morrow could not move itself to Applications.",
    recovery: "Quit Morrow. In Finder, drag Morrow into your Applications folder, then open it from there."
  },
  app_location_unsupported: {
    message: "Morrow must run from your Applications folder.",
    recovery: "Select Move to Applications. Morrow moves itself there and opens again."
  },
  runtime_repair_required: {
    message: "Morrow needs repair.",
    recovery: "Reinstall Morrow, then reopen it."
  },
  installer_record_incompatible: {
    message: "This Morrow setup record belongs to another app version.",
    recovery: "Install the Morrow version that created this setup record. Morrow left the record unchanged."
  },
  active_or_uncertain_operations: {
    message: "Morrow has work in progress, or cannot confirm that it is idle.",
    recovery: "Wait for the current step to finish, then start that step again."
  },
  runtime_request_in_flight: {
    message: "Morrow is answering a request from your assistant right now.",
    recovery: "Wait for that request to finish, then start this step again."
  },
  runtime_change_running: {
    message: "Morrow is applying a change you approved.",
    recovery: "Wait for that change to finish, then start this step again."
  },
  runtime_other_client_connected: {
    message: "Another assistant is connected to Morrow.",
    recovery: "Close the other assistant, then start this step again. Morrow changed nothing."
  },
  bridge_delivery_unavailable: {
    message: "Morrow Bridge is not available from the Chrome Web Store yet.",
    recovery: "Use the temporary Chrome instructions in Morrow, then return here."
  },
  bridge_folder_unavailable: {
    message: "Morrow could not show the Morrow Bridge folder.",
    recovery: "Close Morrow and open it again, then select Show Bridge folder. If Morrow still cannot show it, reinstall Morrow."
  },
  bridge_check_failed: {
    message: "Morrow could not confirm Morrow Bridge.",
    recovery: "Select Repair Morrow, then load or reload the Bridge folder in Chrome and select Check Bridge."
  },
  blackboard_configuration_invalid: {
    message: "Morrow could not save the Blackboard connection.",
    recovery: "Check the Blackboard web address, the application key and secret from your administrator, and the account ID, then save again."
  },
  blackboard_course_selection_invalid: {
    message: "Morrow could not save that Blackboard course.",
    recovery: "Check the course ID in the course web address. It looks like _45_1. Your Blackboard connection was left as it was."
  },
  blackboard_removal_failed: {
    message: "Morrow could not remove that Blackboard connection.",
    recovery: "Check status to see the Blackboard connection Morrow has now, then remove it again."
  },
  clipboard_write_failed: {
    message: "Morrow could not copy that text.",
    recovery: "Select the text yourself and copy it, then try again."
  },
  external_open_failed: {
    message: "Morrow could not open that page.",
    recovery: "Open the address yourself from Where to get help, then try again."
  },
  setup_failed: {
    message: "Morrow could not finish this step.",
    recovery: "Check status, then try the step again. If it still fails, close Morrow and reopen it."
  },
  cancelled: {
    message: "No folder was selected.",
    recovery: "Choose a folder when you are ready."
  }
});

const ERROR_CODES = new Set(Object.keys(PUBLIC_ERRORS));

/**
 * An assistant's own settings file may be named in an error, because that file is the
 * person's to fix. Only an absolute path with no control characters is accepted.
 */
function publicFile(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 4096
    && /^(?:\/|[A-Za-z]:\\)/.test(value) && !/[\u0000-\u001f\u007f]/.test(value) ? value : null;
}

function errorDetails(code, file = null) {
  const entry = PUBLIC_ERRORS[code];
  const named = entry?.fileRecovery ? publicFile(file) : null;
  const details = { code, message: entry?.message, recovery: named ? entry.fileRecovery.replace("{file}", named) : entry?.recovery };
  return named ? { ...details, file: named } : details;
}

function assertAssistantId(value) {
  if (typeof value !== "string" || !ASSISTANT_IDS.has(value)) throw new TypeError("assistantId is invalid");
  return value;
}

function envelope(state, error = null) {
  if (error === null) return { schema: "morrow.installer-result.v1", ok: true, state };
  if (!ERROR_CODES.has(error.code)) throw new TypeError("installer error code is invalid");
  return {
    schema: "morrow.installer-result.v1",
    ok: false,
    state,
    error: errorDetails(error.code, error.file)
  };
}

function installerState(input) {
  const assistants = input.assistants.map((assistant) => ({
    id: assistant.id,
    title: assistant.title,
    tier: assistant.tier,
    detected: assistant.detected === true,
    configured: assistant.configured === true,
    pending: assistant.pending === true,
    // The assistant's own Morrow session reached the runtime at least once since
    // it was set up. Until then the assistant has not reloaded its settings.
    connected: assistant.connected === true,
    selected: assistant.selected === true,
    needsWorkspace: assistant.needsWorkspace === true,
    supported: assistant.supported === true,
  }));
  return {
    schema: "morrow.installer-state.v1",
    lifecycle: input.lifecycle,
    // "move_required" when this Mac copy of Morrow runs outside Applications and
    // must move before it writes its location into any assistant.
    appLocation: input.appLocation === "move_required" ? "move_required" : "ok",
    // An assistant still starts Morrow from where Morrow used to be; repair re-points it.
    assistantsNeedRepoint: input.assistantsNeedRepoint === true,
    assistants,
    selectedAssistantId: typeof input.selectedAssistantId === "string" ? input.selectedAssistantId : null,
    workspaceSelected: input.workspaceSelected === true,
    // The canonical materials folder this installation uses, named so setup can
    // show it and offer the change. `null` when Morrow has no usable folder.
    materialsFolder: typeof input.materialsFolder === "string" && input.materialsFolder.length > 0 && input.materialsFolder.length <= 4096
      ? input.materialsFolder
      : null,
    runtime: { status: input.runtimeStatus },
    bridge: {
      delivery: input.bridgeDelivery,
      // Three separate facts. folderReady: the app-owned unpacked Bridge folder
      // is initialized and verified. loadedInChrome: Chrome has that folder
      // loaded, proven by the Bridge answering this installation's active-folder
      // challenge or by the runtime reporting the Bridge connected; "unknown"
      // when Morrow has no such proof. paired: the Bridge is connected to the
      // Morrow runtime. Writing the folder proves only folderReady.
      folderReady: input.bridgeFolderReady === true,
      loadedInChrome: input.bridgeLoadedInChrome === true ? true : input.bridgeLoadedInChrome === false ? false : "unknown",
      updateAvailable: input.bridgeUpdateAvailable === true,
      manualChromeReloadRequired: input.bridgeManualChromeReloadRequired === true,
      paired: input.bridgePaired,
      courseSite: input.courseSite,
      runtimeVerifiedCourseCount: input.runtimeVerifiedCourseCount,
      // The one connected course, named only when exactly one is connected, and
      // the one course the first read targets, named whenever the runtime has
      // chosen it. Morrow reads exactly that course, however many are connected.
      selectedCourseName: input.selectedCourseName,
      firstPreviewCourseName: typeof input.firstPreviewCourseName === "string" ? input.firstPreviewCourseName : null
    },
    blackboard: blackboardSnapshot(input.blackboard),
    retention: retentionState(input.retention),
    updates: updateSnapshot(input.updates),
    firstPreview: {
      available: input.firstPreview?.available === true,
      completed: input.firstPreview?.completed === true
    }
  };
}

function blackboardSnapshot(value) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const statuses = new Set([
    "not_configured",
    "api_configured_live_untested",
    "configuration_repair_required",
    "credential_missing",
    "credential_mismatched",
    "private_access_refused"
  ]);
  const status = statuses.has(input.status) ? input.status : "not_configured";
  const tenantPattern = /^[a-z][a-z0-9-]{0,79}$/;
  const blackboardId = /^_[1-9][0-9]{0,18}_[1-9][0-9]{0,18}$/;
  const sourceBinding = /^[A-Za-z0-9_.:@-]{1,160}$/;
  const tenants = Array.isArray(input.tenants) ? input.tenants.slice(0, 100).flatMap((tenant) => {
    if (!tenant || typeof tenant !== "object" || Array.isArray(tenant)
      || typeof tenant.id !== "string" || !tenantPattern.test(tenant.id)
      || typeof tenant.baseUrl !== "string" || typeof tenant.principalId !== "string" || !blackboardId.test(tenant.principalId)
      || !Array.isArray(tenant.courseBindings)) return [];
    let baseUrl;
    try { baseUrl = new URL(tenant.baseUrl); } catch { return []; }
    if (baseUrl.protocol !== "https:" || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash || baseUrl.pathname !== "/") return [];
    const courseBindings = tenant.courseBindings.slice(0, 500).flatMap((binding) => {
      if (!binding || typeof binding !== "object" || Array.isArray(binding)
        || typeof binding.sourceBindingId !== "string" || !sourceBinding.test(binding.sourceBindingId)
        || typeof binding.courseId !== "string" || !blackboardId.test(binding.courseId)) return [];
      return [{ sourceBindingId: binding.sourceBindingId, courseId: binding.courseId }];
    });
    const availableCourses = Array.isArray(tenant.availableCourses) ? tenant.availableCourses.slice(0, 500).flatMap((course) => {
      if (!course || typeof course !== "object" || Array.isArray(course)
        || typeof course.courseId !== "string" || !blackboardId.test(course.courseId)
        || typeof course.title !== "string" || !course.title.trim() || course.title.trim().length > 500) return [];
      return [{ courseId: course.courseId, title: course.title.trim() }];
    }) : [];
    return [{
      id: tenant.id,
      baseUrl: baseUrl.origin,
      principalId: tenant.principalId,
      accountVerified: tenant.accountVerified === true,
      availableCourses,
      courseBindings
    }];
  }) : [];
  const publicTenants = status === "not_configured" || status === "configuration_repair_required" ? [] : tenants;
  return { schema: "morrow.blackboard.health.v1", status, tenants: publicTenants };
}

function retentionPath(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 4096;
}

function retentionPaths(value) {
  return Array.isArray(value) ? value.slice(0, 50).filter(retentionPath) : [];
}

/**
 * What one data removal did. `removed` and `remaining` are read back from disk
 * after the removal, so a path Morrow could not remove is carried here as
 * remaining and never as removed.
 */
function dataRemovalSnapshot(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !REMOVAL_STATUSES.has(value.status)) return null;
  return {
    schema: DATA_REMOVAL_SCHEMA,
    status: value.status,
    removed: retentionPaths(value.removed),
    remaining: retentionPaths(value.remaining),
    kept: retentionPaths(value.kept)
  };
}

/**
 * The retention policy this installation reports, with the exact places it
 * keeps data. The policy fields come from `uninstallPolicy()` itself, so the
 * state Morrow shows and the policy Morrow applies cannot drift apart.
 */
function retentionState(value) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const policy = uninstallPolicy();
  const locations = Array.isArray(input.locations) ? input.locations.slice(0, 50).flatMap((location) => {
    if (!location || typeof location !== "object" || Array.isArray(location)
      || !RETENTION_IDS.has(location.id)
      || typeof location.label !== "string" || location.label.length === 0 || location.label.length > 200
      || !retentionPath(location.path)) return [];
    return [{
      id: location.id,
      label: location.label,
      path: location.path,
      removable: location.removable === true,
      keptReason: KEPT_REASONS.has(location.keptReason) ? location.keptReason : null
    }];
  }) : [];
  return {
    schema: RETENTION_SCHEMA,
    appRemoval: policy.appRemoval,
    retained: [...policy.retained],
    explicitRemovalRequired: policy.explicitRemovalRequired,
    uninstall: UNINSTALL_STEPS.has(input.uninstall) ? input.uninstall : "unknown",
    locations,
    removal: dataRemovalSnapshot(input.removal)
  };
}

function updateSnapshot(value) {
  const input = value && typeof value === "object" ? value : {};
  const statuses = new Set(["unavailable", "idle", "checking", "available", "downloading", "ready", "installing", "error"]);
  return {
    schema: "morrow.desktop-update.v1",
    status: statuses.has(input.status) ? input.status : "unavailable",
    currentVersion: typeof input.currentVersion === "string" ? input.currentVersion : null,
    availableVersion: typeof input.availableVersion === "string" ? input.availableVersion : null,
    automatic: input.automatic === true,
    reason: typeof input.reason === "string" ? input.reason : null
  };
}

module.exports = { ASSISTANTS, assertAssistantId, envelope, errorDetails, installerState, blackboardSnapshot, retentionState, updateSnapshot };
