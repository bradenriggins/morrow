const fs = require("node:fs/promises");
const fsConstants = require("node:fs").constants;
const path = require("node:path");

const STATE_SCHEMA = "morrow.desktop-state.v1";
const STATE_VERSION = 1;
const RETENTION_SCHEMA = "morrow.installer-retention.v1";
const DATA_REMOVAL_SCHEMA = "morrow.installer-data-removal.v1";
const UNINSTALL_STEPS = new Set(["move_to_trash", "windows_settings_apps", "unknown"]);
const KEPT_REASONS = new Set(["assistant_configuration", "assistant_backup", "outside_morrow_data", "claude_desktop_extension"]);
const REMOVAL_STATUSES = new Set(["cancelled", "removed", "incomplete"]);
const CONFIGURED_ASSISTANT_IDS = new Set(["codex", "claude-desktop", "claude-code", "gemini-cli"]);
const RECORD_KEYS = new Set(["schema", "version", "selectedAssistantId", "materialsFolder", "configured"]);
const SHA256 = /^[0-9a-f]{64}$/;
const INSTALLATION_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,159}$/;

function exactObject(value, keys) {
  return Boolean(plainObject(value)
    && Object.keys(value).length === keys.length
    && Object.keys(value).every((key) => keys.includes(key)));
}

function plainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalAbsolutePath(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 4096
    && !value.includes("\0") && path.isAbsolute(value) && path.normalize(value) === value;
}

function configuredTarget(assistantId, target, options) {
  if (!canonicalAbsolutePath(target)) return false;
  if (assistantId === "codex") {
    return !canonicalAbsolutePath(options.homeDirectory)
      || target === path.join(options.homeDirectory, ".codex", "config.toml");
  }
  if (assistantId === "claude-code") return path.basename(target) === ".mcp.json";
  if (assistantId === "gemini-cli") {
    return path.basename(target) === "settings.json" && path.basename(path.dirname(target)) === ".gemini";
  }
  return false;
}

function configuredEntry(assistantId, value, options) {
  if (assistantId === "claude-desktop") {
    if (!exactObject(value, ["bundlePath", "installationId", "receiptPath"])
      || !canonicalAbsolutePath(value.bundlePath)
      || !canonicalAbsolutePath(value.receiptPath)
      || path.dirname(value.bundlePath) !== path.dirname(value.receiptPath)
      || path.basename(value.bundlePath) !== "Morrow.mcpb"
      || path.basename(value.receiptPath) !== "connection.json"
      || typeof value.installationId !== "string" || !INSTALLATION_ID.test(value.installationId)) return null;
    return {
      bundlePath: value.bundlePath,
      installationId: value.installationId,
      receiptPath: value.receiptPath,
    };
  }
  if (!exactObject(value, ["target", "sha256"])
    || !configuredTarget(assistantId, value.target, options)
    || typeof value.sha256 !== "string" || !SHA256.test(value.sha256)) return null;
  return { target: value.target, sha256: value.sha256 };
}

function invalidRecord(reason = "record_invalid") {
  return { compatible: false, reason, record: null };
}

function freshRecord() {
  return { schema: STATE_SCHEMA, version: STATE_VERSION, configured: {} };
}

function inspectRecord(value, options = {}) {
  if (value === null || value === undefined) return { compatible: true, record: freshRecord() };
  if (!plainObject(value)) return invalidRecord();
  if (value.schema !== STATE_SCHEMA || value.version !== STATE_VERSION) {
    return invalidRecord("migration_required");
  }
  if (Object.keys(value).some((key) => !RECORD_KEYS.has(key))) return invalidRecord();
  const hasSelectedAssistantId = Object.hasOwn(value, "selectedAssistantId");
  const hasMaterialsFolder = Object.hasOwn(value, "materialsFolder");
  const hasConfigured = Object.hasOwn(value, "configured");
  if (hasSelectedAssistantId && value.selectedAssistantId !== null
    && !CONFIGURED_ASSISTANT_IDS.has(value.selectedAssistantId)) return invalidRecord();
  if (hasMaterialsFolder && !canonicalAbsolutePath(value.materialsFolder)) return invalidRecord();
  if (hasConfigured && !plainObject(value.configured)) {
    return invalidRecord();
  }
  const configured = {};
  for (const [assistantId, entry] of Object.entries(hasConfigured ? value.configured : {})) {
    if (!CONFIGURED_ASSISTANT_IDS.has(assistantId)) return invalidRecord();
    const inspected = configuredEntry(assistantId, entry, options);
    if (!inspected) return invalidRecord();
    configured[assistantId] = inspected;
  }
  return {
    compatible: true,
    record: {
      ...freshRecord(),
      ...(hasSelectedAssistantId ? { selectedAssistantId: value.selectedAssistantId } : {}),
      ...(hasMaterialsFolder ? { materialsFolder: value.materialsFolder } : {}),
      configured,
    },
  };
}

function privateFileError(reason) {
  const error = new Error(reason);
  error.code = "MORROW_PRIVATE_FILE_REFUSED";
  return error;
}

function acceptedPrivateFile(info, platform, ownerUid, maxBytes) {
  return info.isFile() && !info.isSymbolicLink() && info.nlink === 1
    && info.size >= 0 && info.size <= maxBytes
    && (platform === "win32" || ((info.mode & 0o077) === 0
      && (ownerUid === null || info.uid === ownerUid)));
}

