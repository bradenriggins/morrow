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
const ERROR_CODES = new Set([
  "assistant_not_found",
  "workspace_required",
  "existing_morrow_configuration",
  "assistant_configuration_changed",
  "runtime_repair_required",
  "active_or_uncertain_operations",
  "bridge_delivery_unavailable",
  "bridge_folder_unavailable",
  "blackboard_configuration_invalid",
  "blackboard_course_selection_invalid",
  "blackboard_removal_failed",
  "setup_failed",
  "cancelled"
]);

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
    error: { code: error.code, message: error.message, recovery: error.recovery }
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
    selected: assistant.selected === true,
    needsWorkspace: assistant.needsWorkspace === true,
    supported: assistant.supported === true,
  }));
  return {
    schema: "morrow.installer-state.v1",
    lifecycle: input.lifecycle,
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
  const status = input.status === "api_configured_live_untested" ? "api_configured_live_untested" : "not_configured";
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
  return { schema: "morrow.blackboard.health.v1", status, tenants };
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

module.exports = { ASSISTANTS, assertAssistantId, envelope, installerState, blackboardSnapshot, retentionState, updateSnapshot };
