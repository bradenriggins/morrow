const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const MCP_RUNTIME_SCHEMA = "morrow.mcp-runtime-manifest.v1";
const MCP_RUNTIME_HEALTH_SCHEMA = "morrow.mcp-runtime.health.v1";
const SHA256 = /^[0-9a-f]{64}$/;
const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function sha256(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function exactKeys(value, keys) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && Object.keys(value).every((key) => keys.includes(key)));
}

function safePayloadRelative(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024 || value.includes("\\") || path.posix.isAbsolute(value)) return null;
  const normalized = path.posix.normalize(value);
  if (normalized !== value || normalized === "." || normalized === ".." || normalized.startsWith("../")) return null;
  return normalized;
}

function validFileRecord(value) {
  if (!exactKeys(value, ["path", "bytes", "sha256"])) return null;
  const relative = safePayloadRelative(value.path);
  if (!relative || !Number.isSafeInteger(value.bytes) || value.bytes < 0 || value.bytes > 512 * 1024 * 1024
    || typeof value.sha256 !== "string" || !SHA256.test(value.sha256)) return null;
  return { path: relative, bytes: value.bytes, sha256: value.sha256 };
}

async function sameFileRecord(root, record) {
  const target = path.resolve(root, record.path);
  const relative = path.relative(root, target);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false;
  try {
    const info = await fs.lstat(target);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== record.bytes) return false;
    return sha256(await fs.readFile(target)) === record.sha256;
  } catch {
    return false;
  }
}

function mcpRuntimeManifest(value) {
  if (!exactKeys(value, ["schema", "package", "entrypoint", "dependencies"])
    || value.schema !== MCP_RUNTIME_SCHEMA
    || !exactKeys(value.package, ["name", "version"])
    || value.package.name !== "@morrow-lms/gateway"
    || typeof value.package.version !== "string" || !VERSION.test(value.package.version)
    || !Array.isArray(value.dependencies) || value.dependencies.length === 0 || value.dependencies.length > 500) return null;
  const entrypoint = validFileRecord(value.entrypoint);
  if (!entrypoint || entrypoint.path !== "packages/mcp-server/dist/index.js") return null;
  const dependencies = [];
  const packageNames = new Set();
  for (const item of value.dependencies) {
    if (!exactKeys(item, ["name", "version", "packageJson", "files"])
      || typeof item.name !== "string" || item.name.length === 0 || item.name.length > 214
      || typeof item.version !== "string" || !VERSION.test(item.version)
      || !Array.isArray(item.files) || item.files.length === 0 || item.files.length > 100_000
      || packageNames.has(item.name)) return null;
    packageNames.add(item.name);
    const packageJson = validFileRecord(item.packageJson);
    if (!packageJson || packageJson.path !== `node_modules/${item.name}/package.json`) return null;
    const files = [];
    const filePaths = new Set();
    for (const file of item.files) {
      const record = validFileRecord(file);
      if (!record || !record.path.startsWith(`node_modules/${item.name}/`) || filePaths.has(record.path)) return null;
      filePaths.add(record.path);
      files.push(record);
    }
    if (!filePaths.has(packageJson.path)) return null;
    dependencies.push({ name: item.name, version: item.version, packageJson, files });
  }
  const gateway = dependencies.find((item) => item.name === value.package.name && item.version === value.package.version);
  if (!gateway) return null;
  return { packageVersion: value.package.version, entrypoint, dependencies, gateway };
}

/**
 * Validates the MCP portion of an installed payload against the digest embedded
 * in the signed application metadata. It returns only the bounded health
 * binding passed to the child gateway; callers never expose payload paths.
 */
async function verifyMcpRuntime(payloadRoot, expectedManifestSha256) {
  if (typeof expectedManifestSha256 !== "string" || !SHA256.test(expectedManifestSha256)) return null;
  const payload = path.resolve(payloadRoot);
  const appRoot = path.join(payload, "app");
  const manifestPath = path.join(appRoot, "mcp-runtime-manifest.json");
  const inputPath = path.join(appRoot, "package-input-manifest.json");
  let manifestBytes;
  let input;
  let manifest;
  try {
    manifestBytes = await fs.readFile(manifestPath);
    input = JSON.parse(await fs.readFile(inputPath, "utf8"));
    manifest = mcpRuntimeManifest(JSON.parse(manifestBytes.toString("utf8")));
  } catch {
    return null;
  }
  if (!manifest || sha256(manifestBytes) !== expectedManifestSha256
    || !input || typeof input !== "object" || Array.isArray(input)
    || input.schema !== "morrow.desktop-package-input.v1"
    || !exactKeys(input.mcpRuntime, ["path", "sha256"])
    || input.mcpRuntime.path !== "app/mcp-runtime-manifest.json"
    || input.mcpRuntime.sha256 !== expectedManifestSha256) return null;

  const root = path.join(payload, "app");
  if (!await sameFileRecord(root, manifest.entrypoint)) return null;
  for (const dependency of manifest.dependencies) {
    for (const record of dependency.files) if (!await sameFileRecord(root, record)) return null;
  }
  // The gateway runs from app/packages while its runtime dependencies resolve
  // from app/node_modules. Verify every sibling it can import by mapping the
  // sealed gateway package records back to that direct entrypoint tree.
  for (const record of manifest.gateway.files) {
    const prefix = `node_modules/${manifest.gateway.name}/`;
    const suffix = record.path.slice(prefix.length);
    const direct = { ...record, path: `packages/mcp-server/${suffix}` };
    if (!await sameFileRecord(root, direct)) return null;
  }
  return Object.freeze({
    schema: MCP_RUNTIME_HEALTH_SCHEMA,
    packageVersion: manifest.packageVersion,
    manifestSha256: expectedManifestSha256
  });
}

