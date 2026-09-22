const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { parseStrictJson } = require("./strict-utf8.cjs");

const MCP_RUNTIME_SCHEMA = "morrow.mcp-runtime-manifest.v2";
const MCP_RUNTIME_HEALTH_SCHEMA = "morrow.mcp-runtime.health.v1";
const SHA256 = /^[0-9a-f]{64}$/;
const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const REQUIRED_DIRECT_RUNTIME_FILES = Object.freeze([
  "packages/client-config/dist/cli.js",
  "packages/mcp-server/dist/index.js",
  "packages/canvas-connector-mcp/dist/index.js",
  "installer/runtime-monitor.mjs",
  "installer/process-lifetime.cjs",
]);

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

function directRuntimePath(value) {
  const relative = safePayloadRelative(value);
  if (!relative || (!relative.startsWith("packages/") && !relative.startsWith("installer/"))) return null;
  return relative;
}

async function directRuntimeFileSet(root) {
  const files = [];
  const visit = async (directory, prefix) => {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries) {
      const relative = `${prefix}/${entry.name}`;
      const target = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) return false;
      if (entry.isDirectory()) {
        if (!await visit(target, relative)) return false;
      } else if (entry.isFile()) {
        files.push(relative.replaceAll(path.sep, "/"));
        if (files.length > 100_000) return false;
      } else {
        return false;
      }
    }
    return true;
  };
  const packages = path.join(root, "packages");
  const installer = path.join(root, "installer");
  try {
    const [packagesInfo, installerInfo] = await Promise.all([fs.lstat(packages), fs.lstat(installer)]);
    if (!packagesInfo.isDirectory() || packagesInfo.isSymbolicLink()
      || !installerInfo.isDirectory() || installerInfo.isSymbolicLink()) return null;
  } catch {
    return null;
  }
  if (!await visit(packages, "packages")) return null;
  if (!await visit(installer, "installer")) return null;
  return files.sort();
}

async function sameFileRecord(root, record) {
  const target = path.resolve(root, record.path);
  const relative = path.relative(root, target);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false;
  try {
    const [canonicalRoot, canonicalTarget] = await Promise.all([fs.realpath(root), fs.realpath(target)]);
    if (canonicalTarget !== path.resolve(canonicalRoot, record.path)) return false;
    const info = await fs.lstat(target);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== record.bytes) return false;
    return sha256(await fs.readFile(target)) === record.sha256;
  } catch {
    return false;
  }
}

function mcpRuntimeManifest(value) {
  if (!exactKeys(value, ["schema", "package", "entrypoint", "dependencies", "directFiles"])
    || value.schema !== MCP_RUNTIME_SCHEMA
    || !exactKeys(value.package, ["name", "version"])
    || value.package.name !== "@morrow-lms/gateway"
    || typeof value.package.version !== "string" || !VERSION.test(value.package.version)
    || !Array.isArray(value.directFiles) || value.directFiles.length === 0 || value.directFiles.length > 100_000
    || !Array.isArray(value.dependencies) || value.dependencies.length === 0 || value.dependencies.length > 500) return null;
  const entrypoint = validFileRecord(value.entrypoint);
  if (!entrypoint || entrypoint.path !== "packages/mcp-server/dist/index.js") return null;
  const directFiles = [];
  const directPaths = new Set();
  for (const file of value.directFiles) {
    const record = validFileRecord(file);
    if (!record || !directRuntimePath(record.path) || directPaths.has(record.path)) return null;
    directPaths.add(record.path);
    directFiles.push(record);
  }
  if (!REQUIRED_DIRECT_RUNTIME_FILES.every((required) => directPaths.has(required))) return null;
  const directEntrypoint = directFiles.find((record) => record.path === entrypoint.path);
  if (!directEntrypoint || directEntrypoint.bytes !== entrypoint.bytes || directEntrypoint.sha256 !== entrypoint.sha256) return null;
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
  return { packageVersion: value.package.version, entrypoint, dependencies, gateway, directFiles };
}

/**
 * Validates the MCP portion of an installed payload against the digest embedded
 * in the signed application metadata. It returns only the bounded health
 * binding passed to the child gateway; callers never expose payload paths.
 */
async function verifyMcpRuntime(payloadRoot, expectedManifestSha256, expectedNodeSha256 = null) {
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
    input = parseStrictJson(await fs.readFile(inputPath), "MCP package input manifest");
    manifest = mcpRuntimeManifest(parseStrictJson(manifestBytes, "MCP runtime manifest"));
  } catch {
    return null;
  }
  if (!manifest || sha256(manifestBytes) !== expectedManifestSha256
    || !input || typeof input !== "object" || Array.isArray(input)
    || input.schema !== "morrow.desktop-package-input.v2"
    || !exactKeys(input.mcpRuntime, ["path", "sha256"])
    || input.mcpRuntime.path !== "app/mcp-runtime-manifest.json"
    || input.mcpRuntime.sha256 !== expectedManifestSha256) return null;

  if (expectedNodeSha256 !== null) {
    if (typeof expectedNodeSha256 !== "string" || !SHA256.test(expectedNodeSha256)) return null;
    const nodePath = process.platform === "win32"
      ? path.join(payload, "runtime", "node", "node.exe")
      : path.join(payload, "runtime", "node", "bin", "node");
    try {
      const info = await fs.lstat(nodePath);
      if (!info.isFile() || info.isSymbolicLink()
        || sha256(await fs.readFile(nodePath)) !== expectedNodeSha256) return null;
    } catch {
      return null;
    }
  }
  const root = path.join(payload, "app");
  if (!await sameFileRecord(root, manifest.entrypoint)) return null;
  for (const dependency of manifest.dependencies) {
    for (const record of dependency.files) if (!await sameFileRecord(root, record)) return null;
  }
  for (const record of manifest.directFiles) if (!await sameFileRecord(root, record)) return null;
  const actualDirectFiles = await directRuntimeFileSet(root);
  const expectedDirectFiles = manifest.directFiles.map((record) => record.path).sort();
  if (!actualDirectFiles || actualDirectFiles.length !== manifest.directFiles.length
    || actualDirectFiles.some((file, index) => file !== expectedDirectFiles[index])) return null;
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
    path.join(root, "app", "installer", "process-lifetime.cjs"),
    path.join(root, "app", "mcp-runtime-manifest.json"),
    path.join(root, "app", "package-input-manifest.json"),
    path.join(root, "app", "bridge-release", "manifest.json"),
    path.join(root, "app", "bridge-release", "extension", "manifest.json"),
    path.join(root, "app", "connector", "extension", "manifest.json")
  ].map(exists))).every(Boolean);
}

function runtimeStatus(payloadComplete, runtime) {
  if (payloadComplete !== true) return "repair_required";
  if (runtime?.health?.runtimeMismatch === true) return "repair_required";
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
    await fs.copyFile(snapshot.backup, snapshot.file, fs.constants.COPYFILE_EXCL);
    if (process.platform !== "win32") await fs.chmod(snapshot.file, 0o600);
  }
  return true;
}

module.exports = { payloadLayout, exists, isComplete, runtimeStatus, mkdirPrivate, canonicalDirectory, captureConfiguration, restoreConfiguration, verifyMcpRuntime };
