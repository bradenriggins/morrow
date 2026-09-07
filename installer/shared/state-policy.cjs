const path = require("node:path");

const STATE_SCHEMA = "morrow.desktop-state.v1";
const STATE_VERSION = 1;
const RETENTION_SCHEMA = "morrow.installer-retention.v1";
const DATA_REMOVAL_SCHEMA = "morrow.installer-data-removal.v1";
const UNINSTALL_STEPS = new Set(["move_to_trash", "windows_settings_apps", "unknown"]);
const KEPT_REASONS = new Set(["assistant_configuration", "outside_morrow_data"]);
const REMOVAL_STATUSES = new Set(["cancelled", "removed", "incomplete"]);

function freshRecord() {
  return { schema: STATE_SCHEMA, version: STATE_VERSION, configured: {} };
}

function inspectRecord(value) {
  if (value === null || value === undefined) return { compatible: true, record: freshRecord() };
  if (!value || typeof value !== "object" || Array.isArray(value)) return { compatible: false, reason: "record_invalid", record: null };
  if (value.schema !== STATE_SCHEMA || value.version !== STATE_VERSION) {
    return { compatible: false, reason: "migration_required", record: null };
  }
  if (value.configured !== undefined && (!value.configured || typeof value.configured !== "object" || Array.isArray(value.configured))) {
    return { compatible: false, reason: "record_invalid", record: null };
  }
  return { compatible: true, record: { ...freshRecord(), ...value, configured: value.configured || {} } };
}

function uninstallPolicy() {
  return Object.freeze({
    appRemoval: "removes_application_only",
    retained: ["state", "materials", "assistant_configuration", "backups", "blackboard_credentials"],
    explicitRemovalRequired: true
  });
}

/** The step this operating system uses to remove an installed application. */
function uninstallStep(platform) {
  if (platform === "darwin") return "move_to_trash";
  if (platform === "win32") return "windows_settings_apps";
  return "unknown";
}

/**
 * Whether `candidate` is `parent` itself or a path under it. Both are compared
 * as resolved paths, so a sibling whose name starts with the parent's name is
 * outside it. Symbolic links are not followed: a path that reaches the same
 * folder through a link counts as outside, which keeps a removal inside the
 * folders Morrow named.
 */
function insideDirectory(parent, candidate) {
  if (typeof parent !== "string" || typeof candidate !== "string" || !path.isAbsolute(parent) || !path.isAbsolute(candidate)) return false;
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

/**
 * Every place this installation keeps data, named by its exact path. Removing
 * the Morrow application removes the application only, so this list is what
 * stays behind until a person removes it.
 *
 * `removable` marks the places the in-app data removal may remove: a place
 * inside Morrow's own user-data folder or inside the Blackboard credential
 * folder. Every other place is listed with the reason Morrow leaves it alone,
 * so the list never implies a removal Morrow does not perform. An assistant's
 * own configuration file is never removable here: that file belongs to the
 * assistant and needs its own separate, separately confirmed step.
 */
function retentionSnapshot(input = {}) {
  const policy = uninstallPolicy();
  const boundaries = [input.userData, input.blackboardCredentials];
  const locations = [];
  const add = (id, label, candidate, keptReason) => {
    if (typeof candidate !== "string" || !path.isAbsolute(candidate)) return;
    const inside = boundaries.some((boundary) => insideDirectory(boundary, candidate));
    locations.push({
      id,
      label,
      path: candidate,
      removable: keptReason === undefined && inside,
      keptReason: keptReason !== undefined ? keptReason : inside ? null : "outside_morrow_data"
    });
  };
  add("state", "Morrow's setup record and local journal", input.state);
  add("backups", "Copies of assistant settings Morrow changed", input.backups);
  add("bridge", "The Morrow Bridge folder Chrome loads", input.bridge);
  add("materials", "Your Morrow materials folder", input.materials);
  add("blackboard_credentials", "Your Blackboard application secret", input.blackboardCredentials);
  add("blackboard_configuration", "Your Blackboard site, key, and course list", input.blackboardConfiguration);
  for (const assistant of Array.isArray(input.assistantConfigurations) ? input.assistantConfigurations : []) {
    add("assistant_configuration", `${assistant?.title} settings file`, assistant?.path, "assistant_configuration");
  }
  return {
    schema: RETENTION_SCHEMA,
    appRemoval: policy.appRemoval,
    retained: [...policy.retained],
    explicitRemovalRequired: policy.explicitRemovalRequired,
    uninstall: uninstallStep(input.platform),
    locations,
    removal: input.removal ?? null
  };
}

module.exports = {
  STATE_SCHEMA,
  STATE_VERSION,
  RETENTION_SCHEMA,
  DATA_REMOVAL_SCHEMA,
  UNINSTALL_STEPS,
  KEPT_REASONS,
  REMOVAL_STATUSES,
  freshRecord,
  insideDirectory,
  inspectRecord,
  retentionSnapshot,
  uninstallPolicy,
  uninstallStep
};