function payloadLayout(payloadRoot, userData) {
  const payload = path.resolve(payloadRoot);
  const root = path.resolve(userData);
  return Object.freeze({
    payload,
    userData: root,
    state: path.join(root, "State"),
    defaultMaterials: path.join(root, "Materials"),
    appRoot: path.join(payload, "app"),
    node: process.platform === "win32"
      ? path.join(payload, "runtime", "node", "node.exe")
      : path.join(payload, "runtime", "node", "bin", "node"),
    cli: path.join(payload, "app", "packages", "client-config", "dist", "cli.js"),
    server: path.join(payload, "app", "packages", "mcp-server", "dist", "index.js"),
    connector: path.join(payload, "app", "packages", "canvas-connector-mcp", "dist", "index.js"),
    monitorScript: path.join(payload, "app", "installer", "runtime-monitor.mjs"),
    mcpRuntimeManifest: path.join(payload, "app", "mcp-runtime-manifest.json"),
    packageInputManifest: path.join(payload, "app", "package-input-manifest.json"),
    bridgeReleaseDirectory: path.join(payload, "app", "bridge-release", "extension"),
    bridgeReleaseManifest: path.join(payload, "app", "bridge-release", "manifest.json"),
    upstreams: path.join(root, "State", "morrow.upstreams.json"),
    extension: path.join(payload, "app", "connector", "extension"),
    bridgeDirectory: path.join(root, "Bridge")
  });
}

async function exists(file) {
  try { await fs.access(file); return true; } catch { return false; }
}

async function isComplete(payloadRoot) {
  const root = path.resolve(payloadRoot);
  const node = process.platform === "win32"
    ? path.join(root, "runtime", "node", "node.exe")
    : path.join(root, "runtime", "node", "bin", "node");
  return (await Promise.all([
    node,
    path.join(root, "app", "packages", "client-config", "dist", "cli.js"),
    path.join(root, "app", "packages", "mcp-server", "dist", "index.js"),
    path.join(root, "app", "packages", "mcp-server", "dist", "local-owner-maintenance.js"),
    path.join(root, "app", "packages", "mcp-server", "dist", "local-owner-sidecar-access.js"),
    path.join(root, "app", "packages", "canvas-connector-mcp", "dist", "index.js"),
    path.join(root, "app", "installer", "runtime-monitor.mjs"),
    path.join(root, "app", "mcp-runtime-manifest.json"),
    path.join(root, "app", "package-input-manifest.json"),
    path.join(root, "app", "bridge-release", "manifest.json"),
    path.join(root, "app", "bridge-release", "extension", "manifest.json"),
    path.join(root, "app", "connector", "extension", "manifest.json")
  ].map(exists))).every(Boolean);
}

function runtimeStatus(payloadComplete, runtime) {
  if (payloadComplete !== true) return "repair_required";
  return runtime?.health?.gatewayReady === true ? "ready" : "uncertain";
}

async function mkdirPrivate(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await fs.chmod(directory, 0o700);
}

async function canonicalDirectory(value) {
  if (typeof value !== "string" || !path.isAbsolute(value)) throw new TypeError("workspace path must be absolute");
  const resolved = await fs.realpath(value);
  const info = await fs.stat(resolved);
  if (!info.isDirectory()) throw new TypeError("workspace path must be a directory");
  return resolved;
}

async function captureConfiguration(file, backupRoot) {
  const id = crypto.randomUUID();
  const backup = path.join(backupRoot, id);
  const present = await exists(file);
  if (!present) return { file, backup: null, present: false };
  await mkdirPrivate(backupRoot);
  await fs.copyFile(file, backup, fs.constants.COPYFILE_EXCL);
  if (process.platform !== "win32") await fs.chmod(backup, 0o600);
  return { file, backup, present: true };
}

async function restoreConfiguration(snapshot, expectedCurrentSha256) {
  if (typeof expectedCurrentSha256 !== "string" || !/^[0-9a-f]{64}$/.test(expectedCurrentSha256)) return false;
  if (!await exists(snapshot.file)) return false;
  const current = crypto.createHash("sha256").update(await fs.readFile(snapshot.file)).digest("hex");
  if (current !== expectedCurrentSha256) return false;
  await fs.rm(snapshot.file, { force: true });
  if (snapshot.present && snapshot.backup) {
    await mkdirPrivate(path.dirname(snapshot.file));
    await fs.copyFile(snapshot.backup, snapshot.file, fs.constants.COPYFILE_EXCL);
    if (process.platform !== "win32") await fs.chmod(snapshot.file, 0o600);
  }
  return true;
}

module.exports = { payloadLayout, exists, isComplete, runtimeStatus, mkdirPrivate, canonicalDirectory, captureConfiguration, restoreConfiguration, verifyMcpRuntime };