function sameStablePrivateFile(left, right) {
  // ctime is intentionally excluded. Some kernels refine its precision after
  // a fresh write even though the inode, content, ownership, and mode did not change.
  return left.dev === right.dev && left.ino === right.ino
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.mode === right.mode
    && left.uid === right.uid
    && left.gid === right.gid;
}

async function trustedPrivateAncestorChain(file, trustedRoot, platform, ownerUid) {
  if (trustedRoot === undefined) return true;
  if (!canonicalAbsolutePath(trustedRoot)) return false;
  const relative = path.relative(trustedRoot, file);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false;
  const parts = relative.split(path.sep).filter(Boolean);
  let current = trustedRoot;
  for (const part of parts.slice(0, -1)) {
    const info = await fs.lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()
      || (platform !== "win32" && ((info.mode & 0o077) !== 0
        || (ownerUid !== null && info.uid !== ownerUid)))) return false;
    current = path.join(current, part);
  }
  const parent = await fs.lstat(current);
  return parent.isDirectory() && !parent.isSymbolicLink()
    && (platform === "win32" || ((parent.mode & 0o077) === 0
      && (ownerUid === null || parent.uid === ownerUid)));
}

/**
 * Reads one owner-private regular file through its already-open descriptor.
 * The descriptor, file identity, metadata, and retained bytes all stay inside
 * the same bound, so a path replacement cannot turn this read into a symlink,
 * device, pipe, or larger file.
 */
async function readPrivateRegularFile(file, options = {}) {
  const maxBytes = options.maxBytes;
  const platform = options.platform || process.platform;
  const ownerUid = platform === "win32" || typeof process.getuid !== "function" ? null : process.getuid();
  if (typeof file !== "string" || !path.isAbsolute(file)
    || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 16 * 1024 * 1024) {
    throw new TypeError("private file read is invalid");
  }
  if (!await trustedPrivateAncestorChain(file, options.trustedRoot, platform, ownerUid)) {
    throw privateFileError("private_file_ancestor_not_admitted");
  }
  const before = await fs.lstat(file);
  if (!acceptedPrivateFile(before, platform, ownerUid, maxBytes)) throw privateFileError("private_file_not_admitted");
  const flags = fsConstants.O_RDONLY
    | (typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0)
    | (typeof fsConstants.O_NONBLOCK === "number" ? fsConstants.O_NONBLOCK : 0);
  let handle;
  try {
    handle = await fs.open(file, flags);
    const opened = await handle.stat();
    const openedPath = await fs.lstat(file);
    if (!acceptedPrivateFile(opened, platform, ownerUid, maxBytes)
      || !acceptedPrivateFile(openedPath, platform, ownerUid, maxBytes)
      || !sameStablePrivateFile(before, opened)
      || !sameStablePrivateFile(opened, openedPath)) {
      throw privateFileError("private_file_changed_during_admission");
    }
    const output = Buffer.alloc(maxBytes + 1);
    let offset = 0;
    while (offset <= maxBytes) {
      const { bytesRead } = await handle.read(output, offset, output.length - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const after = await handle.stat();
    const afterPath = await fs.lstat(file);
    if (offset > maxBytes || offset !== opened.size
      || !acceptedPrivateFile(after, platform, ownerUid, maxBytes)
      || !acceptedPrivateFile(afterPath, platform, ownerUid, maxBytes)
      || !sameStablePrivateFile(opened, after)
      || !sameStablePrivateFile(after, afterPath)) {
      throw privateFileError("private_file_changed_during_read");
    }
    return output.subarray(0, offset);
  } finally {
    await handle?.close().catch(() => {});
  }
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
   * inside Morrow's own user-data folder, the Blackboard credential folder, or
   * the exact Blackboard configuration file. Every other place is listed with the reason Morrow leaves it alone,
 * so the list never implies a removal Morrow does not perform. An assistant's
 * own configuration file is never removable here: that file belongs to the
 * assistant and needs its own separate, separately confirmed step.
 */
function retentionSnapshot(input = {}) {
  const policy = uninstallPolicy();
  const boundaries = [input.userData, input.blackboardCredentials, input.blackboardConfiguration];
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
  add("backups", "Copies of assistant settings Morrow changed", input.backups, "assistant_backup");
  add("bridge", "The Morrow Bridge folder Chrome loads", input.bridge);
  add("materials", "Your Morrow materials folder", input.materials);
  add("previous_materials", "Morrow's earlier Materials folder", input.previousMaterials);
  add("blackboard_credentials", "Your Blackboard application secret", input.blackboardCredentials);
  add("blackboard_configuration", "Your Blackboard site, key, and course list", input.blackboardConfiguration);
  for (const assistant of Array.isArray(input.assistantConfigurations) ? input.assistantConfigurations : []) {
    add("assistant_configuration", `${assistant?.title} settings file`, assistant?.path, "assistant_configuration");
  }
  // Claude Desktop keeps its own copy of the Morrow extension and starts it on
  // every launch. It belongs to Claude Desktop, so only Claude Desktop removes it.
  add("claude_desktop_extension", "The Morrow extension in Claude Desktop", input.claudeDesktopExtension, "claude_desktop_extension");
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
  CONFIGURED_ASSISTANT_IDS,
  freshRecord,
  insideDirectory,
  inspectRecord,
  readPrivateRegularFile,
  retentionSnapshot,
  uninstallPolicy,
  uninstallStep
};
